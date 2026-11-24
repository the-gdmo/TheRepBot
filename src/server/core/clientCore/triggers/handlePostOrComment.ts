import {
    Comment,
    context,
    reddit,
    redis,
    scheduler,
    settings,
    User,
} from "@devvit/web/server";
import {
    OnCommentCreateRequest,
    OnCommentUpdateRequest,
    OnPostSubmitRequest,
    T3,
} from "@devvit/web/shared";
import {
    findCommandInBody,
    formatMessageOnComment,
    formatMessageOnPost,
    getIgnoredContextType,
    getNotifyMode,
    getSelectSetting,
    getTriggers,
    modCommandValue,
    notifyUser,
    ScoreResult,
    userCommandValues,
} from "../../utils/common-utilities";
import { logger } from "../../utils/logger";
import {
    getCurrentScore,
    getUserCanAward,
    getUserIsSuperuser,
    handleAutoSuperuserPromotion,
    isBotWrittenFlair,
    isModerator,
} from "../../utils/user-utilities";
import {
    CommentTriggerContext,
    deleteRestrictedKey,
    flairToggleKeyExists,
    isFlairManagementDisabled,
    getAwardsRequiredKey,
    getLastValidPostKey,
    getLastValidPostTitleKey,
    getModDupKey,
    getParentComment,
    getRestrictedKey,
    POINTS_STORE_KEY,
    restrictedKeyExists,
    setModDupKey,
} from "../../utils/redisKeys";
import {
    recordDigestPointAward,
    recordDigestPost,
} from "../../utils/digest-stats";
import { UPDATE_LEADERBOARD_JOB } from "../constants";
import {
    getUserWikiLifetimeTotalsForUser,
    updateUserWiki,
} from "../leaderboard";
import { setCleanupForUsers } from "../../utils/cleanupTasks";
import { handleLegendPromotion } from "./legend";

export function isSystemAccount(username: string): boolean {
    const name = username.toLowerCase();
    return (
        name === "automoderator" ||
        name === `${context.subredditName}-modteam`.toLowerCase() ||
        name === context.appSlug.toLowerCase()
    );
}

export function formatCommandList(
    commands: string[],
    joiner: "and" | "or"
): string {
    const bold = commands.map((command) => `**${command}**`);
    if (bold.length <= 2) return bold.join(` ${joiner} `);
    return `${bold.slice(0, -1).join(", ")}, ${joiner} ${bold.at(-1)}`;
}

export async function handleClientPostCreate(event: OnPostSubmitRequest) {
    if (!event.post || !event.author?.name || !event.subreddit) {
        console.error(
            "Content Create: PostCreate event missing post or author information",
            JSON.stringify(event)
        );
        return;
    }

    console.log(
        `Content Create: PostCreate ${event.post.id} by ${event.author.name}`
    );

    // Count every post, including mod/exempt and later-removed posts.
    try {
        await recordDigestPost();
    } catch (error) {
        logger.error("Could not record post-creation digest statistic", {
            postId: event.post.id,
            error,
        });
    }

    if (isSystemAccount(event.author.name)) return;

    const awardsRequired =
        (await settings.get<number>("awardsRequiredToCreateNewPosts")) ?? 0;
    const pointName = (await settings.get<string>("pointName")) ?? "point";
    const commands = await userCommandValues();
    const commandsWithAnd = formatCommandList(commands, "and");
    const commandsWithOr = formatCommandList(commands, "or");
    const markdownGuide = "https://www.reddit.com/wiki/markdown";
    const postId = event.post.id as T3;

    if (awardsRequired === 0) {
        const unrestrictedPostingMessage = formatMessageOnPost(
            event,
            (await settings.get<string>("UnrestrictedPostingMessage")) ?? "",
            { name: pointName, commandsWithAnd, commandsWithOr, markdownGuide }
        );

        const unrestrictedPostingComment = await reddit.submitComment({
            id: postId,
            text: unrestrictedPostingMessage,
        });

        await unrestrictedPostingComment.distinguish(true);

        logger.info(`Awarding not required, sending comment and returning.`);
        return;
    }

    const subredditName = event.subreddit.name;
    const authorName = event.author.name;

    let author: User | undefined;

    try {
        author = await reddit.getUserByUsername(authorName);
    } catch {
        author = undefined;
    }

    if (!author) {
        logger.warn("❌ Could not fetch author object", { authorName });
        return;
    }

    const modsExempt =
        (await settings.get<boolean>("moderatorsExempt")) ?? true;

    if (modsExempt && (await isModerator(subredditName, authorName))) {
        logger.info(
            `✅ ${author.username} is a moderator and is exempt from restrictions`
        );
        return;
    }

    const helpPage = (await settings.get<string>("pointSystemHelpPage")) ?? "";
    const discordLink = (await settings.get<string>("discordServerLink")) ?? "";
    const requirement = awardsRequired.toString();

    const restrictedUserKey = await getRestrictedKey(author);
    const awardsRequiredKey = await getAwardsRequiredKey(author);
    const lastValidPostKey = await getLastValidPostKey(author);
    const lastValidPostTitleKey = await getLastValidPostTitleKey(author);

    // A restricted user's new post is removed until they've awarded enough.
    if (await restrictedKeyExists(author.username)) {
        const subsequentRestrictionMessage = formatMessageOnPost(
            event,
            (await settings.get<string>("subsequentPostRestrictionMessage")) ??
                "",
            {
                discord: discordLink,
                helpPage,
                title: (await redis.get(lastValidPostTitleKey)) ?? "",
                permalink: (await redis.get(lastValidPostKey)) ?? "",
                requirement,
                subreddit: subredditName,
                name: pointName,
                commandsWithOr,
                commandsWithAnd,
            }
        );

        const restrictionComment = await reddit.submitComment({
            id: postId,
            text: subsequentRestrictionMessage,
        });

        await restrictionComment.distinguish(true);
        await reddit.remove(postId, false);

        logger.info("🚫 Removed post from restricted user", {
            username: author.username,
            postId,
        });
        return;
    }

    // Otherwise this post is allowed, and restricts their next one.
    const initialRestrictionMessage = formatMessageOnPost(
        event,
        (await settings.get<string>("messageToRestrictedUsers")) ?? "",
        {
            discordLink,
            helpPage,
            requirement,
            subreddit: subredditName,
            name: pointName,
            commandsWithOr,
            commandsWithAnd,
            markdownGuide,
        }
    );

    const initialRestrictionComment = await reddit.submitComment({
        id: postId,
        text: initialRestrictionMessage,
    });

    await initialRestrictionComment.distinguish(true);

    await redis.set(lastValidPostKey, event.post.permalink);
    await redis.set(lastValidPostTitleKey, event.post.title);
    await redis.set(restrictedUserKey, "1");
    await redis.set(awardsRequiredKey, "0");

    logger.info("🧹 Restricted user after they made a new post", {
        author: author.username,
    });
}

