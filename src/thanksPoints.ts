import {
    Context,
    FormOnSubmitEvent,
    JSONObject,
    MenuItemOnPressEvent,
    SettingsValues,
    TriggerContext,
    User,
} from "@devvit/public-api";
import { CommentSubmit, CommentUpdate, PostSubmit } from "@devvit/protos";
import { isModerator } from "./utility.js";
import {
    ExistingFlairOverwriteHandling,
    AppSetting,
    TemplateDefaults,
    NotifyOnSelfAwardReplyOptions,
    NotifyOpOnPostRestrictionReplyOptions,
    NotifyOnSuccessReplyOptions,
    NotifyOnPointAlreadyAwardedReplyOptions,
} from "./settings.js";
import { setCleanupForUsers } from "./cleanupTasks.js";
import { isLinkId } from "@devvit/shared-types/tid.js";
import { logger } from "./logger.js";
import {
    manualPostRestrictionRemovalForm,
    manualSetPointsForm,
} from "./main.js";
import { UPDATE_LEADERBOARD_JOB } from "./constants.js";

export const POINTS_STORE_KEY = "thanksPointsStore";

function formatMessage(
    template: string,
    placeholders: Record<string, string>
): string {
    let result = template;
    for (const [key, value] of Object.entries(placeholders)) {
        const regex = new RegExp(`{{${key}}}`, "g");
        result = result.replace(regex, value);
    }

    const footer =
        "\n\n---\n\n^(I am a bot - please contact the mods with any questions)";
    if (
        !result
            .trim()
            .endsWith(
                "^(I am a bot - please contact the mods with any questions)"
            )
    ) {
        result = result.trim() + footer;
    }

    return result;
}

async function getCurrentScore(
    user: User,
    context: TriggerContext,
    settings: SettingsValues
): Promise<{
    currentScore: number;
    flairText: string;
    flairSymbol: string;
}> {
    const subredditName = (await context.reddit.getCurrentSubreddit()).name;
    const userFlair = await user.getUserFlairBySubreddit(subredditName);

    let scoreFromRedis: number | undefined;
    try {
        scoreFromRedis =
            (await context.redis.zScore(
                `${POINTS_STORE_KEY}`,
                user.username
            )) ?? 0;
    } catch {
        scoreFromRedis = 0;
    }

    const flairTextRaw = userFlair?.flairText ?? "";
    let scoreFromFlair: number;
    const numberRegex = /^\d+$/;

    if (!flairTextRaw || flairTextRaw === "-") {
        scoreFromFlair = 0;
    } else {
        // Extract numeric part from start of flair text (e.g. "17⭐" -> "17")
        const numericMatch = flairTextRaw.match(/^\d+/);
        if (numericMatch && numberRegex.test(numericMatch[0])) {
            scoreFromFlair = parseInt(numericMatch[0], 10);
        } else {
            scoreFromFlair = NaN;
        }
    }

    const flairScoreIsNaN = isNaN(scoreFromFlair);

    // Extract symbol by removing the numeric part from flair text, trim whitespace
    const flairSymbol = flairTextRaw.replace(/^\d+/, "").trim();

    if (settings[AppSetting.PrioritiseScoreFromFlair] && !flairScoreIsNaN) {
        return {
            currentScore: scoreFromFlair,
            flairText: flairTextRaw,
            flairSymbol,
        };
    }

    return {
        currentScore:
            !flairScoreIsNaN && scoreFromFlair > scoreFromRedis
                ? scoreFromFlair
                : scoreFromRedis,
        flairText: flairTextRaw,
        flairSymbol,
    };
}

