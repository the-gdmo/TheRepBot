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
} from "./settings.js";
import { setCleanupForUsers } from "./cleanupTasks.js";
import { isLinkId } from "@devvit/shared-types/tid.js";
import { logger } from "./logger.js";
import { manualSetPointsForm } from "./main.js";

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

export async function setUserScore(
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
    logger.debug("ℹ️ Subreddit and author identified", { subredditName, authorName });

    // Fetch full User object
    const author = await context.reddit.getUserByUsername(authorName);
    if (!author) {
        logger.warn("❌ Could not fetch full user object", { authorName });
        return;
    }
    logger.debug("✅ Fetched full User object", { author });

    // Check moderator exemption
    const isMod = await isModerator(context, subredditName, authorName);
    const moderatorsExempt = settings[AppSetting.ModeratorsExempt] as boolean;
    logger.debug("ℹ️ Moderator status checked", { isMod, moderatorsExempt });
    if (moderatorsExempt && isMod) {
        logger.info("ℹ️ Moderator exempt from point restriction", { authorName });
        return;
    }

    // Force point awarding enabled?
    const forcePointAwarding = (settings[AppSetting.ForcePointAwarding] as boolean) ?? false;
    logger.debug("ℹ️ Force point awarding check", { forcePointAwarding });
    if (!forcePointAwarding) return;

    const awardsRequired = (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) || 0;
    logger.debug("ℹ️ Awards required for new post", { awardsRequired });
    if (awardsRequired <= 0) return;

    // 🔹 Get current score
    const { currentScore } = await getCurrentScore(author, context, settings);
    logger.info("ℹ️ Current score retrieved", { authorName, currentScore });

    const userRedisKey = `restrictedUser:${authorName}`;
    await context.redis.set(userRedisKey, currentScore.toString());
    logger.debug("✅ User score stored in Redis", { userRedisKey, currentScore });

    const lastValidPostKey = `lastValidPost:${authorName}`;
    let userIsRestricted = false;

    // 🔹 Restriction logic
    const storedScoreRaw = await context.redis.get(userRedisKey);
    const storedScore = storedScoreRaw ? parseInt(storedScoreRaw, 10) : 0;
    logger.debug("ℹ️ Stored score fetched from Redis", { storedScoreRaw, storedScore });

    if (storedScore < awardsRequired) {
        userIsRestricted = true;
        logger.warn("🚫 User restricted from posting", { authorName, storedScore, awardsRequired });

        // Remove post
        try {
            await context.reddit.remove(event.post.id, true);
            logger.info("🗑 Post removed due to restriction", { postId: event.post.id });
        } catch (err) {
            logger.error("❌ Failed to remove post", { err });
        }

        // Get last valid post for {{permalink}}
        let lastValidPermalink = await context.redis.get(lastValidPostKey);
        if (!lastValidPermalink) {
            lastValidPermalink = event.post.permalink; // fallback
        }

        const pointName = (settings[AppSetting.PointName] as string) ?? "point";
        const restrictedFlair = (settings[AppSetting.PointCapNotMetFlair] as string) ?? "Restricted Poster";

        const messageTemplate = (settings[AppSetting.AwardRequirementMessage] as string) ?? TemplateDefaults.AwardRequirementMessage;
        const message = messageTemplate
            .replace(/{{author}}/g, author.username)
            .replace(/{{requirement}}/g, awardsRequired.toString())
            .replace(/{{subreddit}}/g, subredditName)
            .replace(/{{name}}/g, `${capitalize(pointName || "point")}`)
            .replace(/{{flair}}/g, restrictedFlair)
            .replace(/{{permalink}}/g, `https://reddit.com${lastValidPermalink}`);

        const notifyModeRaw = settings[AppSetting.NotifyOpOnPostRestriction] as string[] | NotifyOpOnPostRestrictionReplyOptions.ReplyByPM;
        const notifyModeStr = (Array.isArray(notifyModeRaw) ? notifyModeRaw[0] : notifyModeRaw ?? "").toLowerCase();

        try {
            if (notifyModeStr === NotifyOpOnPostRestrictionReplyOptions.ReplyByPM) {
                console.log("MessageAsPM:", message);
                await context.reddit.sendPrivateMessage({
                    to: author.username,
                    subject: "Post Restricted",
                    text: message,
                });
                logger.info("✉️ Restriction PM sent", { authorName });
            } else if (notifyModeStr === NotifyOpOnPostRestrictionReplyOptions.ReplyAsComment) {
                console.log("MessageAsComment:", message);
                await context.reddit.submitComment({
                    id: event.post.id,
                    text: message,
                });
                logger.info("💬 Restriction comment posted", { postId: event.post.id });
            } else {
                logger.warn("⚠️ Unknown notification mode, skipping message", { notifyModeStr });
            }
        } catch (err) {
            logger.error("❌ Failed to send restriction message", { err });
        }
    } else {
        // User is allowed → store last valid post
        await context.redis.set(lastValidPostKey, event.post.permalink);

        const restrictionExists = await context.redis.exists(userRedisKey);
        if (restrictionExists) {
            await context.redis.del(userRedisKey);
            logger.info("✅ User restriction lifted", { authorName, storedScore, awardsRequired });
        }
    }

    // 🔹 Update leaderboard
    await context.redis.zAdd(POINTS_STORE_KEY, { member: authorName, score: currentScore });
    logger.info("🏆 Leaderboard updated", { authorName, currentScore });

    // Queue leaderboard update
    await context.scheduler.runJob({
        name: "updateLeaderboard",
        runAt: new Date(),
        data: { reason: `Updated ${authorName} to ${currentScore} points.` },
    });
    logger.debug("📅 Scheduled leaderboard update job", { authorName });

    // 🔹 Build flair text
    const flairSetting = ((settings[AppSetting.ExistingFlairHandling] as string[] | undefined) ?? [ExistingFlairOverwriteHandling.OverwriteNumeric])[0] as ExistingFlairOverwriteHandling;
    const restrictedText = (settings[AppSetting.PointCapNotMetFlair] as string) ?? "Restricted Poster";
    const pointSymbol = (settings[AppSetting.PointSymbol] as string) ?? "";

    let flairText = "";
    switch (flairSetting) {
        case ExistingFlairOverwriteHandling.OverwriteNumericSymbol:
            flairText = userIsRestricted ? `${restrictedText} | ${currentScore}${pointSymbol}` : `${currentScore}${pointSymbol}`;
            break;
        case ExistingFlairOverwriteHandling.OverwriteNumeric:
            flairText = userIsRestricted ? `${restrictedText} | ${currentScore}` : `${currentScore}`;
            break;
        case ExistingFlairOverwriteHandling.NeverSet:
            flairText = userIsRestricted ? `${restrictedText}` : "";
            break;
    }
    logger.debug("ℹ️ Flair text built", { flairText, flairSetting });

    // 🔹 Apply flair
    let cssClass = settings[AppSetting.CSSClass] as string | undefined;
    let flairTemplate = settings[AppSetting.FlairTemplate] as string | undefined;
    if (flairTemplate && cssClass) cssClass = undefined;

    await context.reddit.setUserFlair({
        subredditName,
        username: authorName,
        cssClass,
        flairTemplateId: flairTemplate,
        text: flairText,
    });
    logger.info("🎨 Flair applied", { authorName, userIsRestricted, flairText, cssClass, flairTemplate });
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

    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const pointSymbol = (settings[AppSetting.PointSymbol] as string) ?? "";

    const userCommandRaw = settings[AppSetting.PointTriggerWords] as
        | string
        | undefined;
    const userCommands = userCommandRaw
        ?.split(/\s+/)
        .map((cmd) => cmd.toLowerCase().trim())
        .filter(Boolean) ?? ["!point"];
    const modCommand = (
        settings[AppSetting.ModAwardCommand] as string | undefined
    )
        ?.toLowerCase()
        .trim();
    const allCommands = [...userCommands, ...(modCommand ? [modCommand] : [])];

    const commentBody = event.comment.body?.toLowerCase() ?? "";
    const containsCommand = allCommands.some((cmd) =>
        commentBody.includes(cmd)
    );

    const isSystemAuthor = ["AutoModerator", context.appName].includes(
        event.author.name
    );
    if (isSystemAuthor && containsCommand) {
        logger.debug("❌ System user attempted a command");
        return;
    }

    if (!containsCommand) {
        logger.debug("❌ Comment does not contain command");
        return;
    }

    // ──────────────── Permission Checks ────────────────
    const awarder = event.author.name;
    const recipient = parentComment.authorName;
    if (!recipient) {
        logger.warn("❌ No recipient found.");
        return;
    }

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

    // ──────────────── Already Awarded Checks ────────────────
    const alreadyKey = `thanks-${parentComment.id}`;
    const alreadyAwarded = await context.redis.exists(alreadyKey);
    if (alreadyAwarded) {
        logger.info(`❌ ${awarder} already awarded this comment`);
        return;
    }

    // ──────────────── Award the Point ────────────────
    const redisKey = POINTS_STORE_KEY;
    const newScore = await context.redis.zIncrBy(redisKey, recipient, 1);

    // Mark as awarded
    await context.redis.set(alreadyKey, "1");

    logger.info(
        `✅ ${awarder} awarded 1 ${pointName} to ${recipient} (new score: ${newScore})`
    );

    // ──────────────── Dynamic Restriction & Flair ────────────────
    const awardsRequired =
        (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) || 0;
    const userRedisKey = `restrictedUser:${recipient}`;

    // Store/update the user's current score in Redis
    await context.redis.set(userRedisKey, newScore.toString());

    // Fetch the score from Redis (ensures numeric comparison)
    const storedScoreRaw = await context.redis.get(userRedisKey);
    const storedScore = storedScoreRaw ? parseInt(storedScoreRaw, 10) : 0;

    //TODO: Make it so that if OP is restricted, it doesn't also make normal users the OP is awarding be restricted
    let userIsRestricted = false;
    const author = await context.reddit.getUserByUsername(recipient);
    if (!author) return;
    if (storedScore < awardsRequired) {
        userIsRestricted = true;

        // Optional: remove post if the user is restricted
        if (event.post.authorId === author.id) {
            await context.reddit.remove(event.post.id, true);
        }

        const notifyMode = settings[
            AppSetting.NotifyOpOnPostRestriction
        ] as string;
        const messageTemplate =
            (settings[AppSetting.AwardRequirementMessage] as string) ??
            TemplateDefaults.AwardRequirementMessage;
        const message = messageTemplate
            .replace("{{author}}", author.username)
            .replace("{{requirement}}", awardsRequired.toString())
            .replace("{{subreddit}}", event.subreddit.name)
            .replace("{{name}}", event.post.title || "")
            .replace(
                "{{permalink}}",
                `https://reddit.com${event.post.permalink}`
            );

        if (notifyMode === "replybypm") {
            await context.reddit.sendPrivateMessage({
                to: author.username,
                subject: "Post Restricted",
                text: message,
            });
        } else if (notifyMode === "replybycomment") {
            await context.reddit.submitComment({
                id: event.post.id,
                text: message,
            });
        }

        logger.info(
            `🚫 ${recipient} restricted from posting (${storedScore}/${awardsRequired})`
        );
    } else {
        // User meets threshold → lift restriction
        const restrictionExists = await context.redis.exists(userRedisKey);
        if (restrictionExists) {
            await context.redis.del(userRedisKey);
            logger.info(
                `✅ ${recipient} restriction lifted (${storedScore}/${awardsRequired})`
            );
        }
    }

    // ──────────────── Update Flair ────────────────
    const flairSetting = ((settings[AppSetting.ExistingFlairHandling] as
        | string[]
        | undefined) ?? [
        ExistingFlairOverwriteHandling.OverwriteNumeric,
    ])[0] as ExistingFlairOverwriteHandling;
    const restrictedText =
        (settings[AppSetting.PointCapNotMetFlair] as string) ??
        "Restricted Poster";

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

    let cssClass = settings[AppSetting.CSSClass] as string | undefined;
    let flairTemplate = settings[AppSetting.FlairTemplate] as
        | string
        | undefined;
    if (flairTemplate && cssClass) cssClass = undefined;

    await context.reddit.setUserFlair({
        subredditName: event.subreddit.name,
        username: recipient,
        cssClass,
        flairTemplateId: flairTemplate,
        text: flairText,
    });

    logger.info(
        userIsRestricted
            ? `🚫 Flair applied: ${recipient} restricted (${flairText})`
            : `✅ Flair applied: ${recipient} unrestricted (${flairText})`
    );

    // ──────────────── Update Leaderboard ────────────────
    await context.scheduler.runJob({
        name: "updateLeaderboard",
        runAt: new Date(),
        data: {
            reason: `Updated ${recipient} to ${newScore} points.`,
        },
    });
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

    await setUserScore(comment.authorName, newScore, context, settings);
    context.ui.showToast(`Score for ${comment.authorName} is now ${newScore}`);
}