/**
 * Handles a command in a new comment. Each comment is acted on once,
 * so editing an awarded comment can't award or reply again.
 */
export async function handleClientCommentCreate(event: OnCommentCreateRequest) {
    if (!event.post || !event.author || !event.comment) {
        logger.warn("❌ Missing required event data", { event });
        return;
    }

    if (isSystemAccount(event.author.name)) return;

    const commentBody = event.comment.body ?? "";
    const triggerUsed = findCommandInBody(commentBody, await getTriggers());

    if (!triggerUsed) {
        logger.debug("❌ No valid award command found.");
        return;
    }

    if (getIgnoredContextType(commentBody, triggerUsed)) {
        if (await ignoredContextNeedsHandling(event, triggerUsed)) {
            await handleIgnoredContext(event, triggerUsed);
        }
        return;
    }

    const handledKey = `commentCommandHandled:${event.comment.id}`;

    if (await redis.exists(handledKey)) {
        logger.debug("♻️ Command in this comment was already handled", {
            commentId: event.comment.id,
        });
        return;
    }

    await redis.set(handledKey, "1");

    const parentComment = await getParentComment(event);
    if (!parentComment) {
        logger.warn("❌ Parent comment not found", {
            commentId: event.comment.id,
        });
        return;
    }

    const awarder = event.author.name;
    const awardee = parentComment.authorName;

    if (!awardee || awardee === "[deleted]") {
        logger.warn("❌ No recipient found", { commentId: event.comment.id });
        return;
    }

    const commentTriggerContext = new CommentTriggerContext();
    await commentTriggerContext.init(event);

    if (!(await userHasPermission(event, commentTriggerContext))) {
        logger.debug("❌ User does not have permission", {
            awarder,
            commentId: event.comment.id,
        });
        return;
    }

    if (await unflairedPostLogic(event, awarder)) return;
    if (await flairTextNotAllowedLogic(event, awarder)) return;
    if (await selfAwardAttemptLogic(event, awarder, awardee)) return;
    if (await recipientIsBot(event, awarder, awardee)) return;

    const isModCommand = triggerUsed === (await modCommandValue());

    const handled = isModCommand
        ? await executeModCommand(
              event,
              parentComment,
              triggerUsed,
              commentTriggerContext
          )
        : await executeUserCommand(event, parentComment);

    if (!handled) {
        logger.debug("❌ Command detected but no point was awarded", {
            awarder,
            commentId: event.comment.id,
        });
        return;
    }

    await setPostFlairAfterAward(event);

    await scheduler.runJob({
        name: UPDATE_LEADERBOARD_JOB,
        runAt: new Date(),
        data: {
            reason: `Updated score for ${awardee}. Triggered by ${
                isModCommand ? "mod" : "user"
            } command.`,
        },
    });

    logger.info("✅ Command executed successfully", { awarder, awardee });
}

/**
 * Handles a command in an edited comment. Each comment is acted on once,
 * so editing an awarded comment can't award or reply again.
 */
export async function handleClientCommentUpdate(event: OnCommentUpdateRequest) {
    if (!event.post || !event.author || !event.comment) {
        logger.warn("❌ Missing required event data", { event });
        return;
    }

    if (isSystemAccount(event.author.name)) return;

    const commentBody = event.comment.body ?? "";
    const triggerUsed = findCommandInBody(commentBody, await getTriggers());

    if (!triggerUsed) {
        logger.debug("❌ No valid award command found.");
        return;
    }

    if (getIgnoredContextType(commentBody, triggerUsed)) {
        if (await ignoredContextNeedsHandling(event, triggerUsed)) {
            await handleIgnoredContext(event, triggerUsed);
        }
        return;
    }

    const handledKey = `commentCommandHandled:${event.comment.id}`;

    if (await redis.exists(handledKey)) {
        logger.debug("♻️ Command in this comment was already handled", {
            commentId: event.comment.id,
        });
        return;
    }

    await redis.set(handledKey, "1");

    const parentComment = await getParentComment(event);
    if (!parentComment) {
        logger.warn("❌ Parent comment not found", {
            commentId: event.comment.id,
        });
        return;
    }

    const awarder = event.author.name;
    const awardee = parentComment.authorName;

    if (!awardee || awardee === "[deleted]") {
        logger.warn("❌ No recipient found", { commentId: event.comment.id });
        return;
    }

    const commentTriggerContext = new CommentTriggerContext();
    await commentTriggerContext.init(event);

    if (!(await userHasPermission(event, commentTriggerContext))) {
        logger.debug("❌ User does not have permission", {
            awarder,
            commentId: event.comment.id,
        });
        return;
    }

    if (await unflairedPostLogic(event, awarder)) return;
    if (await flairTextNotAllowedLogic(event, awarder)) return;
    if (await selfAwardAttemptLogic(event, awarder, awardee)) return;
    if (await recipientIsBot(event, awarder, awardee)) return;

    const isModCommand = triggerUsed === (await modCommandValue());

    const handled = isModCommand
        ? await executeModCommand(
              event,
              parentComment,
              triggerUsed,
              commentTriggerContext
          )
        : await executeUserCommand(event, parentComment);

    if (!handled) {
        logger.debug("❌ Command detected but no point was awarded", {
            awarder,
            commentId: event.comment.id,
        });
        return;
    }

    await setPostFlairAfterAward(event);

    await scheduler.runJob({
        name: UPDATE_LEADERBOARD_JOB,
        runAt: new Date(),
        data: {
            reason: `Updated score for ${awardee}. Triggered by ${
                isModCommand ? "mod" : "user"
            } command.`,
        },
    });

    logger.info("✅ Command executed successfully", { awarder, awardee });
}

/**
 * Sets the optional post flair, such as marking a question as "Resolved". This
 * is a side effect, so a failure here doesn't undo the award.
 */