export async function onPostSubmit(event: PostSubmit, context: TriggerContext) {
    const settings = (await context.settings.getAll()) as SettingsValues;
    logger.debug("✅ onPostSubmit triggered", { event });

    if (!event.subreddit || !event.author || !event.post) {
        logger.warn("❌ Missing required event data", { event });
        return;
    }

    const subredditName = event.subreddit.name;
    const authorName = event.author.name;
    const author = await context.reddit.getUserByUsername(authorName);
    if (!author) {
        logger.warn("❌ Could not fetch author object", { authorName });
        return;
    }

    // ──────────────── Redis Keys ────────────────
    const restrictedFlagKey = `restrictedUser:${author.username}`;
    const requiredKey = `awardsRequired:${author.username}`;
    const lastValidPostKey = `lastValidPost:${author.username}`;

    // ──────────────── Retrieve Counters ────────────────
    const countRaw = await context.redis.get(restrictedFlagKey);
    const requiredRaw = await context.redis.get(requiredKey);
    const count = countRaw ? parseInt(countRaw, 10) || 0 : 0;
    const remaining = requiredRaw ? parseInt(requiredRaw, 10) || 0 : 0;

    const awardsRequired =
        (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) || 0;

    // ──────────────── Decide whether or not moderators should have the restriction applied to them ────────────────

    const modsExempt =
        (settings[AppSetting.ModeratorsExempt] as boolean) ?? "true";
    const isMod = await isModerator(context, subredditName, authorName);
    if (isMod && modsExempt) {
        logger.info(
            `✅ ${author.username} is a moderator and is exempt from being restricted`
        );
        return;
    }

    // ──────────────── Use Helper to Determine Restriction ────────────────
    const restrictedFlagExists = await restrictedKeyExists(context, authorName);
    const requiredFlagExists = await requiredKeyExists(context, authorName);

    const isRestricted = restrictedFlagExists || requiredFlagExists;

    logger.debug("⚙️ Checking restriction", {
        author: author.username,
        count,
        remaining,
        awardsRequired,
        isRestricted,
    });

    // ✅ First post allowed — mark user as restricted after posting
    if (isRestricted === 0) {
        await context.redis.set(lastValidPostKey, event.post.permalink);
        await updateAuthorRedis(context, authorName);
        await context.redis.set(restrictedFlagKey, "0");
        logger.info(
            `✅ First post allowed for ${author.username}, future posts restricted until ${awardsRequired} awards.`
        );
        await context.scheduler.runJob({
            name: "updateLeaderboard",
            runAt: new Date(),
            data: {
                reason: `Awarded a point to ${authorName}.}`,
            },
        });
        return;
    }

    // 🚫 Restrict posting if requirement not yet met
    //TODO: figure out why this happens even if the user's restriction is removed manually
    if (isRestricted === 1 && count < awardsRequired) {
        logger.warn(
            `🚫 Removing post — ${author.username} has ${count}/${awardsRequired} (${remaining} left)`
        );
        await context.reddit.remove(event.post.id, false);

        const pointName = (settings[AppSetting.PointName] as string) ?? "point";
        const messageTemplate =
            (settings[AppSetting.AwardRequirementMessage] as string) ??
            TemplateDefaults.AwardRequirementMessage;
        const lastValidPermalink = await context.redis.get(lastValidPostKey);

        const message = messageTemplate
            .replace(/{{author}}/g, author.username)
            .replace(/{{requirement}}/g, awardsRequired.toString())
            .replace(/{{subreddit}}/g, subredditName)
            .replace(/{{name}}/g, capitalize(pointName))
            .replace(
                /{{permalink}}/g,
                lastValidPermalink
                    ? `https://reddit.com${lastValidPermalink}`
                    : `https://reddit.com${event.post.permalink}`
            );

        // Determine notification mode
        const notifyRaw = settings[AppSetting.NotifyOpOnPostRestriction];
        const notify =
            Array.isArray(notifyRaw) && notifyRaw.length > 0
                ? notifyRaw[0].toLowerCase()
                : (notifyRaw as string)?.toLowerCase() ?? "";

        try {
            if (notify === NotifyOpOnPostRestrictionReplyOptions.ReplyByPM) {
                await context.reddit.sendPrivateMessage({
                    to: author.username,
                    subject: "Post Restricted 🚫",
                    text: message,
                });
                logger.info(`✉️ Sent restriction PM to ${author.username}`);
            } else if (
                notify === NotifyOpOnPostRestrictionReplyOptions.ReplyAsComment
            ) {
                const comment = await context.reddit.submitComment({
                    id: event.post.id,
                    text: message,
                });
                await comment.distinguish(true);
                logger.info(
                    `💬 Posted restriction comment on ${event.post.id}`
                );
            } else {
                logger.warn("⚠️ Unknown notify mode, skipping message", {
                    notify,
                });
            }
        } catch (err) {
            logger.error("❌ Failed to send restriction message", { err });
        }
        
        await context.scheduler.runJob({
            name: UPDATE_LEADERBOARD_JOB,
            runAt: new Date(),
            data: {
                reason: `Awarded a point to ${authorName}.`,
            },
        });
    } else {
        logger.info(
            `✅ ${author.username} meets posting requirement (${count}/${awardsRequired}) or is no longer restricted.`
        );
    }
}

