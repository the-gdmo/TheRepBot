import { settings } from "@devvit/web/server";
import type { CommentSubmit, CommentUpdate } from "@devvit/protos";
import type { TriggerContext, User } from "../../../compat";
import {
    formatMessage,
    getTriggers,
    modCommandValue,
    ScoreResult,
} from "../../utils/common-utilities";
import {
    CommentTriggerContext,
    getParentComment,
} from "../comment-trigger-context";
import { logger } from "../../../logger";
import {
    flairToggleKeyExists,
    getModDupKey,
    POINTS_STORE_KEY,
    setModDupKey,
} from "../../utils/redisKeys";
import {
    getCurrentScore,
    getUserIsSuperuser,
    handleAutoSuperuserPromotion,
} from "../../utils/user-utilities";
import { updateUserWiki } from "../../../leaderboard";
import { isModerator } from "../../../utility";
import { setUserScore } from "../on-comment-trigger";
import { recordDigestPointAward } from "../../utils/digest-stats";
import { UPDATE_LEADERBOARD_JOB } from "../../../constants";

export async function commentContainsModCommand(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext
): Promise<boolean> {
    if (!event.comment) return false;

    const allTriggers = await getTriggers(context);
    const commentBody = event.comment.body ?? "";
    const modCommand = await modCommandValue(context);

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
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext
): Promise<boolean> {
    if (!event.author) return true;

    const parent = await getParentComment(event, context);
    if (!parent) return true;

    return parent.authorName === event.author.name;
}