async function setPostFlairAfterAward(
    event: OnCommentCreateRequest | OnCommentUpdateRequest
): Promise<void> {
    if (!event.post || !event.subreddit) return;

    const enabled = await settings.get<boolean>("setPostFlairOnThanks");
    if (!enabled) return;

    const text = await settings.get<string>("setPostFlairOnThanksText");
    const cssClass = await settings.get<string>("setPostFlairOnThanksCSSClass");
    const flairTemplateId = await settings.get<string>(
        "setPostFlairOnThanksTemplate"
    );

    try {
        await reddit.setPostFlair({
            subredditName: event.subreddit.name,
            postId: event.post.id as T3,
            ...(text ? { text } : {}),
            // A flair template takes precedence over a CSS class.
            ...(flairTemplateId ? { flairTemplateId } : {}),
            ...(cssClass && !flairTemplateId ? { cssClass } : {}),
        });
    } catch (error) {
        logger.error("Could not set post flair after award", {
            postId: event.post.id,
            error: String(error),
        });
    }
}

/**
 * Awards a point to a normal user and performs all success side-effects.
 */
export async function awardPointToUserNormalCommand(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    awarder: string,
    recipient: User | undefined
) {
    const parentComment = await getParentComment(event);
    if (!parentComment || !event.subreddit || !event.comment || !event.post)
        return;

    const awardee = parentComment.authorName;
    const awardKey = `userCommand:${recipient?.username}-${event.comment.id}`;

    if (!recipient) {
        logger.warn("❌ Recipient user not found", {
            awardee,
            awarder,
        });
        return;
    }

    // Mark only after the recipient has been resolved.
    await redis.set(awardKey, "1");

    const existingScore = await getCurrentScore(recipient);

    if (!existingScore) {
        logger.warn("❌ Could not retrieve existing score for user", {
            awardee,
            awarder,
        });
        return;
    }

    const flairShouldBeManaged = !(await isFlairManagementDisabled(
        recipient.username
    ));

    const username = recipient.username;

    const scoreFromRedis = await redis.zScore(POINTS_STORE_KEY, username);

    if (scoreFromRedis === undefined || scoreFromRedis === null) return;

    await redis.zAdd(POINTS_STORE_KEY, {
        member: username,
        score: scoreFromRedis + 1,
    });

    // Record only applied awards. Mods using the normal command still count as mods.
    try {
        const awarderIsModerator = await isModerator(
            event.subreddit.name,
            awarder
        );
        await recordDigestPointAward(awarder, awarderIsModerator);
    } catch (error) {
        logger.error("Could not record normal-command digest statistic", {
            awarder,
            error,
        });
    }

    const newScore: ScoreResult = {
        score: scoreFromRedis + 1,
        userHasFlair: existingScore.userHasFlair,
        flairIsNumber: existingScore.flairIsNumber,
        flairShouldBeManaged,
    };

    const pointName = (await settings.get<string>("pointName")) ?? "point";
    const pointSymbol = (await settings.get<string>("pointSymbol")) ?? "";
    const notifySuccess = await getNotifyMode("notifyOnSuccess");

    const leaderboard = `https://old.reddit.com/r/${
        event.subreddit.name
    }/wiki/${(await settings.get<string>("leaderboardName")) ?? "leaderboard"}`;

    const awardeePage = `https://old.reddit.com/r/${event.subreddit.name}/wiki/user/${recipient.username}/1`;
    const awarderPage = `https://old.reddit.com/r/${event.subreddit.name}/wiki/user/${awarder}/1`;

    const totalScore = await getCurrentScore(recipient);

    if (!totalScore) {
        logger.warn("❌ Could not retrieve existing score for user", {
            awardee,
        });
        return;
    }

    const successMessage = formatMessageOnComment(
        event,
        (await settings.get<string>("successMessage")) ?? "",
        {
            awardee,
            awarder,
            total: totalScore.score.toString(),
            name: pointName,
            symbol: pointSymbol,
            leaderboard,
            awardeePage,
            awarderPage,
        }
    );

    if (notifySuccess === "replybypm") {
        await Promise.all([
            notifyUser({
                mode: notifySuccess,
                to: awarder,
                subject: `You awarded a ${pointName}`,
                text: successMessage,
                commentId: event.comment.id,
            }),
            notifyUser({
                mode: notifySuccess,
                to: awardee,
                subject: `You were awarded a ${pointName}`,
                text: successMessage,
                commentId: event.comment.id,
            }),
        ]);
    } else {
        await notifyUser({
            mode: notifySuccess,
            to: awarder,
            subject: `You awarded a ${pointName}`,
            text: successMessage,
            commentId: event.comment.id,
        });
    }

    let user: User | undefined;

    try {
        user = await reddit.getUserByUsername(awarder);
    } catch {
        user = undefined;
    }
    if (!user) return;

    if (await restrictedKeyExists(awarder)) {
        await updateAuthorRedis(event, user);
    }

    logger.info(`✅ Awarded 1 point to ${recipient.username} from ${awarder}`, {
        newScore,
    });

    // 📘 Wiki history is independent of flair management.
    // A successful award must always be recorded in the user wiki first.
    const givenData = {
        postTitle: event.post.title,
        postUrl: event.post.permalink,
        awardee,
        commentUrl: event.comment.permalink,
    };

    try {
        // updateUserWiki owns migration/creation. Keep this before the flair
        // toggle check so wiki history is recorded even when flair is disabled.
        await updateUserWiki(awarder, awardee, givenData);
    } catch (err) {
        logger.error("❌ Failed to update user wiki (Normal award)", {
            awarder,
            awardee,
            err,
        });
    }

    // Flair management is a separate optional side effect.
    const flairHandlingDisabled = await flairToggleKeyExists(recipient);

    if (flairHandlingDisabled) {
        logger.info(
            "Flair handling is disabled for this user; wiki was updated and flair update was skipped"
        );
        return;
    }

    await setUserScore(awardee, awarder, newScore);
}

/**
 * Counts an award towards lifting the OP's posting restriction.
 * Missing restriction key = already eligible (never re-count).
 */