async function getUserIsSuperuser(
    username: string,
    context: TriggerContext
): Promise<boolean> {
    const settings = await context.settings.getAll();

    const superUserSetting =
        (settings[AppSetting.SuperUsers] as string | undefined) ?? "";
    const superUsers = superUserSetting
        .split(",")
        .map((user) => user.trim().toLowerCase());

    if (superUsers.includes(username.toLowerCase())) {
        return true;
    }

    const autoSuperuserThreshold =
        (settings[AppSetting.AutoSuperuserThreshold] as number | undefined) ??
        0;

    if (autoSuperuserThreshold) {
        let user: User | undefined;
        try {
            user = await context.reddit.getUserByUsername(username);
        } catch {
            return false;
        }
        if (!user) {
            return false;
        }
        const { currentScore } = await getCurrentScore(user, context, settings);
        return currentScore >= autoSuperuserThreshold;
    } else {
        return false;
    }
}

export async function handleThanksEvent(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext
) {
    logger.debug("✅ Event triggered", {
        commentId: event.comment?.id,
        postId: event.post?.id,
        author: event.author?.name,
        subreddit: event.subreddit?.name,
    });

    if (!event.comment || !event.post || !event.author || !event.subreddit) {
        logger.warn("❌ Missing required event data.");
        return;
    }

    if (isLinkId(event.comment.parentId)) {
        logger.debug("❌ Parent ID is a link — ignoring.");
        return;
    }

    const settings = await context.settings.getAll();
    const parentComment = await context.reddit.getCommentById(
        event.comment.parentId
    );
    if (!parentComment) {
        logger.warn("❌ Parent comment not found.");
        return;
    }

    const subredditName = event.subreddit.name;
    const awarder = event.author.name;
    const recipient = parentComment.authorName;
    if (!recipient) {
        logger.warn("❌ No recipient found.");
        return;
    }

    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const pointSymbol = (settings[AppSetting.PointSymbol] as string) ?? "";

    // ──────────────── Command Parsing ────────────────
    const userCommands = (settings[AppSetting.PointTriggerWords] as string)
        ?.split(/\s+/)
        .map((c) => c.toLowerCase().trim())
        .filter(Boolean) ?? ["!point"];
    const modCommand = (
        settings[AppSetting.ModAwardCommand] as string | undefined
    )
        ?.toLowerCase()
        ?.trim();
    const commentBody = event.comment.body?.toLowerCase() ?? "";

    const containsUserCommand = userCommands.some((cmd) =>
        commentBody.includes(cmd)
    );
    const containsModCommand = modCommand && commentBody.includes(modCommand);

    // System user check
    if (
        ["AutoModerator", context.appName].includes(event.author.name) &&
        (containsUserCommand || containsModCommand)
    ) {
        logger.debug("❌ System user attempted a command");
        return;
    }

    if (!containsUserCommand && !containsModCommand) {
        logger.debug("❌ Comment does not contain award command");
        return;
    }

    // ──────────────── Bot Award Handling ────────────────
    const botAwardMessage = formatMessage(
        (settings[AppSetting.BotAwardMessage] as string) ??
            TemplateDefaults.BotAwardMessage,
        { name: pointName }
    );

    const awardeeIsBot = recipient === context.appName;
    if (awardeeIsBot) {
        logger.debug("❌ Bot cannot award itself points");
        const newComment = await context.reddit.submitComment({
            id: event.comment.id,
            text: botAwardMessage,
        });
        await Promise.all([newComment.distinguish()]);
        return;
    }

    // ──────────────── Permission Handling ────────────────
    const accessControl = ((settings[AppSetting.AccessControl] as string[]) ?? [
        "everyone",
    ])[0];
    const isMod = await isModerator(context, subredditName, awarder);
    const superUsers = ((settings[AppSetting.SuperUsers] as string) ?? "")
        .split("\n")
        .map((u) => u.trim().toLowerCase())
        .filter(Boolean);
    const isSuperUser = superUsers.includes(awarder.toLowerCase());
    const isOP = event.author.id === event.post.authorId;

    const hasPermission =
        accessControl === "everyone" ||
        (accessControl === "moderators-only" && isMod) ||
        (accessControl === "moderators-and-superusers" &&
            (isMod || isSuperUser)) ||
        (accessControl === "moderators-superusers-and-op" &&
            (isMod || isSuperUser || isOP));

    if (!hasPermission) {
        const permissionMessages: Record<string, string> = {
            "moderators-only": `You must be a moderator to award {{name}}s.`,
            "moderators-and-superusers": `You must be a moderator or superuser to award {{name}}s.`,
            "moderators-superusers-and-op": `You must be a moderator, superuser, or OP to award {{name}}s.`,
        };

        const disallowedMessage = formatMessage(
            permissionMessages[accessControl] ??
                `You do not have permission to award {{name}}s.`,
            { name: pointName }
        );

        const newComment = await context.reddit.submitComment({
            id: event.comment.id,
            text: disallowedMessage,
        });
        await Promise.all([newComment.distinguish()]);
        logger.warn(`❌ ${awarder} attempted to award without permission`);
        return;
    }

    // ──────────────── Self-Award Prevention ────────────────
    if (awarder === recipient) {
        const selfMsg = formatMessage(
            (settings[AppSetting.SelfAwardMessage] as string) ??
                TemplateDefaults.NotifyOnSelfAwardTemplate,
            { awarder, name: pointName }
        );

        const notify = ((settings[
            AppSetting.NotifyOnSelfAward
        ] as string[]) ?? [NotifyOnSelfAwardReplyOptions.NoReply])[0];

        if (notify === NotifyOnSelfAwardReplyOptions.ReplyAsComment) {
            const newComment = await context.reddit.submitComment({
                id: event.comment.id,
                text: selfMsg,
            });
            await Promise.all([newComment.distinguish()]);
        } else if (notify === NotifyOnSelfAwardReplyOptions.ReplyByPM) {
            await context.reddit.sendPrivateMessage({
                to: awarder,
                subject: `You tried to award yourself a ${pointName}`,
                text: selfMsg,
            });
        }

        logger.debug("❌ User tried to award themselves.");
        return;
    }

    // ──────────────── Duplicate Award Check ────────────────
    const alreadyKey = `thanks-${parentComment.id}`;
    if (await context.redis.exists(alreadyKey)) {
        const dupMsg = formatMessage(
            (settings[AppSetting.DuplicateAwardMessage] as string) ??
                TemplateDefaults.DuplicateAwardMessage,
            { name: pointName }
        );

        const notify = ((settings[
            AppSetting.NotifyOnPointAlreadyAwarded
        ] as string[]) ?? ["none"])[0];

        if (notify === NotifyOnPointAlreadyAwardedReplyOptions.ReplyByPM) {
            await context.reddit.sendPrivateMessage({
                to: awarder,
                subject: `You've already awarded this comment`,
                text: dupMsg,
            });
        } else if (
            notify === NotifyOnPointAlreadyAwardedReplyOptions.ReplyAsComment
        ) {
            const newComment = await context.reddit.submitComment({
                id: event.comment.id,
                text: dupMsg,
            });
            await Promise.all([newComment.distinguish()]);
        }

        logger.info(`❌ Duplicate award attempt by ${awarder}`);
        return;
    }

    // ──────────────── Award Logic ────────────────
    const redisKey = POINTS_STORE_KEY;
    const authorUser = await context.reddit.getUserByUsername(awarder);
    let newScore = await context.redis.zIncrBy(redisKey, recipient, 1);
    await context.redis.set(alreadyKey, "1");

    const scoreboard = `https://reddit.com/r/${event.subreddit.name}/wiki/${
        settings[AppSetting.ScoreboardName] ?? "leaderboard"
    }`;

    const successMessage = formatMessage(
        (settings[AppSetting.SuccessMessage] as string) ??
            TemplateDefaults.NotifyOnSuccessTemplate,
        {
            awardee: recipient,
            awarder,
            total: newScore.toString(),
            name: pointName,
            symbol: pointSymbol,
            scoreboard,
        }
    );

    const notifySuccess = ((settings[
        AppSetting.NotifyOnSuccess
    ] as string[]) ?? ["none"])[0];

    if (notifySuccess === NotifyOnSuccessReplyOptions.ReplyByPM) {
        await Promise.all([
            context.reddit.sendPrivateMessage({
                to: awarder,
                subject: `You awarded a ${pointName}`,
                text: successMessage,
            }),
            context.reddit.sendPrivateMessage({
                to: recipient,
                subject: `You were awarded a ${pointName}`,
                text: successMessage,
            }),
        ]);
    } else if (notifySuccess === NotifyOnSuccessReplyOptions.ReplyAsComment) {
        const newComment = await context.reddit.submitComment({
            id: event.comment.id,
            text: successMessage,
        });
        await Promise.all([newComment.distinguish()]);
    }

    logger.info(`🏅 ${awarder} awarded 1 ${pointName} to ${recipient}.`);

    // ──────────────── Restriction Counter Updates ────────────────
    const restrictedKey = `restrictedUser:${awarder}`;
    const requiredKey = `awardsRequired:${awarder}`;
    const currentRaw = await context.redis.get(restrictedKey);
    const currentCount = currentRaw ? parseInt(currentRaw, 10) || 0 : 0;
    const newCount = currentCount + 1;
    await context.redis.set(restrictedKey, newCount.toString());

    const awardsRequired =
        (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) || 0;
    const remaining = Math.max(0, awardsRequired - newCount);
    await context.redis.set(requiredKey, remaining.toString());

    logger.info(
        `📊 ${awarder} has now ${newCount}/${awardsRequired} awards toward posting access.`
    );

    // 🎯 Restriction lifted when met
    if (newCount >= awardsRequired) {
        await context.redis.del(restrictedKey);
        await context.redis.del(requiredKey);
        await context.reddit.sendPrivateMessage({
            to: awarder,
            subject: "Posting restriction lifted 🎉",
            text: `You’ve now met the posting requirement of **${awardsRequired} ${pointName}s!**`,
        });
        logger.info(`✅ Restriction lifted for ${awarder}`);
    } else {
        await context.reddit.sendPrivateMessage({
            to: awarder,
            subject: `You awarded a ${pointName}`,
            text: `👍 ${recipient} now has ${newScore}${pointSymbol}.\n\nYou have ${newCount}/${awardsRequired} points toward lifting your posting restriction.`,
        });
        logger.debug(`✉️ Sent update PM to ${awarder}`);
    }

    // ──────────────── Flair + Leaderboard Updates ────────────────
    const recipientUser = await context.reddit.getUserByUsername(recipient);
    if (!recipientUser) return;

    const { currentScore: recipientScore } = await getCurrentScore(
        recipientUser,
        context,
        settings
    );
    const score = await context.redis.zScore(redisKey, recipient);

    const recipientIsRestricted = await getUserIsRestricted(recipient, context);
    await updateAwardeeFlair(
        context,
        subredditName,
        recipient,
        score ?? recipientScore,
        settings,
        recipientIsRestricted
    );
    logger.info(
        `🎨 Updated flair for ${recipient} (${
            score ?? recipientScore
        }${pointSymbol})`
    );

    // 🔹 Only update author Redis if they are OP
    const isPostAuthor = event.post.authorId === authorUser?.id;
    if (isPostAuthor && authorUser) {
        await updateAuthorRedis(context, authorUser.username);
        const { currentScore } = await getCurrentScore(
            authorUser,
            context,
            settings
        );

        // const restrictedFlagExists = await restrictedKeyExists(
        //     context,
        //     authorUser.username
        // );
        // const requiredFlagExists = await requiredKeyExists(
        //     context,
        //     authorUser.username
        // );

        // const isRestricted = restrictedFlagExists || requiredFlagExists;
        // if (isRestricted === 0) {
        //     await updateAuthorFlair(
        //         context,
        //         subredditName,
        //         authorUser.username,
        //         currentScore,
        //         settings,
        //         false
        //     );
        // } else if (isRestricted > 0){
        //     await updateAuthorFlair(
        //         context,
        //         subredditName,
        //         authorUser.username,
        //         currentScore,
        //         settings,
        //         true
        //     );
        // }

        logger.debug(
            `🧩 OP ${authorUser.username} restriction counter incremented`
        );
    }

    // 🏆 Schedule leaderboard update
    await context.scheduler.runJob({
        name: "updateLeaderboard",
        runAt: new Date(),
        data: { reason: `Updated ${recipient} to ${newScore} points.` },
    });
    logger.info(`📈 Leaderboard update scheduled for ${recipient}`);
}

