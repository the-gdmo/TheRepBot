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
    OnPostCreateRequest,
    T1,
    T2,
    T3,
} from "@devvit/web/shared";
import {
    formatMessage,
    getIgnoredContextType,
    getTriggers,
    modCommandValue,
    ScoreResult,
    userCommandValues,
} from "./utils/common-utilities";
import {
    CommentTriggerContext,
    getParentComment,
} from "../../repbot/triggers/comment/comment-trigger-context";
import { logger } from "./utils/logger";
import {
    getCurrentScore,
    getUserIsSuperuser,
    handleAutoSuperuserPromotion,
    isModerator,
} from "./utils/user-utilities";
import {
    deleteRestrictedKey,
    flairToggleKeyExists,
    getModDupKey,
    getRestrictedKey,
    POINTS_STORE_KEY,
    restrictedKeyExists,
    setModDupKey,
} from "./utils/redisKeys";
import { recordDigestPointAward } from "./utils/digest-stats";
import { UPDATE_LEADERBOARD_JOB } from "../../repbot/constants";
import {
    capitalize,
    discoverLatestPage,
    escapeMarkdownText,
    getNumberedUserWikiPath,
    getStoredLatestPage,
    updateUserWiki,
} from "../../repbot/leaderboard";
import { getSubredditName, SafeWikiClient } from "./utils/utility";
import pluralize from "pluralize";
import { setCleanupForUsers } from "../../repbot/cleanupTasks";

export async function handleClientPostCreate(event: OnPostCreateRequest) {
    if (!event.post || !event.author?.name) {
        console.error(
            "Content Create: PostCreate event missing post or author information",
            JSON.stringify(event)
        );
        return;
    }

    console.log(
        `Content Create: PostCreate ${event.post.id} by ${event.author.name}`
    );

    if (
        event.author.name === "AutoModerator" ||
        event.author.name === `${context.subredditName}-ModTeam` ||
        event.author.name === context.appSlug
    ) {
        return;
    }

    const post = await reddit.getPostById(event.post.id as T3);
}

/**
 * Checks if a comment contains any user command keywords.
 */