export async function updateAuthorRedis(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    author: User | undefined
): Promise<void> {
    if (!event.author || !event.post || !event.comment || !author) return;

    const isPostAuthor = event.post.authorId === event.author.id;
    if (!isPostAuthor) return;

    const awardsRequired =
        (await settings.get<number>("awardsRequiredToCreateNewPosts")) ?? 0;

    const restrictionKey = await getRestrictedKey(author);
    const raw = await redis.get(restrictionKey);

    if (!raw) return;

    const currentCount = Number(raw) || 0;

    if (currentCount < awardsRequired) {
        await redis.set(restrictionKey, (currentCount + 1).toString());

        logger.info(
            `⏳ User ${author.username} still restricted: ${currentCount}/${awardsRequired}`
        );
        return;
    }

    logger.info(
        `✅ User ${author.username} satisfied award requirement: ${currentCount}/${awardsRequired}`
    );

    await deleteRestrictedKey(author);

    const subredditName = event.subreddit?.name ?? "unknown-subreddit";

    const liftedMsg = formatMessageOnComment(
        event,
        (await settings.get<string>("restrictionLiftedMessage")) ?? "",
        { awarder: event.author.name, subreddit: subredditName }
    );

    await notifyUser({
        mode: await getNotifyMode("notifyOnRestrictionLifted"),
        to: author.username,
        subject: `Restriction lifted in r/${subredditName}`,
        text: liftedMsg,
        commentId: event.comment.id,
    });
}

/**
 * Executes the user command workflow.
 */
export async function executeUserCommand(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    parentComment: Comment
): Promise<boolean> {
    if (!event.author || !event.comment || !event.post || !event.subreddit) {
        logger.warn("❌ Missing required event data", { event });
        return false;
    }

    const awarder = event.author.name;
    const recipient = parentComment.authorName;
    const pointName = (await settings.get<string>("pointName")) ?? "point";

    // 🚫 Blocked users
    if (!(await getUserCanAward(awarder))) {
        const blockedMessage = formatMessageOnComment(
            event,
            (await settings.get<string>("usersWhoCannotAwardPointsMessage")) ??
                "",
            { name: pointName, awarder, subreddit: event.subreddit.name }
        );

        await notifyUser({
            mode: await getNotifyMode("notifyOnBlockedUser"),
            to: awarder,
            subject: `You do not have permission to award ${pointName}s in r/${event.subreddit.name}`,
            text: blockedMessage,
            commentId: event.comment.id,
        });

        return false;
    }

    if (await postAuthorAwardLogic(event, parentComment)) return false;

    // 🛑 Duplicate award check
    const key = `userAwardGiven:${parentComment.id}:${event.post.id}:${event.subreddit.name}`;

    if (await redis.exists(key)) {
        const alreadyAwardedMessage = formatMessageOnComment(
            event,
            (await settings.get<string>("pointAlreadyAwardedToUserMessage")) ??
                "",
            { awarder, awardee: recipient, name: pointName }
        );

        await notifyUser({
            mode: await getNotifyMode("notifyOnPointAlreadyAwardedToUser"),
            to: awarder,
            subject: `This comment has already received a ${pointName}`,
            text: alreadyAwardedMessage,
            commentId: event.comment.id,
        });

        logger.info("⚠️ Point already awarded for this command", {
            awarder,
            recipient,
        });

        return false;
    }

    logger.info(`Point not awarded yet for this command`);

    let awardee: User | undefined;

    try {
        awardee = await reddit.getUserByUsername(recipient);
    } catch {
        awardee = undefined;
    }

    if (!awardee) return false;

    // Mark the award as processed only after the recipient is resolved.
    await redis.set(key, "1");

    // 🏆 Award point + side effects
    await awardPointToUserNormalCommand(event, awarder, awardee);

    // Auto Legend logic
    const commandUsed =
        (await settings.get<string>("pointTriggerWords")) ?? "!snipe";

    const currentScore = (await redis.zScore(POINTS_STORE_KEY, recipient)) ?? 0;

    await handleAutoSuperuserPromotion(event, currentScore, commandUsed);
    await handleLegendPromotion(event, currentScore);

    return true;
}

export async function isDuplicateModAward(
    event: OnCommentCreateRequest | OnCommentUpdateRequest
): Promise<boolean> {
    const key = await getModDupKey(event);
    const exists = await redis.exists(key);
    return exists === 1;
}

export async function handleDuplicateModAward(
    event: OnCommentCreateRequest | OnCommentUpdateRequest
) {
    const parentComment = await getParentComment(event);
    if (!parentComment || !event.author || !event.comment) return;

    const pointName = (await settings.get<string>("pointName")) ?? "point";
    const awarder = event.author.name;
    const awardee = parentComment.authorName;

    const modAwardAlreadyGivenMessage = formatMessageOnComment(
        event,
        (await settings.get<string>("modAwardAlreadyGiven")) ?? "",
        { awarder, awardee, name: pointName }
    );

    await notifyUser({
        mode: await getNotifyMode("notifyOnModAwardFail"),
        to: awarder,
        subject: "Mod award already given",
        text: modAwardAlreadyGivenMessage,
        commentId: event.comment.id,
    });

    logger.info("❌ Duplicate mod award blocked", { awarder });
}

export async function handleUnauthorizedModCommand(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    awardee: string,
    trigger: string
): Promise<void> {
    if (!event.author || !event.comment) return;

    const awarder = event.author.name;
    const pointName = (await settings.get<string>("pointName")) ?? "point";

    const failMsg = formatMessageOnComment(
        event,
        (await settings.get<string>("modAwardCommandFail")) ?? "",
        { awarder, awardee, command: trigger, name: pointName }
    );

    await notifyUser({
        mode: await getNotifyMode("notifyOnModAwardFail"),
        to: awarder,
        subject: "Mod Award Command Not Allowed",
        text: failMsg,
        commentId: event.comment.id,
    });

    logger.warn("🚫 Unauthorized mod command", { awarder });
}