// async function updateAuthorFlair(
//     context: TriggerContext,
//     subredditName: string,
//     username: string,
//     score: number,
//     settings: SettingsValues,
//     userIsRestricted: boolean
// ) {
//     const pointSymbol = (settings[AppSetting.PointSymbol] as string) ?? "";
//     const flairSetting = ((settings[AppSetting.ExistingFlairHandling] as
//         | string[]
//         | undefined) ?? [
//         ExistingFlairOverwriteHandling.OverwriteNumeric,
//     ])[0] as ExistingFlairOverwriteHandling;

//     let flairText = "";
//     switch (flairSetting) {
//         case ExistingFlairOverwriteHandling.OverwriteNumericSymbol:
//             flairText = userIsRestricted
//                 ? `${restrictedText} | ${score}${pointSymbol}`
//                 : `${score}${pointSymbol}`;
//             break;
//         case ExistingFlairOverwriteHandling.OverwriteNumeric:
//             flairText = userIsRestricted
//                 ? `${restrictedText} | ${score}`
//                 : `${score}`;
//             break;
//         case ExistingFlairOverwriteHandling.NeverSet:
//             flairText = userIsRestricted ? `${restrictedText}` : "";
//             break;
//     }

//     let cssClass = settings[AppSetting.CSSClass] as string | undefined;
//     let flairTemplate = settings[AppSetting.FlairTemplate] as
//         | string
//         | undefined;
//     if (flairTemplate && cssClass) cssClass = undefined;