export async function commentContainsUserCommand(
    event: OnCommentCreateRequest | OnCommentUpdateRequest
): Promise<boolean> {
    if (!event.comment) return false;

    const userCommands = await userCommandValues();
    const body = (event.comment.body ?? "").toLowerCase();

    return userCommands.some((command) =>
        new RegExp(`${command}`, "i").test(body)
    );
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

    let flairShouldBeManaged: boolean;

    const key = `flairToggle:${recipient.username}`;
    const exists = await redis.exists(key);

    if (exists) {
        flairShouldBeManaged = false;
    } else {
        flairShouldBeManaged = true;
    }

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
    const notifySuccess =
        (await settings.get<string>("notifyOnSuccess")) ?? "none";

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

    await scheduler.runJob({
        name: UPDATE_LEADERBOARD_JOB,
        runAt: new Date(),
        data: {
            reason: `Updated score for ${recipient.username}. Triggered by normal command.`,
        },
    });

    const successMessage = formatMessage(
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
            reddit.sendPrivateMessage({
                to: awarder,
                subject: `You awarded a ${pointName}`,
                text: successMessage,
            }),
            reddit.sendPrivateMessage({
                to: awardee,
                subject: `You were awarded a ${pointName}`,
                text: successMessage,
            }),
        ]);
    } else if (notifySuccess === "replyascomment") {
        const commandSuccessMessage = await reddit.submitComment({
            id: event.comment.id as T1,
            text: successMessage,
        });
        await commandSuccessMessage.distinguish();
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
 * Updates OP restricted award count.
 * Missing restriction key = already eligible (never re-count).
 */
export async function updateAuthorRedis(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    author: User | undefined
): Promise<void> {
    if (!event.author || !event.post || !author) return;

    const isPostAuthor = event.post.authorId === event.author.id;
    if (!isPostAuthor) return;

    const awardsRequired =
        (await settings.get<number>("awardsRequiredToCreateNewPosts")) ?? 0;
    const awarder = event.author.name;

    let user: User | undefined;

    try {
        user = await reddit.getUserByUsername(awarder);
    } catch {
        user = undefined;
    }
    if (!user) return;

    const restrictionKey = await getRestrictedKey(author);
    const raw = await redis.get(restrictionKey);

    // 🔒 If the restriction key no longer exists, NEVER re-increment
    if (raw === null) {
        const notificationKey = `liftedMessageSent:${user.username}:${event.post.id}`;

        logger.debug(
            "Checking if restriction lifted notification already sent",
            {
                notificationKey,
            }
        );

        const notificationSent = await redis.exists(notificationKey);
        if (notificationSent) {
            logger.info("Notification has already been sent, skipping.", {
                notificationKey,
            });
            return;
        }

        logger.debug("Marking notification as sent in Redis", {
            notificationKey,
        });
        await redis.set(notificationKey, "1");

        const subredditName = event.subreddit?.name ?? "";

        logger.debug("Preparing lifted restriction message", {
            awarder,
            subredditName,
        });

        const liftedMsg = formatMessage(
            event,
            (await settings.get<string>("restrictionLiftedMessage")) ?? "",
            { awarder, subreddit: subredditName }
        );

        try {
            logger.info(`Sending restriction lifted PM to u/${user.username}`, {
                preview: liftedMsg.slice(0, 1_000),
            });

            await reddit.sendPrivateMessage({
                to: user.username,
                subject: `Restriction lifted in r/${subredditName}`,
                text: liftedMsg,
            });
            logger.info(
                `✅ Successfully sent restriction lifted PM to u/${user.username}`
            );
        } catch (err) {
            logger.error("❌ Failed to send restriction lifted PM", {
                username: user.username,
                subreddit: subredditName,
                error: err,
            });
        }
        logger.debug(
            `🔓 User ${author.username} already unrestricted — skipping restriction counter`
        );
        return;
    }

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

    const notificationKey = `liftedMessageSent:${user.username}:${event.post.id}`;

    logger.debug("Checking if restriction lifted notification already sent", {
        notificationKey,
    });

    const notificationSent = await redis.exists(notificationKey);
    if (notificationSent) {
        logger.info("Notification has already been sent, skipping.", {
            notificationKey,
        });
        return;
    }

    logger.debug("Marking notification as sent in Redis", {
        notificationKey,
    });
    await redis.set(notificationKey, "1");

    const subredditName = event.subreddit?.name ?? "unknown-subreddit";

    logger.debug("Preparing lifted restriction message", {
        awarder,
        subredditName,
    });

    const liftedMsg = formatMessage(
        event,
        (await settings.get<string>("restrictionLiftedMessage")) ?? "",
        { awarder, subreddit: subredditName }
    );

    try {
        logger.info(`Sending restriction lifted PM to u/${user.username}`, {
            subject: `Restriction lifted in r/${subredditName}`,
            preview: liftedMsg.slice(0, 100),
        });

        await reddit.sendPrivateMessage({
            to: user.username,
            subject: `Restriction lifted in r/${subredditName}`,
            text: liftedMsg,
        });

        logger.info(
            `✅ Successfully sent restriction lifted PM to u/${user.username}`
        );
    } catch (err) {
        logger.error("❌ Failed to send restriction lifted PM", {
            username: user.username,
            subreddit: subredditName,
            error: err,
        });
    }
}

/**
 * Executes the user command workflow.
 */
export async function executeUserCommand(
    event: OnCommentCreateRequest | OnCommentUpdateRequest
): Promise<boolean> {
    const parentComment = await getParentComment(event);

    if (
        !event.author ||
        !event.comment ||
        !event.post ||
        !event.subreddit ||
        !parentComment
    ) {
        logger.warn("❌ Missing required event data", { event });
        return false;
    }

    const commentBody = event.comment.body;
    const awarder = event.author.name;
    const recipient = parentComment.authorName;
    const pointName = (await settings.get<string>("pointName")) ?? "point";

    let user: User | undefined;

    try {
        user = await reddit.getUserByUsername(awarder);
    } catch {
        user = undefined;
    }

    if (!user) return false;

    const allTriggers = await getTriggers();

    const triggerUsed = allTriggers.find((t) =>
        new RegExp(`^${t}`, "i").test(commentBody)
    );

    if (!triggerUsed) return false;

    // 🚫 Blocked users
    const blockedUsers = (
        (await settings.get<string>("usersWhoCantAwardPoints")) ?? ""
    )
        .split(/\r?\n/)
        .map((w) => w.trim().toLowerCase())
        .filter(Boolean);

    if (blockedUsers.includes(awarder.toLowerCase())) {
        const blockedTemplate =
            (await settings.get<string>("usersWhoCannotAwardPointsMessage")) ??
            "";

        const notifyBlockedUserMode = await settings.get<string>(
            "notifyOnBlockedUser"
        );

        const blockedMessage = formatMessage(event, blockedTemplate, {
            name: pointName,
            awarder,
            subreddit: event.subreddit.name,
        });

        if (notifyBlockedUserMode === "replyascomment") {
            const userIsBlockedFromAwardingPointsMessage =
                await reddit.submitComment({
                    id: event.comment.id as `t1_${string}`,
                    text: blockedMessage,
                });

            await userIsBlockedFromAwardingPointsMessage.distinguish();
        } else if (notifyBlockedUserMode === "replybypm") {
            await reddit.sendPrivateMessage({
                to: awarder,
                text: blockedMessage,
                subject:
                    `You do not have permission to award ${pointName}s ` +
                    `in r/${event.subreddit.name}`,
            });
        }

        return false;
    }

    // 🛑 Self award check
    if (awarder.toLowerCase() === recipient.toLowerCase()) {
        const selfAwardTemplate = formatMessage(
            event,
            (await settings.get<string>("selfAwardMessage")) ?? "",
            {
                awarder,
                name: pointName,
            }
        );

        const notifyNormalSelfAwardMode = await settings.get<string>(
            "notifyOnSelfAward"
        );

        if (notifyNormalSelfAwardMode === "replyascomment") {
            const selfAwardComment = await reddit.submitComment({
                id: event.comment.id as `t1_${string}`,
                text: selfAwardTemplate,
            });

            await selfAwardComment.distinguish();
        } else if (notifyNormalSelfAwardMode === "replybypm") {
            await reddit.sendPrivateMessage({
                to: awarder,
                text: selfAwardTemplate,
                subject: `You tried to award yourself a ${pointName}`,
            });
        }

        return false;
    }

    let originalPoster: User | undefined;
    try {
        originalPoster = await reddit.getUserByUsername(awarder);
    } catch (err) {
        logger.error(
            `Original poster could not be found in executeUserCommand(), returning`
        );
        return false;
    }

    if (!originalPoster) return false;

    if (recipient === originalPoster.username) {
        const notifyMode = await settings.get<string>(
            "notifyOnPostAuthorAward"
        );
        const formattedPostAuthorAwardMessage = formatMessage(
            event,
            (await settings.get<string>("postAuthorAwardMessage")) ?? "",
            { name: pointName }
        );

        if (notifyMode === "replyascomment") {
            const postAuthorAwardComment = await reddit.submitComment({
                id: event.comment.id as `t1_${string}`,
                text: formattedPostAuthorAwardMessage,
            });
            postAuthorAwardComment.distinguish();
        } else if (notifyMode === "replybypm") {
            await reddit.sendPrivateMessage({
                to: awarder,
                subject: `You do not have permission to award ${pointName}s to Post Authors`,
                text: formattedPostAuthorAwardMessage,
            });
        }
        return false;
    }

    // 🛑 Duplicate award check
    const key = `userAwardGiven:${parentComment.id}:${event.post.id}:${event.subreddit.name}`;

    const alreadyAwarded = await redis.exists(key);

    if (alreadyAwarded) {
        const alreadyAwardedTemplate = formatMessage(
            event,
            (await settings.get<string>("pointAlreadyAwardedToUserMessage")) ??
                "",
            {
                awarder,
                awardee: recipient,
                name: pointName,
            }
        );

        const notifyMode = await settings.get<string>(
            "notifyOnPointAlreadyAwardedToUser"
        );

        if (notifyMode === "replyascomment") {
            const alreadyAwardedMessage = await reddit.submitComment({
                id: event.comment.id as `t1_${string}`,
                text: alreadyAwardedTemplate,
            });

            await alreadyAwardedMessage.distinguish();
        } else if (notifyMode === "replybypm") {
            await reddit.sendPrivateMessage({
                to: awarder,
                subject:
                    `[This comment](${parentComment.permalink}) ` +
                    `has already received a ${pointName}`,
                text: alreadyAwardedTemplate,
            });
        }

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

    // Auto Superuser logic
    const commandUsed =
        (await settings.get<string>("pointTriggerWords")) ?? "!award\n.award";

    const currentScore = (await redis.zScore(POINTS_STORE_KEY, recipient)) ?? 0;

    await handleAutoSuperuserPromotion(event, currentScore, commandUsed);

    return true;
}

export async function commentContainsModCommand(
    event: OnCommentCreateRequest | OnCommentUpdateRequest
): Promise<boolean> {
    if (!event.comment) return false;

    const allTriggers = await getTriggers();
    const commentBody = event.comment.body ?? "";
    const modCommand = await modCommandValue();

    const triggerUsed = allTriggers.find((t) =>
        new RegExp(`${t}`, "i").test(commentBody)
    );
    if (!triggerUsed) return false;
    const usedCommand = triggerUsed;

    const isModCommand = usedCommand === modCommand;

    logger.info("🛡️ Mod command probe", {
        usedCommand,
        modCommand,
        isModCommand,
    });

    return isModCommand;
}

export async function isSelfAwardModCommand(
    event: OnCommentCreateRequest | OnCommentUpdateRequest
): Promise<boolean> {
    if (!event.author) return true;

    const parent = await getParentComment(event);
    if (!parent) return true;

    return parent.authorName === event.author.name;
}

export async function handleSelfAwardModCommand(
    event: OnCommentCreateRequest | OnCommentUpdateRequest
) {
    const parentComment = await getParentComment(event);
    if (!event.author || !event.comment || !parentComment) return;
    const settingPointName = await settings.get<string>("pointName");
    const settingSelfAwardMessage = await settings.get<string>(
        "selfAwardMessage"
    );
    const pointName = (settingPointName as string) ?? "point";

    const selfMsgTemplate = (settingSelfAwardMessage as string) ?? "none";
    const settingNotifyOnSelfAward = await settings.get<string>(
        "notifyOnSelfAward"
    );
    const awarder = event.author.name;
    const recipient = parentComment.authorName;
    if (awarder === recipient) {
        const selfText = formatMessage(event, selfMsgTemplate, {
            awarder,
            name: pointName,
        });
        if (settingNotifyOnSelfAward === "none") {
            const selfAwardMessage = await reddit.submitComment({
                id: event.comment.id as `t1_${string}`,
                text: selfText,
            });
            await selfAwardMessage.distinguish();
        } else if (settingNotifyOnSelfAward === "replybypm") {
            await reddit.sendPrivateMessage({
                to: awarder,
                subject: `You tried to award yourself a ${pointName}`,
                text: selfText,
            });
        }
        logger.debug("❌ User tried to award themselves.");
        return;
    }

    logger.warn("❌ Mod attempted self-award", { awarder });
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
    const settingPointName = await settings.get<string>("pointName");
    const settingModAwardAlreadyGiven = await settings.get<string>(
        "modAwardAlreadyGiven"
    );
    const settingNotifyOnModAwardFail = await settings.get<string>(
        "notifyOnModAwardFail"
    );
    const pointName = (settingPointName as string) ?? "point";
    const awarder = event.author.name;
    const awardee = parentComment.authorName;

    const modAwardAlreadyGivenMessage = formatMessage(
        event,
        (settingModAwardAlreadyGiven as string) ?? "",
        { awarder, awardee, name: pointName }
    );

    const notify =
        (settingNotifyOnModAwardFail as string | undefined) ?? "none";

    if (notify === "replyascomment") {
        const modAwardDupeMessage = await reddit.submitComment({
            id: event.comment!.id as `t1_${string}`,
            text: modAwardAlreadyGivenMessage,
        });
        await modAwardDupeMessage.distinguish();
    } else if (notify === "replybypm") {
        await reddit.sendPrivateMessage({
            to: awarder,
            subject: "Mod award already given",
            text: modAwardAlreadyGivenMessage,
        });
    }

    logger.info("❌ Duplicate mod award blocked", { awarder });
}

export async function handleUnauthorizedModCommand(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,

    trigger: string
): Promise<boolean> {
    const ctx = new CommentTriggerContext();
    await ctx.init(event);

    if (ctx.isMod || ctx.isSuperUser) return true;

    const settingPointName = await settings.get<string>("pointName");
    const settingNotifyOnModAwardFail = await settings.get<string>(
        "notifyOnModAwardFail"
    );
    const settingModAwardCommandFail = await settings.get<string>(
        "modAwardCommandFail"
    );
    const awarder = event.author!.name;
    const pointName = (settingPointName as string) ?? "point";

    const failMsg = formatMessage(
        event,
        (settingModAwardCommandFail as string) ?? "",
        {
            command: trigger,
            name: pointName,
            awarder,
        }
    );

    const notify =
        (settingNotifyOnModAwardFail as string | undefined) ?? "none";

    if (notify === "replyascomment") {
        const modAwardFailMessage = await reddit.submitComment({
            id: event.comment!.id as `t1_${string}`,
            text: failMsg,
        });
        await modAwardFailMessage.distinguish();
    } else if (notify === "replybypm") {
        await reddit.sendPrivateMessage({
            to: awarder,
            subject: "Mod Award Command Not Allowed",
            text: failMsg,
        });
    }

    logger.warn("🚫 Unauthorized mod command", { awarder });
    return false;
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
    const settingNotifyOnModAwardSuccess = await settings.get<string>(
        "notifyOnModAwardSuccess"
    );
    const settingNotifyOnTrustedUserAwardSuccess = await settings.get<string>(
        "notifyOnTrustedUserAwardSuccess"
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

    let flairShouldBeManaged: boolean;

    const key = `flairToggle:${awardee}`;
    const exists = await redis.exists(key);

    if (exists) {
        flairShouldBeManaged = false;
    } else {
        flairShouldBeManaged = true;
    }

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

    // ⭐ Auto-superuser logic
    const modCommand = (settingModAwardCommand as string) ?? "";
    await handleAutoSuperuserPromotion(event, newScore.score, modCommand);

    // 📣 Notify on success
    const modNotifyMode =
        (settingNotifyOnModAwardSuccess as string | undefined) ?? "none";
    const trustedUserNotifyMode =
        (settingNotifyOnTrustedUserAwardSuccess as string | undefined) ??
        "none";

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

    await scheduler.runJob({
        name: UPDATE_LEADERBOARD_JOB,
        runAt: new Date(),
        data: {
            reason: `Updated score for ${awardee}. Triggered by mod command.`,
        },
    });

    const awardeePage = `https://old.reddit.com/r/${event.subreddit.name}/wiki/user/${awardee}/1`;
    const awarderPage = `https://old.reddit.com/r/${event.subreddit.name}/wiki/user/${awarder}/1`;
    const modSuccessMessage = formatMessage(event, modSuccessTemplate, {
        awardee,
        awarder,
        total: newScore.score.toString(),
        name: pointName,
        symbol: (settingPointSymbol as string) ?? "",
        leaderboard,
        awardeePage,
        awarderPage,
    });

    const trustedUserMessage = formatMessage(
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

    if (modNotifyMode !== "none" && awarderIsModerator) {
        if (modNotifyMode === "replyascomment") {
            const modAwardSuccessMessage = await reddit.submitComment({
                id: event.comment.id as `t1_${string}`,
                text: modSuccessMessage,
            });
            await modAwardSuccessMessage.distinguish();
        } else if (modNotifyMode === "replybypm") {
            await reddit.sendPrivateMessage({
                to: awarder,
                subject: "Mod Award Successful",
                text: modSuccessMessage,
            });
        }
        logger.info("🛡️ Mod award successful", {
            awarder,
            awardee,
            newScore,
        });
    } else if (trustedUserNotifyMode !== "none" && awarderIsSuperUser) {
        if (trustedUserNotifyMode === "replyascomment") {
            const trustedUserSuccessComment = await reddit.submitComment({
                id: event.comment.id as `t1_${string}`,
                text: trustedUserMessage,
            });
            await trustedUserSuccessComment.distinguish();
        } else if (trustedUserNotifyMode === "replybypm") {
            await reddit.sendPrivateMessage({
                to: awarder,
                subject: "Superuser Award Successful",
                text: trustedUserMessage,
            });
        }
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
    event: OnCommentCreateRequest | OnCommentUpdateRequest
): Promise<boolean> {
    if (!event.comment || !event.author || !event.post) {
        return false;
    }

    const awarder = event.author.name;

    let user: User | undefined;

    try {
        user = await reddit.getUserByUsername(awarder);
    } catch {
        user = undefined;
    }

    if (!user) {
        return false;
    }

    const body = (event.comment.body ?? "").toLowerCase();

    const triggers = await getTriggers();

    for (const trigger of triggers) {
        if (!new RegExp(trigger, "i").test(body)) {
            continue;
        }

        // if (await handleModIgnoredContextIfNeeded(event , trigger)) {
        //     return false;
        // }

        const isAuthorized = await handleUnauthorizedModCommand(event, trigger);
        if (!isAuthorized) return false;

        if (await isSelfAwardModCommand(event)) {
            await handleSelfAwardModCommand(event);

            return false;
        }

        if (await isDuplicateModAward(event)) {
            await handleDuplicateModAward(event);

            return false;
        }

        await awardPointToUserModCommand(event);

        return true;
    }

    return false;
}

export function getAwardsGivenFromWiki(
    wikiContent: string,
    capPlural: string
): string | undefined {
    const givenHeading = `## ${capPlural} Given`;
    const givenSectionStart = wikiContent.indexOf(givenHeading);

    if (givenSectionStart === -1) {
        return undefined;
    }

    // Only inspect the Given section, not Received.
    const givenSection = wikiContent.slice(givenSectionStart);
    const nextSectionStart = givenSection.indexOf("\n## ", givenHeading.length);

    const section =
        nextSectionStart === -1
            ? givenSection
            : givenSection.slice(0, nextSectionStart);

    const match = section.match(/has given a total of\s+([\d,]+)/i);

    if (!match) {
        logger.warn(
            "Could not find awards given in wiki content, returning undefined"
        );
        return undefined;
    }

    return match[1]?.toString().replaceAll(",", "");
}

async function setFlairForUser(
    awarder: string,
    awardee: string
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

    const settingPointName = await settings.get<string>("pointName");
    const pointName = settingPointName ?? "point";
    const subredditName = await getSubredditName();
    const safeWiki = new SafeWikiClient(reddit);

    const baseCssClass = settingBaseCSSClass ?? undefined;

    const baseFlairTemplate = settingBaseFlairTemplate ?? undefined;

    const superAwarderCSSClass = settingSuperAwarderCSSClass ?? undefined;

    // Use the base template until a dedicated Super Awarder template setting exists.
    const superAwarderFlairTemplate =
        (await settings.get<string>("superAwarderFlairTemplate")) ?? undefined;

    const flairFormatting = await settings.get<string>("flairFormatting");

    const pointSymbol = (await settings.get<string>("pointSymbol")) ?? "";

    const superAwarderThreshold =
        (await settings.get<number>("superAwarderThreshold")) ?? 0;

    const superAwarderFlairText = await settings.get<string>(
        "superAwarderFlairText"
    );

    const capPlural = escapeMarkdownText(capitalize(pluralize(pointName)));

    // Initialize the cached awards-given count from the latest wiki page
    // if it doesn't exist yet.
    const getOrInitializeAwardsGiven = async (
        username: string
    ): Promise<number> => {
        const redisKey = `awardsGiven:${username}`;
        const cached = await redis.get(redisKey);

        if (cached && cached !== null && cached !== "") {
            const parsed = Number.parseInt(cached, 10);
            return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
        }

        let count = 0;
        const latestPage = await getStoredLatestPage(username);

        if (!latestPage) {
            logger.warn("Couldn't find latest stored wiki page for user", {
                username,
            });
        } else {
            const wikiPage = await safeWiki.getWikiPage(
                subredditName,
                getNumberedUserWikiPath(username, latestPage)
            );

            if (!wikiPage) {
                logger.warn("User wiki page not found", {
                    username,
                    latestPage,
                });
            } else {
                const parsed = getAwardsGivenFromWiki(
                    wikiPage.content,
                    capPlural
                );

                const value = Number.parseInt(parsed ?? "0", 10);
                count = Number.isFinite(value) && value >= 0 ? value : 0;
            }
        }

        await redis.set(redisKey, count.toString());
        return count;
    };

    // The awarder gets credit for this award:
    // - If their cache already exists, increment it.
    // - Otherwise initialize it from their wiki without incrementing it.
    const awarderAwardsGivenKey = `awardsGiven:${awarder}`;
    const cachedAwarderCount = await redis.get(awarderAwardsGivenKey);

    if (
        cachedAwarderCount &&
        cachedAwarderCount !== null &&
        cachedAwarderCount !== ""
    ) {
        const parsed = Number.parseInt(cachedAwarderCount, 10);
        const currentCount =
            Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;

        await redis.set(awarderAwardsGivenKey, (currentCount + 1).toString());
    } else {
        await getOrInitializeAwardsGiven(awarder);
    }

    // Get the received-points leaderboard once for both users.
    const leaderboard = await redis.zRange(POINTS_STORE_KEY, 0, -1, {
        by: "rank",
        reverse: true,
    });

    // If both names are the same, only update that user once.
    const usernames = [...new Set([awarder, awardee])];

    for (const username of usernames) {
        try {
            // Respect each user's own flair opt-out.
            const flairDisabled = await redis.exists(`flairToggle:${username}`);

            if (flairDisabled) {
                logger.info("Skipping flair update because user opted out", {
                    username,
                });
                continue;
            }

            // Received-points total and leaderboard position.
            const score = (await redis.zScore(POINTS_STORE_KEY, username)) ?? 0;

            const index = leaderboard.findIndex(
                (member: { member: string; score: number }) =>
                    member.member === username
            );

            const userRank = index >= 0 ? index + 1 : undefined;
            const placeText = userRank?.toString() ?? "N/A";

            // Determine Super Awarder status independently for each user.
            // This means receiving points won't remove their title.
            const awardsGiven = await getOrInitializeAwardsGiven(username);

            const isSuperAwarder =
                superAwarderThreshold > 0 &&
                awardsGiven >= superAwarderThreshold;

            let flairText = isSuperAwarder
                ? superAwarderFlairText
                : flairFormatting;

            let cssClass = isSuperAwarder
                ? superAwarderCSSClass ?? baseCssClass
                : baseCssClass;

            const flairTemplate = isSuperAwarder
                ? superAwarderFlairTemplate
                : baseFlairTemplate;

            // Replace both supported placeholder styles.
            const replacements: Record<string, string> = {
                place: placeText,
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
                    flairText = flairText.replaceAll(placeholder, value);
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
    newScore: ScoreResult
): Promise<void> {
    /**
     * POINTS_STORE_KEY is the single source of truth.
     *
     * member = username
     * score  = user's point total
     */
    const settingPointName = await settings.get<string>("pointName");
    const settingExistingFlairHandling = await settings.get<string>(
        "existingFlairHandling"
    );

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

    // Queue a leaderboard update.

    if (!(await redis.get(`awardsGiven:${awarder}`))) {
        const safeWiki = new SafeWikiClient(reddit);
        const subredditName = await getSubredditName();
        const latestPage = await discoverLatestPage(
            subredditName,
            awarder,
            safeWiki
        );
        const pointName = settingPointName ?? "point";
        const capPlural = escapeMarkdownText(capitalize(pluralize(pointName)));

        for (let pageNumber = 1; pageNumber <= latestPage; pageNumber += 1) {
            const awarderWiki = await safeWiki.getWikiPage(
                subredditName,
                getNumberedUserWikiPath(awarder, pageNumber)
            );

            if (!awarderWiki) {
                logger.error("Couldn't retrieve awarder wiki, skipping page", {
                    awarder,
                    pageNumber,
                });
                continue;
            }

            const awardsGiven = getAwardsGivenFromWiki(
                awarderWiki.content,
                capPlural
            );

            if (awardsGiven !== undefined) {
                await redis.set(`awardsGiven:${awarder}`, awardsGiven);
            } else {
                await redis.set(`awardsGiven:${awarder}`, "1");
            }
        }
    }

    const awarderScore = (await redis.get(`awardsGiven:${awarder}`)) ?? "0";

    await scheduler.runJob({
        name: UPDATE_LEADERBOARD_JOB,
        runAt: new Date(),
        data: {
            reason: `Updated score for ${awardee} and ${awarder}. Awardee Score: ${newScore.score}. Awarder Score: ${awarderScore}.`,
        },
    });

    // Respect the configured existing-flair overwrite behavior.

    let shouldSetUserFlair: boolean;

    if (
        settingExistingFlairHandling === "overwritenumericsymbol" ||
        settingExistingFlairHandling === "overwritenumeric"
    ) {
        shouldSetUserFlair = true;
    } else if (settingExistingFlairHandling === "neverset") {
        shouldSetUserFlair = false;
    } else {
        shouldSetUserFlair =
            !newScore.userHasFlair ||
            newScore.flairIsNumber ||
            newScore.flairShouldBeManaged;
    }

    if (!shouldSetUserFlair) {
        logger.debug(
            "Flair not set because existing flair should be preserved",
            {
                awardee,
                awarder,
                existingFlairOverwriteHandling: settingExistingFlairHandling,
            }
        );
        return;
    }

    if (!context.subredditName) {
        logger.error("❌ No subreddit name found in  cannot set user flair");
        return;
    }

    // Set the recipient's flair using values fetched individually from Devvit Web settings.
    await setFlairForUser(awarder, awardee);
}

export async function handleClientCommentCreate(event: OnCommentCreateRequest) {
    if (!event.post || !event.author || !event.comment) {
        logger.warn("❌ Missing required event data", { event });
        return;
    }

    if (
        event.author.name === "AutoModerator" ||
        event.author.name === `${context.subredditName}-ModTeam` ||
        event.author.name === context.appSlug
    ) {
        return;
    }

    // ─────────────────────────────────────────────
    // Initialize context
    // ─────────────────────────────────────────────
    const commentTriggerContext = new CommentTriggerContext();
    await commentTriggerContext.init(event);

    const parentComment: Comment | undefined = await getParentComment(event);
    if (!parentComment) {
        logger.warn("❌ Parent comment not found", {
            commentId: event.comment.id,
        });
        return;
    }

    const settingPointName = await settings.get<string>("pointName");
    const settingNotifyOnPostAuthorAward = await settings.get<string>(
        "notifyOnPostAuthorAward"
    );
    const settingPostAuthorAwardMessage =
        (await settings.get<string>("postAuthorAwardMessage")) ?? "";
    const settingModAwardCommandFail =
        (await settings.get<string>("modAwardCommandFail")) ?? "";
    const awarder = event.author.name;
    const commentBody = event.comment.body.toLowerCase();
    const triggers = await getTriggers();
    const triggerUsed = triggers.find((t) => commentBody.includes(t));
    const pointName = (settingPointName as string) ?? "point";
    if (!triggerUsed) {
        logger.debug("❌ No valid award command found.");
        return;
    }

    const ignoredType = getIgnoredContextType(event.comment.body, triggerUsed);

    const IgnoredContextNeedsHandling = await ignoredContextNeedsHandling(
        event,
        triggerUsed
    );
    if (ignoredType) {
        logger.info(`ignoredType exists in comment`, { ignoredType });
        if (IgnoredContextNeedsHandling) {
            logger.info(`Running handleIgnoredContext()`, {
                IgnoredContextNeedsHandling,
            });
            await handleIgnoredContext(event, triggerUsed);
            return;
        } else {
            logger.info(`Ignored context doesn't need handling`);
            return;
        }
    }

    const awardee = parentComment.authorName;
    if (!awardee) {
        logger.warn("❌ No recipient found", { parentComment });
        return;
    }

    let recipient: User | undefined;

    try {
        recipient = await reddit.getUserByUsername(awardee);
    } catch {
        recipient = undefined;
    }
    if (!recipient) {
        logger.warn("❌ Could not fetch user object for recipient", {
            recipient: awardee,
        });
        return;
    }

    const existingScore = await getCurrentScore(recipient);
    if (!existingScore) {
        logger.warn("❌ Could not fetch existing score for recipient", {
            recipient: awardee,
        });
        return;
    }

    const isMod = commentTriggerContext.isMod;
    const isSuperUser = commentTriggerContext.isSuperUser;
    const userCanAward = commentTriggerContext.userCanAward;

    // ─────────────────────────────────────────────
    // Access control enforcement
    // ─────────────────────────────────────────────
    let user: User | undefined;

    try {
        user = await reddit.getUserByUsername(awarder);
    } catch {
        user = undefined;
    }
    if (!user) {
        logger.warn("❌ Could not fetch user object for awarder", { awarder });
        return;
    }

    const hasPermission = await userHasPermission(
        event,
        user.id,
        commentTriggerContext
    );

    if (!hasPermission) {
        logger.debug("❌ User does not have permission", {
            awarder,
            commentId: event.comment.id,
        });

        return;
    }

    // ─────────────────────────────────────────────
    // Detect which command type exists
    // ─────────────────────────────────────────────

    const containsMod = await commentContainsModCommand(event);
    const containsUser = await commentContainsUserCommand(event);

    logger.debug("Checking values", {
        trigger: triggerUsed,
        containsMod,
        containsUser,
    });

    await unflairedPostLogic(event, awarder);

    await flairTextNotAllowedLogic(event, awarder, commentBody, triggerUsed);

    await selfAwardAttemptLogic(event, awarder, awardee);

    await recipientIsBot(event, awarder, awardee);

    // ─────────────────────────────────────────────
    // Normal user command logic
    // ─────────────────────────────────────────────

    if (containsUser && !containsMod) {
        if (!userCanAward) {
            logger.debug("❌ User blocked from awarding points", { awarder });
            return;
        }
        const handled = await executeUserCommand(event);
        // Trigger leaderboard update
        if (handled) {
            await scheduler.runJob({
                name: UPDATE_LEADERBOARD_JOB,
                runAt: new Date(),
                data: {
                    reason: `Updated score for ${user.username}. Triggered by user command.`,
                },
            });
            logger.info("✅ User command executed successfully");
            return;
        } else {
            logger.debug("❌ User command detected but not handled");
        }
        return;
    }

    // ─────────────────────────────────────────────
    // Mod command logic
    // ─────────────────────────────────────────────
    if (containsMod && !containsUser) {
        if (isMod || isSuperUser) {
            //recipient is OP
            let originalPoster: User | undefined;
            try {
                originalPoster = await reddit.getUserById(
                    event.post.authorId as T2
                );
            } catch (err) {
                logger.error(
                    `Original poster could not be found in executeUserCommand(), returning`
                );
                return;
            }

            if (!originalPoster) return;

            if (recipient.username === originalPoster.username) {
                const notifyMode = settingNotifyOnPostAuthorAward;
                const formattedPostAuthorAwardMessage = formatMessage(
                    event,
                    settingPostAuthorAwardMessage,
                    { name: pointName }
                );

                if (notifyMode === "replybycomment") {
                    const postAuthorAwardComment = await reddit.submitComment({
                        id: event.comment.id as T1,
                        text: formattedPostAuthorAwardMessage,
                    });
                    postAuthorAwardComment.distinguish();
                } else if (notifyMode === "replybypm") {
                    await reddit.sendPrivateMessage({
                        to: awarder,
                        subject: `You do not have permission to award ${pointName}s to Post Authors`,
                        text: formattedPostAuthorAwardMessage,
                    });
                }
                return;
            }

            const handled = await executeModCommand(event);
            // Trigger leaderboard update
            if (handled) {
                await scheduler.runJob({
                    name: UPDATE_LEADERBOARD_JOB,
                    runAt: new Date(),
                    data: {
                        reason: `Updated score for ${user.username}. Triggered by mod command.`,
                    },
                });
                logger.info("✅ Mod command executed successfully");
                return;
            }
        } else {
            const command = await modCommandValue();
            //send message saying no perms
            // ModAwardCommandFailMessage
            const modAwardFailMsg = formatMessage(
                event,
                settingModAwardCommandFail,
                {
                    awarder,
                    awardee,
                    command,
                }
            );

            const settingNotifyOnModAwardFail = await settings.get<string>(
                "notifyOnModAwardFail"
            );
            const notify = (settingNotifyOnModAwardFail ?? ["none"])[0];

            if (notify === "replybypm") {
                await reddit.sendPrivateMessage({
                    to: awarder,
                    text: modAwardFailMsg,
                    subject: "Unsuccessful Award",
                });
            } else if (notify === "replybycomment") {
                const modAwardFailComment = await reddit.submitComment({
                    id: event.comment.id as T1,
                    text: modAwardFailMsg,
                });

                await modAwardFailComment.distinguish();
            }
        }
    }

    // ─────────────────────────────────────────────
    // Fallback unexpected flow
    // ─────────────────────────────────────────────
    logger.error("Unexpected command flow detected", {
        containsMod,
        containsUser,
        awarder,
        commentId: event.comment.id,
    });
}

export async function handleClientCommentUpdate(event: OnCommentUpdateRequest) {
    if (!event.post || !event.author || !event.comment) {
        logger.warn("❌ Missing required event data", { event });
        return;
    }

    if (
        event.author.name === "AutoModerator" ||
        event.author.name === `${context.subredditName}-ModTeam` ||
        event.author.name === context.appSlug
    ) {
        return;
    }

    // ─────────────────────────────────────────────
    // Initialize context
    // ─────────────────────────────────────────────
    const commentTriggerContext = new CommentTriggerContext();
    await commentTriggerContext.init(event);

    const parentComment: Comment | undefined = await getParentComment(event);
    if (!parentComment) {
        logger.warn("❌ Parent comment not found", {
            commentId: event.comment.id,
        });
        return;
    }

    const settingPointName = await settings.get<string>("pointName");
    const settingNotifyOnPostAuthorAward = await settings.get<string>(
        "notifyOnPostAuthorAward"
    );
    const settingPostAuthorAwardMessage =
        (await settings.get<string>("postAuthorAwardMessage")) ?? "";
    const settingModAwardCommandFail =
        (await settings.get<string>("modAwardCommandFail")) ?? "";
    const awarder = event.author.name;
    const commentBody = event.comment.body.toLowerCase();
    const triggers = await getTriggers();
    const triggerUsed = triggers.find((t) => commentBody.includes(t));
    const pointName = (settingPointName as string) ?? "point";
    if (!triggerUsed) {
        logger.debug("❌ No valid award command found.");
        return;
    }

    const ignoredType = getIgnoredContextType(event.comment.body, triggerUsed);

    const IgnoredContextNeedsHandling = await ignoredContextNeedsHandling(
        event,
        triggerUsed
    );
    if (ignoredType) {
        logger.info(`ignoredType exists in comment`, { ignoredType });
        if (IgnoredContextNeedsHandling) {
            logger.info(`Running handleIgnoredContext()`, {
                IgnoredContextNeedsHandling,
            });
            await handleIgnoredContext(event, triggerUsed);
            return;
        } else {
            logger.info(`Ignored context doesn't need handling`);
            return;
        }
    }

    const awardee = parentComment.authorName;
    if (!awardee) {
        logger.warn("❌ No recipient found", { parentComment });
        return;
    }

    let recipient: User | undefined;

    try {
        recipient = await reddit.getUserByUsername(awardee);
    } catch {
        recipient = undefined;
    }
    if (!recipient) {
        logger.warn("❌ Could not fetch user object for recipient", {
            recipient: awardee,
        });
        return;
    }

    const existingScore = await getCurrentScore(recipient);
    if (!existingScore) {
        logger.warn("❌ Could not fetch existing score for recipient", {
            recipient: awardee,
        });
        return;
    }

    const isMod = commentTriggerContext.isMod;
    const isSuperUser = commentTriggerContext.isSuperUser;
    const userCanAward = commentTriggerContext.userCanAward;

    // ─────────────────────────────────────────────
    // Access control enforcement
    // ─────────────────────────────────────────────
    let user: User | undefined;

    try {
        user = await reddit.getUserByUsername(awarder);
    } catch {
        user = undefined;
    }
    if (!user) {
        logger.warn("❌ Could not fetch user object for awarder", { awarder });
        return;
    }

    const hasPermission = await userHasPermission(
        event,
        user.id,
        commentTriggerContext
    );

    if (!hasPermission) {
        logger.debug("❌ User does not have permission", {
            awarder,
            commentId: event.comment.id,
        });

        return;
    }

    // ─────────────────────────────────────────────
    // Detect which command type exists
    // ─────────────────────────────────────────────

    const containsMod = await commentContainsModCommand(event);
    const containsUser = await commentContainsUserCommand(event);

    logger.debug("Checking values", {
        trigger: triggerUsed,
        containsMod,
        containsUser,
    });

    await unflairedPostLogic(event, awarder);

    await flairTextNotAllowedLogic(event, awarder, commentBody, triggerUsed);

    await selfAwardAttemptLogic(event, awarder, awardee);

    await recipientIsBot(event, awarder, awardee);

    // ─────────────────────────────────────────────
    // Normal user command logic
    // ─────────────────────────────────────────────

    if (containsUser && !containsMod) {
        if (!userCanAward) {
            logger.debug("❌ User blocked from awarding points", { awarder });
            return;
        }
        const handled = await executeUserCommand(event);
        // Trigger leaderboard update
        if (handled) {
            await scheduler.runJob({
                name: UPDATE_LEADERBOARD_JOB,
                runAt: new Date(),
                data: {
                    reason: `Updated score for ${user.username}. Triggered by user command.`,
                },
            });
            logger.info("✅ User command executed successfully");
            return;
        } else {
            logger.debug("❌ User command detected but not handled");
        }
        return;
    }

    // ─────────────────────────────────────────────
    // Mod command logic
    // ─────────────────────────────────────────────
    if (containsMod && !containsUser) {
        if (isMod || isSuperUser) {
            //recipient is OP
            let originalPoster: User | undefined;
            try {
                originalPoster = await reddit.getUserById(
                    event.post.authorId as T2
                );
            } catch (err) {
                logger.error(
                    `Original poster could not be found in executeUserCommand(), returning`
                );
                return;
            }

            if (!originalPoster) return;

            if (recipient.username === originalPoster.username) {
                const notifyMode = settingNotifyOnPostAuthorAward;
                const formattedPostAuthorAwardMessage = formatMessage(
                    event,
                    settingPostAuthorAwardMessage,
                    { name: pointName }
                );

                if (notifyMode === "replybycomment") {
                    const postAuthorAwardComment = await reddit.submitComment({
                        id: event.comment.id as T1,
                        text: formattedPostAuthorAwardMessage,
                    });
                    postAuthorAwardComment.distinguish();
                } else if (notifyMode === "replybypm") {
                    await reddit.sendPrivateMessage({
                        to: awarder,
                        subject: `You do not have permission to award ${pointName}s to Post Authors`,
                        text: formattedPostAuthorAwardMessage,
                    });
                }
                return;
            }

            const handled = await executeModCommand(event);
            // Trigger leaderboard update
            if (handled) {
                await scheduler.runJob({
                    name: UPDATE_LEADERBOARD_JOB,
                    runAt: new Date(),
                    data: {
                        reason: `Updated score for ${user.username}. Triggered by mod command.`,
                    },
                });
                logger.info("✅ Mod command executed successfully");
                return;
            }
        } else {
            const command = await modCommandValue();
            //send message saying no perms
            // ModAwardCommandFailMessage
            const modAwardFailMsg = formatMessage(
                event,
                settingModAwardCommandFail,
                {
                    awarder,
                    awardee,
                    command,
                }
            );

            const settingNotifyOnModAwardFail = await settings.get<string>(
                "notifyOnModAwardFail"
            );
            const notify = (settingNotifyOnModAwardFail ?? ["none"])[0];

            if (notify === "replybypm") {
                await reddit.sendPrivateMessage({
                    to: awarder,
                    text: modAwardFailMsg,
                    subject: "Unsuccessful Award",
                });
            } else if (notify === "replybycomment") {
                const modAwardFailComment = await reddit.submitComment({
                    id: event.comment.id as T1,
                    text: modAwardFailMsg,
                });

                await modAwardFailComment.distinguish();
            }
        }
    }

    // ─────────────────────────────────────────────
    // Fallback unexpected flow
    // ─────────────────────────────────────────────
    logger.error("Unexpected command flow detected", {
        containsMod,
        containsUser,
        awarder,
        commentId: event.comment.id,
    });
}

export async function unflairedPostLogic(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,

    awarder: string
) {
    const settingAllowUnflairedPosts = await settings.get<boolean>(
        "allowUnflairedPosts"
    );
    const settingUnflairedPostMessage = await settings.get<string>(
        "unflairedPostMessage"
    );

    if (!event.post || !event.comment || !event.author || !event.subreddit)
        return;

    const allowUnflairedPosts = settingAllowUnflairedPosts ?? true;

    const unflairedMessage = settingUnflairedPostMessage ?? "";

    const settingNotifyOnUnflairedPost = await settings.get<string>(
        "notifyOnUnflairedPost"
    );
    const notifyUnflaired = (settingNotifyOnUnflairedPost ?? ["none"])[0];

    if (!event.post.linkFlair) {
        logger.error(`linkFlair doesn't exist`, {
            linkFlair: event.post.linkFlair,
        });
        return;
    }

    const postFlairText = event.post.linkFlair?.text?.trim();

    // 🚫 Unflaired posts not allowed
    if (!allowUnflairedPosts && postFlairText === "") {
        // 🚫 Ignore bot’s own comments to prevent loops
        if (event.author.name === context.appSlug) {
            logger.debug(
                "🤖 Bot-authored comment detected; skipping unflaired-post response"
            );
            return;
        }

        // 🔑 One response per award attempt (per comment)
        const responseKey = `unflairedResponse:${event.comment.id}`;

        if (await redis.exists(responseKey)) {
            logger.debug("ℹ️ Unflaired post response already sent — skipping", {
                commentId: event.comment.id,
            });
            return;
        }

        logger.info("🚫 Award blocked — post is unflaired", {
            awarder,
            postId: event.post.id,
            commentId: event.comment.id,
            notifyUnflaired,
        });

        try {
            if (notifyUnflaired === "replybypm") {
                await reddit.sendPrivateMessage({
                    to: awarder,
                    subject: `Awards disabled for unflaired posts`,
                    text: unflairedMessage,
                });
            } else if (notifyUnflaired === "replybycomment") {
                const unflairedPostMessage = await reddit.submitComment({
                    id: event.comment.id as `t1_${string}`,
                    text: unflairedMessage,
                });
                await unflairedPostMessage.distinguish();
            }
        } catch (err) {
            logger.error(
                "❌ Failed to notify user about unflaired post restriction",
                { awarder, commentId: event.comment.id, err }
            );
        }

        await redis.set(responseKey, "1");
        return; // ⛔ Stop award flow ONLY for unflaired posts
    }
}

export async function flairTextNotAllowedLogic(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,

    awarder: string,
    commentBody: string,
    triggerUsed: string
) {
    const settingDisallowedFlairMessage = await settings.get<string>(
        "disallowedFlairMessage"
    );
    const settingDisallowedFlairs = await settings.get<string>(
        "disallowedFlairs"
    );
    const settingPointName = await settings.get<string>("pointName");

    if (!event.post || !event.comment || !event.author) return;
    const pointName = settingPointName ?? "point";
    const flairTextDisallowedMessage = formatMessage(
        event,
        settingDisallowedFlairMessage ?? "",
        { name: pointName }
    );
    const postFlairText = event.post.linkFlair?.text?.trim();

    const settingNotifyOnDisallowedFlair = await settings.get<string>(
        "notifyOnDisallowedFlair"
    );
    const notifyFlairIgnored = (settingNotifyOnDisallowedFlair ?? ["none"])[0];

    // ─────────────────────────────────────────────
    // Disallowed flair guard (non-terminating)
    // ─────────────────────────────────────────────

    if (!settingDisallowedFlairs) {
        logger.error(`Disallowed flairs setting doesn't exist, returning`);
        return;
    }
    if (settingDisallowedFlairs.includes(postFlairText ?? "")) {
        logger.error(
            `User attempted to award points on flair-disallowed post, but it's not allowed`,
            { linkFlair: event.post.linkFlair }
        );
        return;
    }

    if (!postFlairText) return;

    const rawDisallowedFlairs = settingDisallowedFlairs ?? "";

    const disallowedFlairs = rawDisallowedFlairs
        .split(/\r?\n/) // newline-only entries
        .map((flair) => flair.trim())
        .filter(Boolean);

    if (
        disallowedFlairs.length !== 0 &&
        disallowedFlairs.includes(postFlairText)
    ) {
        logger.debug("🔍 Disallowed flair check", {
            postFlair: postFlairText,
            disallowedFlairs,
        });

        if (!triggerUsed || !commentBody.includes(triggerUsed)) {
            logger.info(`Comment in disallowed flair, but not a command`);
            return;
        }

        if (event.author.name === context.appSlug) {
            // 🚫 Ignore bot’s own comments to prevent loops
            logger.debug(
                "🤖 Bot-authored comment detected; skipping disallowed flair response"
            );
            return;
        }

        const responseKey = `disallowedFlairResponse:${event.comment.id}`;

        if (await redis.exists(responseKey)) {
            logger.debug(
                "♻️ Disallowed flair already handled for this comment",
                {
                    commentId: event.comment.id,
                }
            );
            return;
        }

        // Mark handled BEFORE replying
        await redis.set(responseKey, "1");

        logger.info("🚫 Award blocked due to disallowed flair", {
            postFlair: postFlairText,
        });

        if (notifyFlairIgnored === "replybypm") {
            await reddit.sendPrivateMessage({
                to: awarder,
                subject: `${pointName}s cannot be awarded on ${event.post.title}`,
                text: flairTextDisallowedMessage,
            });
        } else if (notifyFlairIgnored === "replybycomment") {
            const disallowedFlairMessage = await reddit.submitComment({
                id: event.comment.id as `t1_${string}`,
                text: flairTextDisallowedMessage,
            });
            await disallowedFlairMessage.distinguish();
        }
        return; // ⛔ block award
    }
}

export async function selfAwardAttemptLogic(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    awarder: string,
    recipient: string
) {
    const settingPointName = await settings.get<string>("pointName");
    const settingSelfAwardMessage = await settings.get<string>(
        "selfAwardMessage"
    );

    if (!event.comment || !event.author) return;
    const pointName = settingPointName ?? "point";
    const selfMsgTemplate = settingSelfAwardMessage ?? "";
    const settingNotifyOnSelfAward = await settings.get<string>(
        "notifyOnSelfAward"
    );
    const notifySelf = (settingNotifyOnSelfAward ?? ["none"])[0];
    if (awarder === recipient) {
        const selfText = formatMessage(event, selfMsgTemplate, {
            awarder,
            name: pointName,
        });
        if (notifySelf === "replybycomment") {
            const selfAwardMessage = await reddit.submitComment({
                id: event.comment.id as `t1_${string}`,
                text: selfText,
            });
            await selfAwardMessage.distinguish();
        } else if (notifySelf === "replybypm") {
            await reddit.sendPrivateMessage({
                to: awarder,
                subject: `You tried to award yourself a ${pointName}`,
                text: selfText,
            });
        }
        logger.debug("❌ User tried to award themselves.");
        return;
    }
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
    awarderID: string,
    commentTriggerContext: CommentTriggerContext
): Promise<boolean> {
    const settingPointName = await settings.get<string>("pointName");

    if (!event.post || !event.comment) return false;

    const pointName = settingPointName ?? "point";

    const isMod = commentTriggerContext.isMod;
    const isSuperUser = commentTriggerContext.isSuperUser;
    const isOP = awarderID === event.post.authorId;

    const settingAccessControl = await settings.get<string[]>("accessControl");
    const accessControl = settingAccessControl ?? ["everyone"];

    const hasPermission =
        accessControl.includes("everyone") ||
        (accessControl.includes("moderators-only") && isMod) ||
        (accessControl.includes("moderators-and-superusers") &&
            (isMod || isSuperUser)) ||
        (accessControl.includes("moderators-and-op") && (isMod || isOP)) ||
        (accessControl.includes("moderators-superusers-and-op") &&
            (isMod || isSuperUser || isOP));

    logger.debug("Permission check", {
        accessControl,
        isMod,
        isSuperUser,
        isOP,
        hasPermission,
    });

    logger.debug("Permission check", {
        accessControl,
        isMod,
        isSuperUser,
        isOP,
        hasPermission,
    });

    if (!hasPermission) {
        let denyMessageSetting: string | undefined;
        let notifyMode: string | undefined;

        // Read the exact setting names directly. Avoid computed appSettings keys,
        // which hide the actual Devvit Web setting names from type checking.
        switch (accessControl) {
            case ["moderators-only"]:
                denyMessageSetting = await settings.get<string>(
                    "modOnlyDisallowedMessage"
                );
                notifyMode = await settings.get<string>(
                    "notifyOnModOnlyDisallowed"
                );
                break;

            case ["moderators-and-superusers"]:
                denyMessageSetting = await settings.get<string>(
                    "approvedOnlyDisallowedMessage"
                );
                notifyMode = await settings.get<string>(
                    "notifyOnApprovedOnlyDisallowed"
                );
                break;

            case ["moderators-superusers-and-op"]:
                denyMessageSetting = await settings.get<string>(
                    "opOnlyDisallowedMessage"
                );
                notifyMode = await settings.get<string>(
                    "notifyOnOPOnlyDisallowed"
                );
                break;

            case ["moderators-and-op"]:
                denyMessageSetting = await settings.get<string>(
                    "modsAndPostAuthorDisallowedMessage"
                );
                notifyMode = await settings.get<string>(
                    "notifyOnModsAndPostAuthorDisallowed"
                );
                break;
            default:
                logger.warn("⚠️ Unknown accessControl value", {
                    accessControl,
                });
                return false;
        }

        const denyMsg = formatMessage(event, denyMessageSetting ?? "", {
            awarder: awarderID,
            name: pointName,
        });

        await replyToUser(
            notifyMode ?? "none",
            awarderID,
            denyMsg,
            event.comment.id
        );

        return false;
    }

    return true;
}

export async function recipientIsBot(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    awarder: string,
    recipient: string
) {
    const settingBotAwardMessage = await settings.get<string>(
        "botAwardMessage"
    );
    const settingPointName = await settings.get<string>("pointName");

    if (!event.comment) return;
    const pointName = settingPointName ?? "point";
    if (
        ["automoderator", context.appSlug.toLowerCase()].includes(
            awarder.toLowerCase()
        )
    ) {
        logger.debug("❌ System user attempted a command");
        return;
    }

    if (
        ["automoderator", context.appSlug.toLowerCase()].includes(
            recipient.toLowerCase()
        )
    ) {
        // Prevent bot account or Automod granting points
        const botAwardMessage = formatMessage(
            event,
            settingBotAwardMessage ?? "",
            { name: pointName, awardee: recipient }
        );

        const awardGivenToBotMessage = await reddit.submitComment({
            id: event.comment.id as T1,
            text: botAwardMessage,
        });
        await awardGivenToBotMessage.distinguish();
        logger.debug("❌ Bot cannot award itself points");
        return;
    }
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

    const dmText = formatMessage(
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
    const alreadyConfirmed = await redis.exists(ignoreKey);

    if (alreadyConfirmed) return true;

    return false;
}