export async function awardPointToUserModCommand(
    event: OnCommentCreateRequest | OnCommentUpdateRequest
) {
    if (!event.comment || !event.subreddit || !event.author || !event.post) {
        logger.warn("❌ Missing required event data", { event });
        return;
    }
    const settingPointName = await settings.get<string>("pointName");
    const settingModAwardCommand = await settings.get<string>(
        "modAwardCommand"
    );
    const settingLeaderboardName = await settings.get<string>(
        "leaderboardName"
    );
    const settingModAwardCommandSuccess = await settings.get<string>(
        "modAwardCommandSuccess"
    );
    const settingTrustedUserAwardSuccessMessage = await settings.get<string>(
        "trustedUserAwardSuccessMessage"
    );
    const settingPointSymbol = await settings.get<string>("pointSymbol");
    const pointName = (settingPointName as string) ?? "point";

    const parentComment = await getParentComment(event);
    if (!parentComment || !parentComment.authorId) {
        logger.warn("❌ Parent comment missing for mod award");
        return;
    }

    const awarder = event.author.name;
    const awardee = parentComment.authorName;

    // Classify by actual moderator status, not by which command was used.
    const awarderIsModerator = await isModerator(event.subreddit.name, awarder);

    let user: User | undefined;

    try {
        user = await reddit.getUserByUsername(awarder);
    } catch {
        user = undefined;
    }

    if (!user) return;

    let recipient: User | undefined;

    try {
        recipient = await reddit.getUserByUsername(awardee);
    } catch {
        recipient = undefined;
    }

    if (!recipient) return;

    const existingScore = await getCurrentScore(recipient);

    if (!existingScore) {
        logger.warn("❌ Could not retrieve existing score for user", {
            awardee,
        });
        return;
    }

    const flairShouldBeManaged = !(await isFlairManagementDisabled(awardee));

    const username = awardee;

    const scoreFromRedis = await redis.zScore(POINTS_STORE_KEY, username);

    if (scoreFromRedis === undefined || scoreFromRedis === null) return;

    await redis.zAdd(POINTS_STORE_KEY, {
        member: username,
        score: scoreFromRedis + 1,
    });

    // Record the successful point independently of optional replies/flair/wiki.
    try {
        await recordDigestPointAward(awarder, awarderIsModerator);
    } catch (error) {
        logger.error("Could not record moderator-command digest statistic", {
            awarder,
            error,
        });
    }

    const newScore: ScoreResult = {
        score: scoreFromRedis + 1,
        userHasFlair: existingScore.userHasFlair,
        flairIsNumber: existingScore.flairIsNumber,
        flairShouldBeManaged,
    };

    // 🔒 Prevent duplicates
    await setModDupKey(event, "1");

    // ⭐ Auto-legend logic
    const modCommand = (settingModAwardCommand as string) ?? "";
    await handleAutoSuperuserPromotion(event, newScore.score, modCommand);
    await handleLegendPromotion(event, newScore.score);

    // 📣 Notify on success
    const modNotifyMode = await getNotifyMode("notifyOnModAwardSuccess");
    const trustedUserNotifyMode = await getNotifyMode(
        "notifyOnTrustedUserAwardSuccess"
    );

    const leaderboard = `https://old.reddit.com/r/${
        event.subreddit.name
    }/wiki/${settingLeaderboardName ?? "leaderboard"}`;
    const awarderIsSuperUser = await getUserIsSuperuser(awarder);

    const modSuccessTemplate = (settingModAwardCommandSuccess as string) ?? "";
    const trustedUserSuccessTemplate =
        (settingTrustedUserAwardSuccessMessage as string) ?? "";

    const totalScore = await getCurrentScore(recipient);

    if (!totalScore) {
        logger.warn("❌ Could not retrieve existing score for user", {
            awardee,
        });
        return;
    }

    const awardeePage = `https://old.reddit.com/r/${event.subreddit.name}/wiki/user/${awardee}/1`;
    const awarderPage = `https://old.reddit.com/r/${event.subreddit.name}/wiki/user/${awarder}/1`;
    const modSuccessMessage = formatMessageOnComment(
        event,
        modSuccessTemplate,
        {
            awardee,
            awarder,
            total: newScore.score.toString(),
            name: pointName,
            symbol: (settingPointSymbol as string) ?? "",
            leaderboard,
            awardeePage,
            awarderPage,
        }
    );

    const trustedUserMessage = formatMessageOnComment(
        event,
        trustedUserSuccessTemplate,
        {
            awardee,
            awarder,
            total: newScore.score.toString(),
            name: pointName,
            symbol: (settingPointSymbol as string) ?? "",
            leaderboard,
            awardeePage,
            awarderPage,
        }
    );

    if (awarderIsModerator) {
        await notifyUser({
            mode: modNotifyMode,
            to: awarder,
            subject: "Mod Award Successful",
            text: modSuccessMessage,
            commentId: event.comment.id,
        });

        logger.info("🛡️ Mod award successful", {
            awarder,
            awardee,
            newScore,
        });
    } else if (awarderIsSuperUser) {
        await notifyUser({
            mode: trustedUserNotifyMode,
            to: awarder,
            subject: "Legend Award Successful",
            text: trustedUserMessage,
            commentId: event.comment.id,
        });
    }

    // 📘 Wiki history is independent of flair management.
    // A successful award must always be recorded in the user wiki first.
    const givenData = {
        postTitle: event.post.title,
        postUrl: event.post.permalink,
        awardee,
        commentUrl: event.comment.permalink,
    };

    try {
        // updateUserWiki owns migration/creation. Keep this before the flair
        // toggle check so wiki history is recorded even when flair is disabled.
        await updateUserWiki(awarder, awardee, givenData);
    } catch (err) {
        logger.error("❌ Failed to update user wiki (MOD award)", {
            awarder,
            awardee,
            err,
        });
    }

    // Flair management is a separate optional side effect.
    const flairHandlingDisabled = await flairToggleKeyExists(recipient);

    if (flairHandlingDisabled) {
        logger.info(
            "Flair handling is disabled for this user; wiki was updated and flair update was skipped"
        );
        return;
    }

    await setUserScore(awardee, awarder, newScore);
}

export async function executeModCommand(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    parentComment: Comment,
    trigger: string,
    commentTriggerContext: CommentTriggerContext
): Promise<boolean> {
    if (!commentTriggerContext.isMod && !commentTriggerContext.isSuperUser) {
        await handleUnauthorizedModCommand(
            event,
            parentComment.authorName,
            trigger
        );
        return false;
    }

    if (await postAuthorAwardLogic(event, parentComment)) return false;

    if (await isDuplicateModAward(event)) {
        await handleDuplicateModAward(event);
        return false;
    }

    await awardPointToUserModCommand(event);

    return true;
}