//     await context.reddit.setUserFlair({
//         subredditName,
//         username,
//         cssClass,
//         flairTemplateId: flairTemplate,
//         text: flairText,
//     });

//     logger.info(
//         userIsRestricted
//             ? `🚫 Author flair applied (restricted): ${username} (${flairText})`
//             : `✅ Author flair applied: ${username} (${flairText})`
//     );
// }

export async function requiredKeyExists(
    context: TriggerContext,
    username: string
): Promise<number> {
    const requiredKey = `awardsRequired:${username}`;

    // 0 if it doesn't exist
    // 1 if it does exist
    return await context.redis.exists(requiredKey);
}

export async function restrictedKeyExists(
    context: TriggerContext,
    username: string
): Promise<number> {
    const restrictedKey = `restrictedUser:${username}`;

    // 0 if it doesn't exist
    // 1 if it does exist
    return await context.redis.exists(restrictedKey);
}

export async function updateAuthorRedisManualRestrictionRemoval(
    context: TriggerContext,
    username: string
) {
    const restrictedKey = `restrictedUser:${username}`;

    try {
        await context.redis.del(restrictedKey);
    } catch (err) {
        console.log("Error trying to delete restrictedKey:", err);
    }
    logger.info(
        `📊 Updated Redis: ${username} => removed from ${restrictedKey}`
    );
}

