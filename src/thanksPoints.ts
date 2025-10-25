import {
    Context,
    FormOnSubmitEvent,
    JSONObject,
    MenuItemOnPressEvent,
    SettingsValues,
    TriggerContext,
    User,
} from "@devvit/public-api";
import {
    CommentSubmit,
    CommentUpdate,
    PostCreate,
    PostSubmit,
} from "@devvit/protos";
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

const POINTS_STORE_KEY = "thanksPointsStore";

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

export async function setPostAuthorScore(
    username: string,
    newScore: number,
    context: TriggerContext,
    settings: SettingsValues
) {
    // 🔹 Store user's total score in leaderboard
    await context.redis.zAdd(POINTS_STORE_KEY, {
        member: username,
        score: newScore,
    });

    // 🔹 Queue cleanup & leaderboard updates
    await setCleanupForUsers([username], context);
    await context.scheduler.runJob({
        name: "updateLeaderboard",
        runAt: new Date(),
        data: {
            reason: `Updated ${username} to ${newScore} points.`,
        },
    });

    // 🔹 Settings
    const flairSetting = ((settings[AppSetting.ExistingFlairHandling] as
        | string[]
        | undefined) ?? [
        ExistingFlairOverwriteHandling.OverwriteNumeric,
    ])[0] as ExistingFlairOverwriteHandling;

    const awardsRequired =
        (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) || 0;

    const restrictedText =
        (settings[AppSetting.PointCapNotMetFlair] as string) ||
        "Restricted Poster";

    const pointSymbol = (settings[AppSetting.PointSymbol] as string) ?? "";

    const redisKey = `restrictedUser:${username}`;
    let userIsRestricted = false;

    if (awardsRequired > 0) {
        // Fetch existing restriction info
        const restrictionExists = await context.redis.exists(redisKey);

        // If user was restricted before but now meets or exceeds the requirement, lift restriction
        if (restrictionExists && newScore >= awardsRequired) {
            await context.redis.del(redisKey);
            userIsRestricted = false;
            console.log(
                `✅ ${username} restriction lifted — now at ${newScore}/${awardsRequired} points.`
            );
        }
        // If user is below threshold, ensure restriction key exists
        else if (newScore < awardsRequired) {
            await context.redis.set(redisKey, "restricted");
            userIsRestricted = true;
            console.log(
                `🚫 ${username} remains restricted — ${newScore}/${awardsRequired} points.`
            );
        }
    }

    // 🔹 Build flair text
    let flairText = "";
    switch (flairSetting) {
        case ExistingFlairOverwriteHandling.OverwriteNumericSymbol:
            flairText = userIsRestricted
                ? `${restrictedText} | ${newScore}${pointSymbol}`
                : `${newScore}${pointSymbol}`;
            break;
        case ExistingFlairOverwriteHandling.OverwriteNumeric:
            flairText = userIsRestricted
                ? `${restrictedText} | ${newScore}`
                : `${newScore}`;
            break;
        case ExistingFlairOverwriteHandling.NeverSet:
            flairText = userIsRestricted ? `${restrictedText}` : "";
            break;
    }

    // 🔹 Apply flair
    const subredditName = (await context.reddit.getCurrentSubreddit()).name;
    let cssClass = settings[AppSetting.CSSClass] as string | undefined;
    let flairTemplate = settings[AppSetting.FlairTemplate] as
        | string
        | undefined;
    if (flairTemplate && cssClass) cssClass = undefined;

    await context.reddit.setUserFlair({
        subredditName,
        username,
        cssClass,
        flairTemplateId: flairTemplate,
        text: flairText,
    });

    console.log(
        userIsRestricted
            ? `🚫 Flair applied: ${username} restricted (${flairText})`
            : `✅ Flair applied: ${username} unrestricted (${flairText})`
    );
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
    if (!author) return;

    const awardsRequired =
        (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) || 0;
    let pointsAwarded = 0;
    const restrictionKey = `${author.username}-restricted-${pointsAwarded}`;
    const restrictedFlagKey = `restrictedUser:${author.username}`;

    const [countRaw, isRestrictedFlag] = await Promise.all([
        context.redis.get(restrictionKey),
        context.redis.get(restrictedFlagKey),
    ]);

    const count = countRaw ? parseInt(countRaw, 10) : 0;
    const isRestricted = !!isRestrictedFlag;

    logger.debug("⚙️ Checking restriction", {
        author: author.username,
        count,
        awardsRequired,
        isRestricted,
    });

    if (!isRestricted) {
        context.redis.set(restrictedFlagKey, `${count}`)
    }

    // Only enforce restriction if Redis flag exists
    if (isRestricted && count < awardsRequired) {
        const notify =
            (settings[AppSetting.NotifyOpOnPostRestriction] as string) ??
            NotifyOpOnPostRestrictionReplyOptions.ReplyByPM;

        logger.warn(
            `🚫 Removing post — ${author.username} has ${count}/${awardsRequired}`
        );
        await context.reddit.remove(event.post.id, false);

        const pointName = settings[AppSetting.PointName] as string || "point";

        const messageTemplate =
            (settings[AppSetting.AwardRequirementMessage] as string) ??
            TemplateDefaults.AwardRequirementMessage;
        const message = messageTemplate
            .replace(/{{author}}/g, author.username)
            .replace(/{{requirement}}/g, awardsRequired.toString())
            .replace(/{{subreddit}}/g, subredditName)
            .replace(/{{name}}/g, capitalize(pointName))
            .replace(
                /{{permalink}}/g,
                `https://reddit.com${event.post.permalink}`
            );

        try {
            if (notify === NotifyOpOnPostRestrictionReplyOptions.ReplyByPM) {
                await context.reddit.sendPrivateMessage({
                    to: author.username,
                    subject: "Post Restricted",
                    text: message,
                });
                logger.info("✉️ Restriction PM sent", { authorName });
            } else if (
                notify === NotifyOpOnPostRestrictionReplyOptions.ReplyAsComment
            ) {
                const comment = await context.reddit.submitComment({
                    id: event.post.id,
                    text: message,
                });
                await comment.distinguish(true);
                logger.info("💬 Restriction comment posted", {
                    postId: event.post.id,
                });
            } else {
                logger.warn("⚠️ Unknown notify mode, skipping message", {
                    notify,
                });
            }
        } catch (err) {
            logger.error("❌ Failed to send restriction message", { err });
        }
    } else {
        logger.info(
            `✅ ${author.username} meets posting requirement (${count}/${awardsRequired}) or not restricted.`
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
    const allCommands = [...userCommands, ...(modCommand ? [modCommand] : [])];
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

    // ──────────────── Bot Award Check ────────────────
    if (recipient === context.appName) {
        const botAwardMessage = formatMessage(
            (settings[AppSetting.BotAwardMessage] as string) ??
                TemplateDefaults.BotAwardMessage,
            { name: pointName }
        );

        const newComment = await context.reddit.submitComment({
            id: event.comment.id,
            text: botAwardMessage,
        });
        await newComment.distinguish();
        logger.debug("🤖 Bot cannot receive awards — handled gracefully.");
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
        const disallowedMessage = formatMessage(
            `You do not have permission to award {{name}}s.`,
            { name: pointName }
        );
        const newComment = await context.reddit.submitComment({
            id: event.comment.id,
            text: disallowedMessage,
        });
        await newComment.distinguish();
        logger.warn("❌ Author does not have permission to award.");
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
            await newComment.distinguish();
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
        logger.info(`❌ ${awarder} already awarded this comment`);
        return;
    }

    // ──────────────── Award Logic ────────────────
    const redisKey = POINTS_STORE_KEY;
    const authorUser = await context.reddit.getUserByUsername(awarder);
    const authorRedis = `${authorUser?.username}`;
    let newScore = await context.redis.zIncrBy(redisKey, recipient, 1);
    await context.redis.set(alreadyKey, "1");

    logger.info(
        `✅ ${awarder} awarded 1 ${pointName} to ${recipient} (new score: ${newScore})`
    );

    // ──────────────── Restriction Counter ────────────────
    if (authorUser) {
        const counterKey = `${authorRedis}-restricted-count`;
        const currentRaw = await context.redis.get(counterKey);
        let current = currentRaw ? parseInt(currentRaw, 10) : 0;
        current++;
        await context.redis.set(counterKey, current.toString());

        const awardsRequired =
            (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) ||
            0;
        logger.debug("🏁 Restriction counter updated", {
            author: authorUser.username,
            current,
            awardsRequired,
        });

        if (current === awardsRequired) {
            await context.reddit.sendPrivateMessage({
                to: authorUser.username,
                subject: "Posting restriction lifted",
                text: `🎉 You have met the posting requirement of ${awardsRequired} awards!`,
            });
        }
    }

    // ──────────────── Update Flair ────────────────
    await updateAwardeeFlair(
        context,
        subredditName,
        recipient,
        newScore,
        settings
    );

    if (authorUser) {
        const authorScore =
            (await context.redis.zScore(redisKey, awarder)) ?? 0;
        await updateAuthorFlair(
            context,
            subredditName,
            awarder,
            authorScore,
            settings,
            false
        );
    }

    // ──────────────── Queue leaderboard update ────────────────
    await context.scheduler.runJob({
        name: "updateLeaderboard",
        runAt: new Date(),
        data: { reason: `Updated ${recipient} to ${newScore} points.` },
    });
}

async function updateAuthorFlair(
    context: TriggerContext,
    subredditName: string,
    recipient: string,
    newScore: number,
    settings: SettingsValues,
    userIsRestricted: boolean
) {
    const pointSymbol = (settings[AppSetting.PointSymbol] as string) ?? "";
    const restrictedText =
        (settings[AppSetting.PointCapNotMetFlair] as string) ??
        "Restricted Poster";
    const flairSetting = ((settings[AppSetting.ExistingFlairHandling] as
        | string[]
        | undefined) ?? [
        ExistingFlairOverwriteHandling.OverwriteNumeric,
    ])[0] as ExistingFlairOverwriteHandling;

    let flairText = "";
    if (userIsRestricted) {
        switch (flairSetting) {
            case ExistingFlairOverwriteHandling.OverwriteNumericSymbol:
                flairText = userIsRestricted
                    ? `${restrictedText} | ${newScore}${pointSymbol}`
                    : `${newScore}${pointSymbol}`;
                break;
            case ExistingFlairOverwriteHandling.OverwriteNumeric:
                flairText = userIsRestricted
                    ? `${restrictedText} | ${newScore}`
                    : `${newScore}`;
                break;
            case ExistingFlairOverwriteHandling.NeverSet:
                flairText = userIsRestricted ? `${restrictedText}` : "";
                break;
        }
    } else {
        switch (flairSetting) {
            case ExistingFlairOverwriteHandling.OverwriteNumericSymbol:
                flairText = `${newScore}${pointSymbol}`;
                break;
            case ExistingFlairOverwriteHandling.OverwriteNumeric:
                flairText = `${newScore}`;
                break;
            case ExistingFlairOverwriteHandling.NeverSet:
                flairText = "";
                break;
        }
    }

    let cssClass = settings[AppSetting.CSSClass] as string | undefined;
    let flairTemplate = settings[AppSetting.FlairTemplate] as
        | string
        | undefined;
    if (flairTemplate && cssClass) cssClass = undefined;

    await context.reddit.setUserFlair({
        subredditName,
        username: recipient,
        cssClass,
        flairTemplateId: flairTemplate,
        text: flairText,
    });

    logger.info(
        userIsRestricted
            ? `🚫 Awardee flair applied (restricted): ${recipient} (${flairText})`
            : `✅ Awardee flair applied: ${recipient} (${flairText})`
    );
}

async function updateAwardeeFlair(
    context: TriggerContext,
    subredditName: string,
    authorName: string,
    score: number,
    settings: SettingsValues
) {
    const pointSymbol = (settings[AppSetting.PointSymbol] as string) ?? "";
    const flairSetting = ((settings[AppSetting.ExistingFlairHandling] as
        | string[]
        | undefined) ?? [
        ExistingFlairOverwriteHandling.OverwriteNumeric,
    ])[0] as ExistingFlairOverwriteHandling;

    let flairText = "";
    switch (flairSetting) {
        case ExistingFlairOverwriteHandling.OverwriteNumericSymbol:
            flairText = `${score}${pointSymbol}`;
            break;
        case ExistingFlairOverwriteHandling.OverwriteNumeric:
            flairText = `${score}`;
            break;
        case ExistingFlairOverwriteHandling.NeverSet:
            flairText = "";
            break;
    }

    let cssClass = settings[AppSetting.CSSClass] as string | undefined;
    let flairTemplate = settings[AppSetting.FlairTemplate] as
        | string
        | undefined;
    if (flairTemplate && cssClass) cssClass = undefined;

    await context.reddit.setUserFlair({
        subredditName,
        username: authorName,
        cssClass,
        flairTemplateId: flairTemplate,
        text: flairText,
    });

    logger.info(`🧑‍🎨 Author flair updated: ${authorName} (${flairText})`);
}

function capitalize(word: string): string {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

function markdownEscape(input: string): string {
    return input.replace(/([\\`*_{}\[\]()#+\-.!])/g, "\\$1");
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

    const subreddit = await context.reddit.getCurrentSubredditName();
    await updateAwardeeFlair(
        context,
        subreddit,
        comment.authorName,
        newScore,
        settings
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

    const settings = await context.settings.getAll();
    const { currentScore } = await getCurrentScore(user, context, settings);

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

    // 🔹 Check and remove restriction key from Redis
    const restrictionKey = `restrictedUser:${user.username}`;
    const isRestricted = await context.redis.exists(restrictionKey);

    if (!isRestricted) {
        await context.ui.showToast(
            `ℹ️ u/${user.username} is not currently restricted.`
        );
        logger.info("ℹ️ No restriction found for user", {
            username: user.username,
        });
        return;
    }

    await context.redis.del(restrictionKey);
    logger.info("✅ Restriction removed from Redis", {
        username: user.username,
    });

    // 🔹 Get user's current score and restore their flair
    const { currentScore } = await getCurrentScore(user, context, settings);
    await updateAuthorFlair(
        context,
        subreddit,
        user.username,
        currentScore,
        settings,
        false
    );

    // 🔹 Notify moderator of success
    await context.ui.showToast(
        `✅ Post restriction removed for u/${user.username}.`
    );
    logger.info(
        `✅ Post restriction removed for u/${user.username} (current score: ${currentScore})`
    );
}