async function setFlairForUser(
    awarder: string,
    awardee: string,
    countsAsAward: boolean
): Promise<void> {
    const settingBaseCSSClass = await settings.get<string>("baseCSSClass");
    const settingBaseFlairTemplate = await settings.get<string>(
        "baseFlairTemplate"
    );
    const settingSuperAwarderCSSClass = await settings.get<string>(
        "superAwarderCSSClass"
    );

    if (!context.subredditName) {
        logger.error("Cannot set user flair: subreddit name is missing");
        return;
    }

    const baseCssClass = settingBaseCSSClass ?? undefined;

    const baseFlairTemplate = settingBaseFlairTemplate ?? undefined;

    const superAwarderCSSClass = settingSuperAwarderCSSClass ?? undefined;

    // Use the base template until a dedicated Super Awarder template setting exists.
    const superAwarderFlairTemplate =
        (await settings.get<string>("superAwarderFlairTemplate")) ?? undefined;

    const flairFormatting = await settings.get<string>("flairFormatting");

    // The default flair option is the "without symbol" one.
    const existingFlairHandling = await getSelectSetting(
        "existingFlairHandling",
        "overwritenumeric"
    );
    const pointSymbol =
        existingFlairHandling === "overwritenumeric"
            ? ""
            : (await settings.get<string>("pointSymbol")) ?? "";

    const superAwarderThreshold =
        (await settings.get<number>("superAwarderThreshold")) ?? 0;

    const superAwarderFlairText = await settings.get<string>(
        "superAwarderFlairText"
    );

    const legendThreshold =
        (await settings.get<number>("legendThreshold")) ?? 0;
    const legendFlairText = await settings.get<string>("legendFlairText");
    const legendCSSClass =
        (await settings.get<string>("legendCSSClass")) ?? undefined;
    const legendFlairTemplate =
        (await settings.get<string>("legendFlairTemplate")) ?? undefined;

    // The awards-given count is cached in Redis. Each cached count is checked
    // against the user's history pages once, because a count cached by
    // version 0.0.6 or earlier could be 0 when the history page wasn't found,
    // which took away Super Awarder titles.
    const getOrInitializeAwardsGiven = async (
        username: string
    ): Promise<number> => {
        const redisKey = `awardsGiven:${username}`;
        const checkedKey = `awardsGivenChecked:${username}`;
        const cached = Number.parseInt((await redis.get(redisKey)) ?? "", 10);
        const cachedCount =
            Number.isFinite(cached) && cached >= 0 ? cached : undefined;

        if (cachedCount !== undefined && (await redis.exists(checkedKey))) {
            return cachedCount;
        }

        let fromWiki: number | undefined;
        try {
            fromWiki = (await getUserWikiLifetimeTotalsForUser(username)).given;
        } catch (error) {
            logger.warn("Couldn't read awards given from the user's wiki", {
                username,
                error: String(error),
            });
        }

        // Without the history pages, don't save a guess. Try again next time.
        if (fromWiki === undefined) return cachedCount ?? 0;

        const count = Math.max(cachedCount ?? 0, fromWiki);
        await redis.set(redisKey, count.toString());
        await redis.set(checkedKey, "1");
        return count;
    };

    // The awarder gets credit for this award:
    // - If their cache already exists, increment it.
    // - Otherwise initialize it from their wiki without incrementing it.
    if (countsAsAward) {
        const awarderAwardsGivenKey = `awardsGiven:${awarder}`;
        const cachedAwarderCount = await redis.get(awarderAwardsGivenKey);

        if (cachedAwarderCount) {
            const parsed = Number.parseInt(cachedAwarderCount, 10);
            const currentCount =
                Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;

            await redis.set(
                awarderAwardsGivenKey,
                (currentCount + 1).toString()
            );
        } else {
            await getOrInitializeAwardsGiven(awarder);
        }
    }

    // Get the received-points leaderboard once for both users.
    const leaderboard = await redis.zRange(POINTS_STORE_KEY, 0, -1, {
        by: "rank",
        reverse: true,
    });

    // If both names are the same, only update that user once. A moderator
    // correcting someone's score isn't an award, so their flair stays as it is.
    const usernames = countsAsAward
        ? [...new Set([awarder, awardee])]
        : [awardee];

    for (const username of usernames) {
        try {
            // Respect each user's own flair opt-out.
            if (await isFlairManagementDisabled(username)) {
                logger.info("Skipping flair update because user opted out", {
                    username,
                });
                continue;
            }

            // A giver's own flair, such as a moderator flair, is kept the same
            // way as the receiver's. Only empty flair or flair written by this
            // bot or RepBot is replaced.
            if (username !== awardee) {
                const giver = await reddit.getUserByUsername(username);
                const giverFlair = (
                    await giver?.getUserFlairBySubreddit(context.subredditName)
                )?.flairText?.trim();

                if (giverFlair && !(await isBotWrittenFlair(giverFlair))) {
                    logger.info("Keeping the giver's own flair", {
                        username,
                    });
                    continue;
                }
            }

            // Received-points total and leaderboard position.
            const score = (await redis.zScore(POINTS_STORE_KEY, username)) ?? 0;

            const index = leaderboard.findIndex(
                (member: { member: string; score: number }) =>
                    member.member === username
            );

            const userRank = index >= 0 ? index + 1 : undefined;
            const place = { json: userRank?.toString() ?? "N/A" };

            // Determine Super Awarder status independently for each user.
            // This means receiving points won't remove their title.
            const awardsGiven = await getOrInitializeAwardsGiven(username);

            const isSuperAwarder =
                superAwarderThreshold > 0 &&
                awardsGiven >= superAwarderThreshold;

            // Legend is earned by points received. It's rarer than Super
            // Awarder, so a Legend's flair is shown when someone has both.
            const isLegend = legendThreshold > 0 && score >= legendThreshold;

            // Giving an award doesn't earn flair on its own, so an awarder
            // with no points of their own isn't given "0 | #N/A".
            if (username !== awardee && score === 0 && !isSuperAwarder) {
                continue;
            }

            let flairText = isLegend
                ? legendFlairText
                : isSuperAwarder
                ? superAwarderFlairText
                : flairFormatting;

            let cssClass = isLegend
                ? legendCSSClass ?? baseCssClass
                : isSuperAwarder
                ? superAwarderCSSClass ?? baseCssClass
                : baseCssClass;

            const flairTemplate = isLegend
                ? legendFlairTemplate
                : isSuperAwarder
                ? superAwarderFlairTemplate
                : baseFlairTemplate;

            // Replace both supported placeholder styles.
            const replacements: Record<string, string> = {
                place: place.json,
                total: score.toString(),
                symbol: pointSymbol,
            };

            if (!flairText) {
                logger.error(`Couldn't retrieve flair text, returning`);
                return;
            }

            for (const [placeholder, value] of Object.entries(replacements)) {
                const singleRegex = new RegExp(`{${placeholder}}`, "gi");
                const doubleRegex = new RegExp(`{{${placeholder}}}`, "gi");
                if (doubleRegex.test(flairText)) {
                    logger.debug(`Replacing {{${placeholder}}} with ${value}`);
                    flairText = flairText.replaceAll(doubleRegex, value);
                } else if (singleRegex.test(flairText)) {
                    logger.debug(`Replacing {${placeholder}} with ${value}`);
                    flairText = flairText.replaceAll(singleRegex, value);
                }
            }

            // A flair template ID takes precedence over the CSS class.
            if (flairTemplate) {
                cssClass = undefined;
            }

            await reddit.setUserFlair({
                subredditName: context.subredditName,
                username,
                cssClass,
                flairTemplateId: flairTemplate,
                text: flairText,
            });

            logger.info("Updated user flair", {
                username,
                isLegend,
                isSuperAwarder,
                awardsGiven,
                score,
                userRank,
            });
        } catch (err) {
            logger.error(
                "Unable to update user flair",
                {
                    username,
                    error: err instanceof Error ? err.message : String(err),
                },
                context
            );
        }
    }
}