export async function updateAuthorRedisManualRequirementRemoval(
    context: TriggerContext,
    username: string
) {
    const requiredKey = `awardsRequired:${username}`;

    try {
        await context.redis.del(requiredKey);
    } catch (err) {
        console.log("Error trying to delete requiredKey:", err);
    }
    logger.info(`📊 Updated Redis: ${username} => removed from ${requiredKey}`);
}

export async function updateAuthorRedis(
    context: TriggerContext,
    username: string
): Promise<void> {
    const restrictedKey = `restrictedUser:${username}`;
    const requiredKey = `awardsRequired:${username}`;

    // 🔢 Increment restricted count
    const currentRaw = await context.redis.get(restrictedKey);
    const currentCount = currentRaw ? parseInt(currentRaw, 10) || 0 : -1;
    const newCount = currentCount + 1;
    await context.redis.set(restrictedKey, newCount.toString());

    // ⚙️ Store remaining requirement if configured
    const settings = await context.settings.getAll();
    const awardsRequired =
        (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) || 0;

    const remaining = Math.max(0, awardsRequired - newCount);
    if (remaining > 0) {
        await context.redis.set(requiredKey, remaining.toString());
    } else {
        await context.redis.del(requiredKey);
        await context.redis.del(restrictedKey);
    }
    logger.info(
        `📊 Updated Redis: ${username} => restrictedUser=${newCount}, awardsRequired=${remaining}`
    );
}