export async function handleSelfAwardModCommand(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext
) {
    const parentComment = await getParentComment(event, context);
    if (!event.author || !event.comment || !parentComment) return;
    const settingPointName = await settings.get<string>("pointName");
    const settingSelfAwardMessage = await settings.get<string>("selfAwardMessage");
    const pointName = (settingPointName as string) ?? "point";

    const selfMsgTemplate =
        (settingSelfAwardMessage as string) ??
        "none";
    const settingNotifyOnSelfAward = await settings.get<string>("notifyOnSelfAward");
    const awarder = event.author.name;
    const recipient = parentComment.authorName;
    if (awarder === recipient) {
        const selfText = formatMessage(event, selfMsgTemplate, {
            awarder,
            name: pointName,
        });
        if (settingNotifyOnSelfAward === "none") {
            const selfAwardMessage = await context.reddit.submitComment({
                id: event.comment.id,
                text: selfText,
            });
            await selfAwardMessage.distinguish();
        } else if (settingNotifyOnSelfAward === "replybypm") {
            await context.reddit.sendPrivateMessage({
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
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext
): Promise<boolean> {
    const key = await getModDupKey(event, context);
    const exists = await context.redis.exists(key);
    return exists === 1;
}

export async function handleDuplicateModAward(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext
) {
    const parentComment = await getParentComment(event, context);
    if (!parentComment || !event.author || !event.comment) return;
    const settingPointName = await settings.get<string>("pointName");
    const settingModAwardAlreadyGiven = await settings.get<string>("modAwardAlreadyGiven");
    const settingNotifyOnModAwardFail = await settings.get<string>("notifyOnModAwardFail");
    const pointName = (settingPointName as string) ?? "point";
    const awarder = event.author.name;
    const awardee = parentComment.authorName;

    const modAwardAlreadyGivenMessage = formatMessage(
        event,
        (settingModAwardAlreadyGiven as string) ??
            "",
        { awarder, awardee, name: pointName }
    );

    const notify =
        (settingNotifyOnModAwardFail as string | undefined) ??
        "none";

    if (notify === "replyascomment") {
        const modAwardDupeMessage = await context.reddit.submitComment({
            id: event.comment!.id,
            text: modAwardAlreadyGivenMessage,
        });
        await modAwardDupeMessage.distinguish();
    } else if (notify === "replybypm") {
        await context.reddit.sendPrivateMessage({
            to: awarder,
            subject: "Mod award already given",
            text: modAwardAlreadyGivenMessage,
        });
    }

    logger.info("❌ Duplicate mod award blocked", { awarder });
}

export async function handleUnauthorizedModCommand(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
    trigger: string
): Promise<boolean> {
    const ctx = new CommentTriggerContext();
    await ctx.init(event, context);

    if (ctx.isMod || ctx.isSuperUser) return true;

    const settingPointName = await settings.get<string>("pointName");
    const settingNotifyOnModAwardFail = await settings.get<string>("notifyOnModAwardFail");
    const settingModAwardCommandFail = await settings.get<string>("modAwardCommandFail");
    const awarder = event.author!.name;
    const pointName = (settingPointName as string) ?? "point";

    const failMsg = formatMessage(
        event,
        (settingModAwardCommandFail as string) ??
            "",
        {
            command: trigger,
            name: pointName,
            awarder,
        }
    );

    const notify =
        (settingNotifyOnModAwardFail as string | undefined) ??
        "none";

    if (notify === "replyascomment") {
        const modAwardFailMessage = await context.reddit.submitComment({
            id: event.comment!.id,
            text: failMsg,
        });
        await modAwardFailMessage.distinguish();
    } else if (notify === "replybypm") {
        await context.reddit.sendPrivateMessage({
            to: awarder,
            subject: "Mod Award Command Not Allowed",
            text: failMsg,
        });
    }

    logger.warn("🚫 Unauthorized mod command", { awarder });
    return false;
}

export async function awardPointToUserModCommand(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext
) {
    if (!event.comment || !event.subreddit || !event.author || !event.post) {
        logger.warn("❌ Missing required event data", { event });
        return;
    }
    const settingPointName = await settings.get<string>("pointName");
    const settingModAwardCommand = await settings.get<string>("modAwardCommand");
    const settingNotifyOnModAwardSuccess = await settings.get<string>("notifyOnModAwardSuccess");
    const settingNotifyOnTrustedUserAwardSuccess = await settings.get<string>("notifyOnTrustedUserAwardSuccess");
    const settingLeaderboardName = await settings.get<string>("leaderboardName");
    const settingModAwardCommandSuccess = await settings.get<string>("modAwardCommandSuccess");
    const settingTrustedUserAwardSuccessMessage = await settings.get<string>("trustedUserAwardSuccessMessage");
    const settingPointSymbol = await settings.get<string>("pointSymbol");
    const pointName = (settingPointName as string) ?? "point";

    const parentComment = await getParentComment(event, context);
    if (!parentComment || !parentComment.authorId) {
        logger.warn("❌ Parent comment missing for mod award");
        return;
    }

    const awarder = event.author.name;
    const awardee = parentComment.authorName;

    // Classify by actual moderator status, not by which command was used.
    const awarderIsModerator = await isModerator(
        context,
        event.subreddit.name,
        awarder
    );

    let user: User | undefined;

    try {
        user = await context.reddit.getUserByUsername(awarder);
    } catch {
        user = undefined;
    }

    if (!user) return;

    let recipient: User | undefined;

    try {
        recipient = await context.reddit.getUserByUsername(awardee);
    } catch {
        recipient = undefined;
    }

    if (!recipient) return;

    const existingScore = await getCurrentScore(recipient, context);

    if (!existingScore) {
        logger.warn("❌ Could not retrieve existing score for user", {
            awardee,
        });
        return;
    }

    let flairShouldBeManaged: boolean;

    const key = `flairToggle:${awardee}`;
    const exists = await context.redis.exists(key);

    if (exists) {
        flairShouldBeManaged = false;
    } else {
        flairShouldBeManaged = true;
    }

    const username = awardee;

    const scoreFromRedis = await context.redis.zScore(
        POINTS_STORE_KEY,
        username
    );

    if (scoreFromRedis === undefined || scoreFromRedis === null) return;

    await context.redis.zAdd(POINTS_STORE_KEY, {
        member: username,
        score: scoreFromRedis + 1,
    });

    // Record the successful point independently of optional replies/flair/wiki.
    try {
        await recordDigestPointAward(context, awarder, awarderIsModerator);
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
    await setModDupKey(event, context, "1");

    // ⭐ Auto-superuser logic
    const modCommand = (settingModAwardCommand as string) ?? "";
    await handleAutoSuperuserPromotion(
        event,
        context,
        newScore.score,
        modCommand
    );

    // 📣 Notify on success
    const modNotifyMode =
        (settingNotifyOnModAwardSuccess as string | undefined) ??
        "none";
    const trustedUserNotifyMode =
        (settingNotifyOnTrustedUserAwardSuccess as string | undefined) ??
        "none";

    const leaderboard = `https://old.reddit.com/r/${
        event.subreddit.name
    }/wiki/${settingLeaderboardName ?? "leaderboard"}`;
    const awarderIsSuperUser = await getUserIsSuperuser(context, awarder);

    const modSuccessTemplate =
        (settingModAwardCommandSuccess as string) ??
        "";
    const trustedUserSuccessTemplate =
        (settingTrustedUserAwardSuccessMessage as string) ??
        "";

    const totalScore = await getCurrentScore(recipient, context);

    if (!totalScore) {
        logger.warn("❌ Could not retrieve existing score for user", {
            awardee,
        });
        return;
    }

    await context.scheduler.runJob({
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

    if (
        modNotifyMode !== "none" &&
        awarderIsModerator
    ) {
        if (
            modNotifyMode === "replyascomment"
        ) {
            const modAwardSuccessMessage = await context.reddit.submitComment({
                id: event.comment.id,
                text: modSuccessMessage,
            });
            await modAwardSuccessMessage.distinguish();
        } else if (
            modNotifyMode === "replybypm"
        ) {
            await context.reddit.sendPrivateMessage({
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
    } else if (
        trustedUserNotifyMode !==
            "none" &&
        awarderIsSuperUser
    ) {
        if (
            trustedUserNotifyMode ===
            "replyascomment"
        ) {
            const trustedUserSuccessComment =
                await context.reddit.submitComment({
                    id: event.comment.id,
                    text: trustedUserMessage,
                });
            await trustedUserSuccessComment.distinguish();
        } else if (
            trustedUserNotifyMode ===
            "replybypm"
        ) {
            await context.reddit.sendPrivateMessage({
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
        await updateUserWiki(context, awarder, awardee, givenData);
    } catch (err) {
        logger.error("❌ Failed to update user wiki (MOD award)", {
            awarder,
            awardee,
            err,
        });
    }

    // Flair management is a separate optional side effect.
    const flairHandlingDisabled = await flairToggleKeyExists(
        context,
        recipient
    );

    if (flairHandlingDisabled) {
        logger.info(
            "Flair handling is disabled for this user; wiki was updated and flair update was skipped"
        );
        return;
    }

    await setUserScore(context, awardee, awarder, newScore);
}

export async function executeModCommand(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext
): Promise<boolean> {
    if (!event.comment || !event.author || !event.post) {
        return false;
    }

    const awarder = event.author.name;

    let user: User | undefined;

    try {
        user = await context.reddit.getUserByUsername(awarder);
    } catch {
        user = undefined;
    }

    if (!user) {
        return false;
    }

    const body = (event.comment.body ?? "").toLowerCase();

    const triggers = await getTriggers(context);

    for (const trigger of triggers) {
        if (!new RegExp(trigger, "i").test(body)) {
            continue;
        }

        // if (await handleModIgnoredContextIfNeeded(event, context, trigger)) {
        //     return false;
        // }

        const isAuthorized = await handleUnauthorizedModCommand(
            event,
            context,
            trigger
        );
        if (!isAuthorized) return false;

        if (await isSelfAwardModCommand(event, context)) {
            await handleSelfAwardModCommand(event, context);

            return false;
        }

        if (await isDuplicateModAward(event, context)) {
            await handleDuplicateModAward(event, context);

            return false;
        }

        await awardPointToUserModCommand(event, context);

        return true;
    }

    return false;
}