export async function setUserScore(
    awardee: string,
    awarder: string,
    newScore: ScoreResult,
    countsAsAward = true
): Promise<void> {
    /**
     * POINTS_STORE_KEY is the single source of truth.
     *
     * member = username
     * score  = user's point total
     */
    await redis.zAdd(POINTS_STORE_KEY, {
        member: awardee,
        score: newScore.score,
    });

    logger.debug("Saved user score", {
        awardee,
        score: newScore.score,
    });

    // Queue cleanup checks for both users.
    await setCleanupForUsers([awardee, awarder]);

    // Respect the configured existing-flair overwrite behavior.
    const existingFlairHandling = await getSelectSetting(
        "existingFlairHandling",
        "overwritenumeric"
    );

    const shouldSetUserFlair =
        existingFlairHandling !== "neverset" &&
        newScore.flairShouldBeManaged &&
        (!newScore.userHasFlair || newScore.flairIsNumber);

    if (!shouldSetUserFlair) {
        logger.debug(
            "Flair not set because existing flair should be preserved",
            {
                awardee,
                awarder,
                existingFlairHandling,
            }
        );
        return;
    }

    if (!context.subredditName) {
        logger.error("❌ No subreddit name found in  cannot set user flair");
        return;
    }

    // Set the recipient's flair using values fetched individually from Devvit Web settings.
    await setFlairForUser(awarder, awardee, countsAsAward);
}

/**
 * The post author can't be awarded points. Returns true if this award is blocked.
 */
async function postAuthorAwardLogic(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    parentComment: Comment
): Promise<boolean> {
    if (!event.post || !event.author || !event.comment) return false;
    if (parentComment.authorId !== event.post.authorId) return false;

    const pointName = (await settings.get<string>("pointName")) ?? "point";

    await notifyUser({
        mode: await getNotifyMode("notifyOnPostAuthorAward"),
        to: event.author.name,
        subject: `You do not have permission to award ${pointName}s to Post Authors`,
        text: formatMessageOnComment(
            event,
            (await settings.get<string>("postAuthorAwardMessage")) ?? "",
            { name: pointName }
        ),
        commentId: event.comment.id,
    });

    return true;
}

/** Returns true if this award is blocked because the post has no flair. */
export async function unflairedPostLogic(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    awarder: string
): Promise<boolean> {
    if (!event.post || !event.comment) return false;

    const allowUnflairedPosts =
        (await settings.get<boolean>("allowUnflairedPosts")) ?? true;

    if (allowUnflairedPosts || event.post.linkFlair?.text?.trim()) return false;

    logger.info("🚫 Award blocked — post is unflaired", {
        awarder,
        postId: event.post.id,
        commentId: event.comment.id,
    });

    await notifyUser({
        mode: await getNotifyMode("notifyOnUnflairedPost"),
        to: awarder,
        subject: `Awards disabled for unflaired posts`,
        text: formatMessageOnComment(
            event,
            (await settings.get<string>("unflairedPostMessage")) ?? "",
            { name: (await settings.get<string>("pointName")) ?? "point" }
        ),
        commentId: event.comment.id,
    });

    return true;
}

/** Returns true if this award is blocked by the post's flair. */
export async function flairTextNotAllowedLogic(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    awarder: string
): Promise<boolean> {
    if (!event.post || !event.comment) return false;

    const postFlairText = event.post.linkFlair?.text?.trim();
    if (!postFlairText) return false;

    const disallowedFlairs = (
        (await settings.get<string>("disallowedFlairs")) ?? ""
    )
        .split(/\r?\n/) // newline-only entries
        .map((flair) => flair.trim())
        .filter(Boolean);

    if (!disallowedFlairs.includes(postFlairText)) return false;

    logger.info("🚫 Award blocked due to disallowed flair", {
        postFlair: postFlairText,
    });

    const pointName = (await settings.get<string>("pointName")) ?? "point";

    await notifyUser({
        mode: await getNotifyMode("notifyOnDisallowedFlair"),
        to: awarder,
        subject: `${pointName}s cannot be awarded on ${event.post.title}`,
        text: formatMessageOnComment(
            event,
            (await settings.get<string>("disallowedFlairMessage")) ?? "",
            { name: pointName }
        ),
        commentId: event.comment.id,
    });

    return true;
}