async function updateAwardeeFlair(
    context: TriggerContext,
    subredditName: string,
    commentAuthor: string,
    newScore: number,
    settings: SettingsValues,
    userIsRestricted: boolean
) {
    const pointSymbol = (settings[AppSetting.PointSymbol] as string) ?? "";
    const flairSetting = ((settings[AppSetting.ExistingFlairHandling] as
        | string[]
        | undefined) ?? [
        ExistingFlairOverwriteHandling.OverwriteNumeric,
    ])[0] as ExistingFlairOverwriteHandling;

    const restrictedFlagKey = `restrictedUser:${commentAuthor}`;
    const countRaw = await context.redis.get(restrictedFlagKey);

    let flairText = "";
    switch (flairSetting) {
        case ExistingFlairOverwriteHandling.OverwriteNumericSymbol:
            flairText = `${newScore}${pointSymbol}`;
            break;
        case ExistingFlairOverwriteHandling.OverwriteNumeric:
            flairText = `${newScore}`;
            break;
    }

    let cssClass = settings[AppSetting.CSSClass] as string | undefined;
    let flairTemplate = settings[AppSetting.FlairTemplate] as
        | string
        | undefined;
    if (flairTemplate && cssClass) cssClass = undefined;

    await context.reddit.setUserFlair({
        subredditName,
        username: commentAuthor,
        cssClass,
        flairTemplateId: flairTemplate,
        text: flairText,
    });

    logger.info(`🧑‍🎨 Awardee flair updated: ${commentAuthor} (${flairText})`);
}