/** Returns true if this award is blocked because users can't award themselves. */
export async function selfAwardAttemptLogic(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    awarder: string,
    recipient: string
): Promise<boolean> {
    if (!event.comment) return false;
    if (awarder.toLowerCase() !== recipient.toLowerCase()) return false;

    const pointName = (await settings.get<string>("pointName")) ?? "point";

    await notifyUser({
        mode: await getNotifyMode("notifyOnSelfAward"),
        to: awarder,
        subject: `You tried to award yourself a ${pointName}`,
        text: formatMessageOnComment(
            event,
            (await settings.get<string>("selfAwardMessage")) ?? "",
            { awarder, name: pointName }
        ),
        commentId: event.comment.id,
    });

    logger.debug("❌ User tried to award themselves.");
    return true;
}
export async function replyToUser(
    notifyMode: string,
    recipient: string,
    message: string,
    commentId: string
) {
    if (!notifyMode || notifyMode === "none") {
        logger.debug("ℹ️ replyToUser: notifyMode is none — skipping reply");
        return;
    }

    // 🚫 Prevent bot loops
    if (
        recipient.toLowerCase() === context.appSlug.toLowerCase() ||
        recipient.toLowerCase() === "automoderator"
    ) {
        logger.debug("🤖 replyToUser: recipient is bot/system — skipping");
        return;
    }

    // 🔑 One reply per comment + notify type
    const responseKey = `replyToUser:${notifyMode}:${commentId}`;
    if (await redis.exists(responseKey)) {
        logger.debug("♻️ replyToUser: response already sent", {
            commentId,
            notifyMode,
        });
        return;
    }

    try {
        if (notifyMode === "replybypm") {
            await reddit.sendPrivateMessage({
                to: recipient,
                subject: "Award not allowed",
                text: message,
            });

            logger.info("📬 replyToUser: sent PM", {
                recipient,
                commentId,
            });
        } else if (notifyMode === "replybycomment") {
            const reply = await reddit.submitComment({
                id: commentId as `t1_${string}`,
                text: message,
            });
            await reply.distinguish();

            logger.info("💬 replyToUser: posted comment reply", {
                commentId,
            });
        } else {
            logger.warn("⚠️ replyToUser: unknown notifyMode", {
                notifyMode,
            });
            return;
        }

        // ✅ Mark handled AFTER success
        await redis.set(responseKey, "1");
    } catch (err) {
        logger.error("❌ replyToUser failed", {
            recipient,
            commentId,
            notifyMode,
            err,
        });
    }
}

export async function userHasPermission(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    commentTriggerContext: CommentTriggerContext
): Promise<boolean> {
    if (!event.post || !event.comment || !event.author) return false;

    const isMod = commentTriggerContext.isMod;
    const isSuperUser = commentTriggerContext.isSuperUser;
    const isOP = event.author.id === event.post.authorId;

    const accessControl = await getSelectSetting("accessControl", "everyone");

    const accessRules: Record<
        string,
        { allowed: boolean; message: string; notify: string }
    > = {
        "moderators-only": {
            allowed: isMod,
            message: "modOnlyDisallowedMessage",
            notify: "notifyOnModOnlyDisallowed",
        },
        "moderators-and-superusers": {
            allowed: isMod || isSuperUser,
            message: "approvedOnlyDisallowedMessage",
            notify: "notifyOnApprovedOnlyDisallowed",
        },
        "moderators-and-op": {
            allowed: isMod || isOP,
            message: "modsAndPostAuthorDisallowedMessage",
            notify: "notifyOnModsAndPostAuthorDisallowed",
        },
        "moderators-superusers-and-op": {
            allowed: isMod || isSuperUser || isOP,
            message: "opOnlyDisallowedMessage",
            notify: "notifyOnOPOnlyDisallowed",
        },
    };

    const rule = accessRules[accessControl];

    logger.debug("Permission check", {
        accessControl,
        isMod,
        isSuperUser,
        isOP,
    });

    if (!rule || rule.allowed) return true;

    const awarder = event.author.name;

    const denyMsg = formatMessageOnComment(
        event,
        (await settings.get<string>(rule.message)) ?? "",
        {
            awarder,
            name: (await settings.get<string>("pointName")) ?? "point",
        }
    );

    await replyToUser(
        await getNotifyMode(rule.notify),
        awarder,
        denyMsg,
        event.comment.id
    );

    return false;
}

/** Returns true if this award is blocked because the recipient is a bot. */
export async function recipientIsBot(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    awarder: string,
    recipient: string
): Promise<boolean> {
    if (!event.comment || !isSystemAccount(recipient)) return false;

    const pointName = (await settings.get<string>("pointName")) ?? "point";

    await notifyUser({
        mode: await getNotifyMode("notifyOnBotAward"),
        to: awarder,
        subject: `You can't award ${pointName}s to bots`,
        text: formatMessageOnComment(
            event,
            (await settings.get<string>("botAwardMessage")) ?? "",
            { name: pointName, awardee: recipient }
        ),
        commentId: event.comment.id,
    });

    logger.debug("❌ Bot cannot be awarded points");
    return true;
}

export async function handleIgnoredContext(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    trigger: string
): Promise<void> {
    if (!event.comment || !event.author || !event.subreddit) return;

    const body = (event.comment.body ?? "").toLowerCase();
    const ignoredType = getIgnoredContextType(body, trigger);
    if (!ignoredType) return;

    const ignoreKey = `normalCommandIgnoreDM:${event.author.name.toLowerCase()}:${ignoredType}`;
    const alreadyConfirmed = await redis.exists(ignoreKey);

    if (alreadyConfirmed) return;

    const contextLabel =
        ignoredType === "quote"
            ? "a quote block (`> text`)"
            : ignoredType === "alt"
            ? "`alt text` (text surrounded by backticks (`))"
            : "a spoiler block (`>!text!<`)";

    const initialTriggerInContextLabelNotification = `Hey u/${event.author.name}, I noticed you used the command **${trigger}** inside ${contextLabel}.\n\n`;
    const confirmInfo = `Edit [this comment](${event.comment.permalink}) with **CONFIRM** if you intended to use the command this way and don't wish to be warned about this in the future.`;

    const dmText = formatMessageOnComment(
        event,
        initialTriggerInContextLabelNotification + confirmInfo,
        {}
    );

    await reddit.sendPrivateMessage({
        to: event.author.name,
        subject: `Your ${trigger} command was ignored`,
        text: dmText,
    });

    await redis.set(
        `pendingConfirm:${event.author.name.toLowerCase()}`,
        ignoredType
    );

    logger.info("⚠️ Normal command ignored due to context", {
        user: event.author.name,
        trigger,
        ignoredType,
    });

    return;
}

export async function ignoredContextNeedsHandling(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    trigger: string
): Promise<boolean> {
    if (!event.comment || !event.author || !event.subreddit) return false;

    const body = (event.comment.body ?? "").toLowerCase();
    const ignoredType = getIgnoredContextType(body, trigger);
    if (!ignoredType) return false;

    const ignoreKey = `normalCommandIgnoreDM:${event.author.name.toLowerCase()}:${ignoredType}`;

    // A user who replied CONFIRM has chosen not to be warned again.
    return !(await redis.exists(ignoreKey));
}