function capitalize(word: string): string {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

function markdownEscape(input: string): string {
    return input.replace(/([\\`*_{}\[\]()#+\-.!])/g, "\\$1");
}

/**
 * Checks whether a user is currently restricted from posting.
 * Returns true if the user has a restriction flag stored in Redis.
 */
export async function getUserIsRestricted(
    username: string,
    context: TriggerContext
): Promise<boolean> {
    const restrictedFlagKey = `restrictedUser:${username}`;

    try {
        const restrictedFlagValue = await context.redis.get(restrictedFlagKey);

        logger.debug("🔍 Checking user restriction status", {
            username,
            restrictedFlagKey,
            restrictedFlagValue,
        });

        if (!restrictedFlagValue) return false;

        const normalized = restrictedFlagValue.toLowerCase().trim();

        // Accept both boolean-like and numeric flags
        return (
            normalized === "true" ||
            normalized === "1" ||
            (!isNaN(Number(normalized)) && Number(normalized) > 0)
        );
    } catch (err) {
        logger.error("❌ Failed to check user restriction flag", {
            username,
            err,
        });
        return false; // fail-safe
    }
}

export async function handleManualPointSetting(
    event: MenuItemOnPressEvent,
    context: Context
) {
    const comment = await context.reddit.getCommentById(event.targetId);
    let user: User | undefined;
    try {
        user = await context.reddit.getUserByUsername(comment.authorName);
    } catch {
        //
    }

    if (!user) {
        context.ui.showToast("Cannot set points. User may be shadowbanned.");
        return;
    }

    const settings = await context.settings.getAll();
    const { currentScore } = await getCurrentScore(user, context, settings);

    const fields = [
        {
            name: "newScore",
            type: "number",
            defaultValue: currentScore,
            label: `Enter a new score for ${comment.authorName}`,
            helpText:
                "Warning: This will overwrite the score that currently exists",
            multiSelect: false,
            required: true,
        },
    ];

    context.ui.showForm(manualSetPointsForm, { fields });
}

export async function manualSetPointsFormHandler(
    event: FormOnSubmitEvent<JSONObject>,
    context: Context
) {
    if (!context.commentId) {
        context.ui.showToast("An error occurred setting the user's score.");
        return;
    }

    const newScore = event.values.newScore as number | undefined;
    if (
        typeof newScore !== "number" ||
        isNaN(newScore) ||
        parseInt(newScore.toString(), 10) < 0
    ) {
        context.ui.showToast("You must enter a new score (0 or higher)");
        return;
    }

    const comment = await context.reddit.getCommentById(context.commentId);

    let user: User | undefined;
    try {
        user = await context.reddit.getUserByUsername(comment.authorName);
    } catch {
        //
    }

    if (!user) {
        context.ui.showToast("Cannot set points. User may be shadowbanned.");
        return;
    }

    const settings = await context.settings.getAll();
    const recipientIsRestricted = await getUserIsRestricted(
        comment.authorName,
        context
    );
    const subreddit = await context.reddit.getCurrentSubredditName();
    await updateAwardeeFlair(
        context,
        subreddit,
        comment.authorName,
        newScore,
        settings,
        recipientIsRestricted
    );
    context.ui.showToast(`Score for ${comment.authorName} is now ${newScore}`);
}

export async function handleManualPostRestrictionRemoval(
    event: MenuItemOnPressEvent,
    context: Context
) {
    const post = await context.reddit.getPostById(event.targetId);
    let user: User | undefined;
    try {
        user = await context.reddit.getUserByUsername(post.authorName);
    } catch {
        //
    }

    if (!user) {
        context.ui.showToast("Cannot set points. User may be shadowbanned.");
        return;
    }

    const fields = [
        {
            name: "restrictionRemovalConfirmation",
            type: "string",
            defaultValue: "",
            label: `Confirm you wish to remove ${post.authorName}'s post restriction`,
            helpText: 'Type "CONFIRM" in all caps to confirm this',
            multiSelect: false,
            required: true,
        },
    ];

    context.ui.showForm(manualPostRestrictionRemovalForm, { fields });
}

// 🔹 This handler runs when a moderator uses the "Remove post restriction from user" menu item
export async function manualPostRestrictionRemovalHandler(
    event: FormOnSubmitEvent<JSONObject>,
    context: Context
) {
    logger.debug("🧩 manualPostRestrictionRemovalHandler triggered", { event });

    // 🔹 Validate that we're working with a post
    if (!context.postId) {
        await context.ui.showToast("❌ Unable to identify the post to update.");
        logger.error("❌ No postId in context for restriction removal.");
        return;
    }

    // 🔹 Confirm moderator input
    const confirmText = (
        event.values.restrictionRemovalConfirmation as string | undefined
    )?.trim();
    if (confirmText !== "CONFIRM") {
        await context.ui.showToast(
            "⚠️ Action cancelled — you must type CONFIRM in all caps."
        );
        logger.warn("⚠️ Moderator failed confirmation input.", { confirmText });
        return;
    }

    // 🔹 Fetch the post
    const post = await context.reddit.getPostById(context.postId);
    if (!post) {
        await context.ui.showToast("❌ Could not fetch post data.");
        logger.error(
            "❌ Post not found for manualPostRestrictionRemovalHandler",
            {
                postId: context.postId,
            }
        );
        return;
    }

    // 🔹 Fetch post author
    let user: User | undefined;
    try {
        user = await context.reddit.getUserByUsername(post.authorName);
    } catch (err) {
        logger.error("❌ Failed to fetch post author", {
            authorName: post.authorName,
            err,
        });
    }

    if (!user) {
        await context.ui.showToast(
            "⚠️ Cannot remove restriction. User may be deleted, suspended, or shadowbanned."
        );
        return;
    }

    const settings = await context.settings.getAll();
    const subreddit = await context.reddit.getCurrentSubredditName();

    // ──────────────── Redis Keys ────────────────
    const restrictionKey = `restrictedUser:${user.username}`;
    const requiredKey = `awardsRequired:${user.username}`;
    const lastValidPostKey = `lastValidPost:${user.username}`;

    // ──────────────── Check Restriction State ────────────────
    const authorName = user.username;
    const restrictedFlagExists = await restrictedKeyExists(context, authorName);
    const requiredFlagExists = await requiredKeyExists(context, authorName);

    const isRestricted = restrictedFlagExists || requiredFlagExists;
    if (!isRestricted) {
        await context.ui.showToast(
            `ℹ️ u/${user.username} is not currently restricted.`
        );
        logger.info("ℹ️ No restriction found for user", {
            username: user.username,
        });
        return;
    }

    if (restrictedFlagExists > 0) {
        await updateAuthorRedisManualRestrictionRemoval(context, authorName);
    }
    if (requiredFlagExists) {
        await updateAuthorRedisManualRequirementRemoval(context, authorName);
    }
    // ──────────────── Remove All Restriction Data ────────────────
    await Promise.all([context.redis.del(lastValidPostKey)]);

    logger.info("✅ Restriction fully removed from Redis", {
        username: user.username,
        removedKeys: [restrictionKey, requiredKey, lastValidPostKey],
    });

    // ──────────────── Update Flair ────────────────
    // try {
    //     const { currentScore } = await getCurrentScore(user, context, settings);
    //     await updateAuthorFlair(
    //         context,
    //         subreddit,
    //         user.username,
    //         currentScore,
    //         settings,
    //         false // no longer restricted
    //     );

    //     logger.info(
    //         `🎨 Flair updated for unrestricted user u/${user.username} (${currentScore} points)`
    //     );
    // } catch (err) {
    //     logger.error("❌ Failed to update flair after restriction removal", {
    //         username: user.username,
    //         err,
    //     });
    // }

    // ──────────────── Notify Moderator ────────────────
    await context.ui.showToast(
        `✅ Post restriction removed for u/${user.username}.`
    );
    logger.info(
        `✅ Manual post restriction removal successful for u/${user.username}.`
    );
}
