import {
    Comment,
    Context,
    FormOnSubmitEvent,
    JSONObject,
    MenuItemOnPressEvent,
    SettingsValues,
    TriggerContext,
    User,
} from "@devvit/public-api";
import { CommentSubmit, CommentUpdate, PostSubmit } from "@devvit/protos";
import { getSubredditName, isModerator, SafeWikiClient } from "./utility.js";
import {
    ExistingFlairOverwriteHandling,
    AppSetting,
    TemplateDefaults,
    NotifyOnSelfAwardReplyOptions,
    NotifyOnSuccessReplyOptions,
    NotifyOnPointAlreadyAwardedReplyOptions,
    NotifyOnAlternateCommandSuccessReplyOptions,
    NotifyOnAlternateCommandFailReplyOptions,
    NotifyOnPointAlreadyAwardedToUserReplyOptions,
    NotifyOnModOnlyDisallowedReplyOptions,
    NotifyOnApprovedOnlyDisallowedReplyOptions,
    NotifyOnOPOnlyDisallowedReplyOptions,
    NotifyOnDisallowedFlairReplyOptions,
    NotifyOnModAwardSuccessReplyOptions,
    NotifyOnModAwardFailReplyOptions,
    AutoSuperuserReplyOptions,
    NotifyOnRestrictionLiftedReplyOptions,
} from "./settings.js";
import { setCleanupForUsers } from "./cleanupTasks.js";
import { isLinkId } from "@devvit/shared-types/tid.js";
import { logger } from "./logger.js";
import {
    manualPostRestrictionRemovalForm,
    manualSetPointsForm,
} from "./main.js";
import { InitialUserWikiOptions, updateUserWiki } from "./leaderboard.js";

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

    // ─────────────────────────────────────────────────────────
    // 0. Early validation of event data
    // ─────────────────────────────────────────────────────────
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

    // ─────────────────────────────────────────────────────────
    // 1. Redis keys & restriction flags
    // ─────────────────────────────────────────────────────────
    const restrictedFlagKey = `restrictedUser:${author.username}`;
    const requiredFlagKey = `awardsRequired:${author.username}`;
    const lastValidPostKey = `lastValidPost:${author.username}`;
    const lastValidPostTitleKey = `lastValidPostTitle:${author.username}`;

    const restrictedFlagExists = await restrictedKeyExists(context, authorName);

    // If user was restricted and they made a valid post, mark it
    if (!restrictedFlagExists) {
        logger.info("🧹 Restricted user after they made a new post", {
            author: author.username,
            restrictedFlagExists,
        });
        await context.redis.set(restrictedFlagKey, "1");
    }

    // ─────────────────────────────────────────────────────────
    // 2. Leaderboard refresh (always allowed, score doesn’t change)
    // ─────────────────────────────────────────────────────────
    const { currentScore } = await getCurrentScore(author, context, settings);
    await context.scheduler.runJob({
        name: "updateLeaderboard",
        runAt: new Date(),
        data: {
            reason: `Post submit by ${authorName}. Current score: ${currentScore}`,
        },
    });

    // ─────────────────────────────────────────────────────────
    // 3. Check if post-restriction system is enabled
    // ─────────────────────────────────────────────────────────
    const awardsRequiredEntry =
        (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) ?? 0;

    if (awardsRequiredEntry === 0) {
        logger.info("❌ Post restriction is not enabled");
        return;
    }

    // ─────────────────────────────────────────────────────────
    // 4. Moderator exemption
    // ─────────────────────────────────────────────────────────
    const modsExempt =
        (settings[AppSetting.ModeratorsExempt] as boolean) ?? true;
    const isMod = await isModerator(context, subredditName, authorName);

    if (isMod && modsExempt) {
        logger.info(
            `✅ ${author.username} is a moderator and is exempt from restrictions`
        );
        return;
    }

    // ─────────────────────────────────────────────────────────
    // 5. Determine if the user is already restricted
    // ─────────────────────────────────────────────────────────
    const requiredFlagExists = await requiredKeyExists(context, authorName);
    const isRestricted = restrictedFlagExists || requiredFlagExists;

    logger.debug("⚙️ Checking restriction", {
        author: author.username,
        restrictedFlagExists,
        requiredFlagExists,
        awardsRequired: awardsRequiredEntry,
        isRestricted,
    });

    // ─────────────────────────────────────────────────────────
    // Common values used in both branches
    // ─────────────────────────────────────────────────────────
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";

    const triggerWords = (
        (settings[AppSetting.PointTriggerWords] as string) ?? "!award\n.award"
    )
        .split(/\r?\n/)
        .map((w) => w.trim())
        .filter(Boolean);

    const commandList = triggerWords.join(", ");

    const helpPage = settings[AppSetting.PointSystemHelpPage] as
        | string
        | undefined;
    const discordLink = settings[AppSetting.DiscordServerLink] as
        | string
        | undefined;

    // ─────────────────────────────────────────────────────────
    // 6A. FIRST POST — user becomes restricted *after* posting
    // ─────────────────────────────────────────────────────────
    if (!isRestricted) {
        const template =
            (settings[AppSetting.MessageToRestrictedUsers] as string) ??
            TemplateDefaults.MessageToRestrictedUsers;

        let text = template
            .replace(/{{name}}/g, pointName)
            .replace(/{{commands}}/g, commandList)
            .replace(
                /{{markdown_guide}}/g,
                "https://www.reddit.com/wiki/markdown"
            )
            .replace(/{{subreddit}}/g, subredditName);

        if (helpPage) {
            text = text.replace(
                /{{helpPage}}/g,
                `https://www.reddit.com/r/${subredditName}/wiki/${helpPage}`
            );
        }
        if (discordLink) {
            text = text.replace(/{{discord}}/g, discordLink);
        }

        const comment = await context.reddit.submitComment({
            id: event.post.id,
            text,
        });

        await comment.distinguish(true);

        // Save the valid post info
        await context.redis.set(lastValidPostKey, event.post.permalink);
        await context.redis.set(lastValidPostTitleKey, event.post.title);

        // Flag the user as needing awards
        await updateAuthorRedisOnPostSubmit(context, authorName);

        logger.info(
            `✅ First post allowed for ${author.username}. Restriction notice pinned. Future posts restricted until ${awardsRequiredEntry} awards.`
        );

        return;
    }

    // ─────────────────────────────────────────────────────────
    // 6B. SUBSEQUENT POSTS — user is restricted
    // ─────────────────────────────────────────────────────────
    const subsequentTemplate =
        (settings[AppSetting.SubsequentPostRestrictionMessage] as string) ??
        TemplateDefaults.SubsequentPostRestrictionMessage;

    const title = await context.redis.get(lastValidPostTitleKey);
    const lastValidPost = await context.redis.get(lastValidPostKey);
    const requirement =
        (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) ?? 0;

    let msg = subsequentTemplate
        .replace(/{{name}}/g, pointName)
        .replace(/{{commands}}/g, commandList)
        .replace(/{{markdown_guide}}/g, "https://www.reddit.com/wiki/markdown")
        .replace(/{{requirement}}/g, requirement.toString())
        .replace(/{{subreddit}}/g, subredditName);

    if (title) msg = msg.replace(/{{title}}/g, title);
    if (lastValidPost) msg = msg.replace(/{{permalink}}/g, lastValidPost);
    if (helpPage) {
        msg = msg.replace(
            /{{helpPage}}/g,
            `https://www.reddit.com/r/${subredditName}/wiki/${helpPage}`
        );
    }
    if (discordLink) msg = msg.replace(/{{discord}}/g, discordLink);

    // Post restriction comment
    const comment = await context.reddit.submitComment({
        id: event.post.id,
        text: msg,
    });

    await comment.distinguish(true);
    await context.reddit.remove(event.post.id, false);

    logger.info("🚫 Removed post from restricted user", {
        username: author.username,
        postId: event.post.id,
    });
}

async function getUserIsAltUser(
    username: string,
    context: TriggerContext
): Promise<boolean> {
    const settings = await context.settings.getAll();

    const altUserSetting =
        (settings[AppSetting.AlternatePointCommandUsers] as
            | string
            | undefined) ?? "";
    const altUsers = altUserSetting
        .split(",")
        .map((user) => user.trim().toLowerCase());

    if (altUsers.includes(username.toLowerCase())) {
        return true;
    } else {
        return false;
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

export function getIgnoredContextType(
    commentBody: string,
    command: string
): "quote" | "alt" | "spoiler" | undefined {
    const quoteBlock = `> .*${command}.*`;
    const altText = `\`.*${command}.*\``;
    const spoilerText = `>!.*${command}.*!<`;

    const patterns: { type: "quote" | "alt" | "spoiler"; regex: RegExp }[] = [
        { type: "quote", regex: new RegExp(`${quoteBlock}`, "i") },
        { type: "alt", regex: new RegExp(`${altText}`, "i") },
        { type: "spoiler", regex: new RegExp(`${spoilerText}`, "i") },
    ];

    for (const { type, regex } of patterns) {
        if (regex.test(commentBody)) return type;
    }
    return undefined;
}
// Detect if trigger word is inside quote (> ), alt text [text](url), or spoiler (>! !<)
function commandUsedInIgnoredContext(
    commentBody: string,
    command: string
): boolean {
    const quoteBlock = `> .*${command}.*`;
    const altText = `\`.*${command}.*\``;
    const spoilerText = `>!.*${command}.*!<`;

    const patterns = [
        // Quote block: > anything with command
        new RegExp(`${quoteBlock}`, "i"),

        // Alt text: [anything including command using `grave accent`]
        new RegExp(`${altText}`, "i"),

        // Spoiler block: >! anything with command !<
        new RegExp(`${spoilerText}`, "i"),
    ];

    return patterns.some((p) => p.test(commentBody));
}

// ────────────────────────────────
// Generic low-level helper
// ────────────────────────────────
async function _replyToUser(
    context: TriggerContext,
    toUserName: string,
    messageBody: string,
    commentId: string,
    replyMode: string
) {
    if (replyMode === "none") return;

    if (replyMode === "replybypm") {
        const subredditName =
            context.subredditName ??
            (await context.reddit.getCurrentSubredditName());
        try {
            await context.reddit.sendPrivateMessage({
                subject: `Message from TheRepBot on ${subredditName}`,
                text: messageBody,
                to: toUserName,
            });
            console.log(`${commentId}: PM sent to ${toUserName}.`);
        } catch {
            console.log(
                `${commentId}: Error sending PM to ${toUserName}. User may only allow PMs from whitelisted users.`
            );
        }
    } else if (replyMode === "replybycomment") {
        const newComment = await context.reddit.submitComment({
            id: commentId,
            text: messageBody,
        });
        await Promise.all([newComment.distinguish(), newComment.lock()]);
        console.log(
            `${commentId}: Public comment reply left for ${toUserName}`
        );
    } else {
        console.warn(`${commentId}: Unknown replyMode "${replyMode}"`);
    }
}

// Helper: notify user when they hit the auto-superuser threshold
async function maybeNotifyAutoSuperuser(
    context: TriggerContext,
    settings: SettingsValues,
    awardeeUsername: string,
    awardCommentPermalink: string,
    awardCommentId: string,
    newScore: number,
    modCommand: string
): Promise<void> {
    const autoSuperuserThreshold =
        (settings[AppSetting.AutoSuperuserThreshold] as number | undefined) ??
        0;

    const notifyOnAutoSuperuser = ((settings[
        AppSetting.NotifyOnAutoSuperuser
    ] as string[] | undefined) ?? [AutoSuperuserReplyOptions.NoReply])[0];

    if (
        !autoSuperuserThreshold ||
        notifyOnAutoSuperuser === AutoSuperuserReplyOptions.NoReply ||
        newScore !== autoSuperuserThreshold
    ) {
        return;
    }

    let message = formatMessage(
        (settings[AppSetting.NotifyOnAutoSuperuserTemplate] as
            | string
            | undefined) ?? TemplateDefaults.NotifyOnSuperuserTemplate,
        //name, threshold, command
        {
            name: (settings[AppSetting.PointName] as string) ?? "point",
            threshold: autoSuperuserThreshold.toString(),
            awardee: awardeeUsername,
            permalink: awardCommentPermalink,
        }
    );

    const notifyOnAutoSuperuserString = ((settings[
        AppSetting.NotifyOnAutoSuperuser
    ] as string[] | undefined) ?? [
        AutoSuperuserReplyOptions.NoReply,
    ])[0] as AutoSuperuserReplyOptions;

    // `replyToUser` expects a ReplyOptions enum; we assume values match
    await _replyToUser(
        context,
        notifyOnAutoSuperuserString,
        awardeeUsername,
        message,
        awardCommentId
    );

    logger.info("⭐ Auto-superuser threshold reached and user notified", {
        awardeeUsername,
        autoSuperuserThreshold,
    });
}

async function maybeNotifyRestrictionLifted(
    context: TriggerContext,
    event: CommentSubmit | CommentUpdate,
    username: string
): Promise<void> {
    // ──────────────── Redis Keys ────────────────
    const restrictedKey = `restrictedUser:${username}`;
    const requiredKey = `awardsRequired:${username}`;
    const lastValidPostKey = `lastValidPost:${username}`;
    const lastValidTitleKey = `lastValidPostTitle:${username}`;
    const awaitingPostKey = `awaitingPost:${username}`;

    logger.debug("🔔 maybeNotifyRestrictionLifted called", {
        username,
        restrictedKey,
        requiredKey,
        awaitingPostKey,
    });

    try {
        const [restrictedExists, remainingRaw] = await Promise.all([
            context.redis.exists(restrictedKey),
            context.redis.get(requiredKey),
        ]);

        logger.debug("📊 Restriction state snapshot", {
            username,
            restrictedExists,
            remainingRaw,
        });

        let remaining: number | null = null;
        if (remainingRaw) {
            const parsedRemaining = Number(remainingRaw);
            if (Number.isFinite(parsedRemaining) && parsedRemaining >= 0) {
                remaining = parsedRemaining;
            } else {
                logger.warn(
                    "⚠️ Invalid remaining awardsRequired value; treating as null",
                    { username, remainingRaw }
                );
            }
        }

        // If still restricted → do nothing
        if (restrictedExists || (remaining !== null && remaining > 0)) {
            logger.debug(
                "ℹ️ User still restricted; not sending restriction-lift message",
                { username, restrictedExists, remaining }
            );
            return;
        }

        // At this point:
        // restrictedKey does NOT exist
        // remaining is null or 0
        // → Restriction has been fully lifted

        const settings = await context.settings.getAll();

        // Determine notification mode
        const notifySetting = (settings[
            AppSetting.NotifyOnRestrictionLifted
        ] as string[] | undefined) ?? [
            NotifyOnRestrictionLiftedReplyOptions.NoReply,
        ];

        const notifyMode =
            (notifySetting[0] as NotifyOnRestrictionLiftedReplyOptions) ??
            NotifyOnRestrictionLiftedReplyOptions.NoReply;

        logger.debug("⚙️ NotifyOnRestrictionLifted setting resolved", {
            username,
            notifyMode,
        });

        // If notify = none → still set awaitingPostKey
        if (notifyMode === NotifyOnRestrictionLiftedReplyOptions.NoReply) {
            logger.info(
                "✅ Restriction lifted; no notification required. Setting awaitingPostKey",
                { username }
            );

            await Promise.all([
                context.redis.del(lastValidPostKey),
                context.redis.del(lastValidTitleKey),
                context.redis.del(requiredKey),
                context.redis.del(restrictedKey),
                // Set awaitingPostKey = "1"
                context.redis.set(awaitingPostKey, "1"),
            ]);
            if ((await context.redis.get(awaitingPostKey)) === "1") {
                logger.info(
                    `Awaiting new post by ${event.author?.name}. No notification allowed.`
                );
                return;
            }
        }

        if ((await context.redis.get(awaitingPostKey)) === "1") {
            logger.info(
                `Awaiting new post by ${event.author?.name}. No notification necessary.`
            );
            return;
        }

        // Build message template
        const pointName =
            (settings[AppSetting.PointName] as string | undefined) ?? "point";
        const awardsRequired =
            (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) ??
            0;

        const helpPage = settings[AppSetting.PointSystemHelpPage] as
            | string
            | undefined;
        const discordLink = settings[AppSetting.DiscordServerLink] as
            | string
            | undefined;

        const subredditName =
            event.subreddit?.name ??
            (await context.reddit.getCurrentSubreddit()).name;

        const template =
            (settings[AppSetting.RestrictionRemovedMessage] as string) ??
            TemplateDefaults.RestrictionRemovedMessage;

        const messageBody = formatMessage(template, {
            awarder: username,
            name: pointName,
            subreddit: subredditName,
            requirement: awardsRequired.toString(),
            helpPage: helpPage
                ? `https://old.reddit.com/r/${subredditName}/wiki/${helpPage}`
                : "",
            discord: discordLink ?? "",
        });

        logger.debug("✉️ Built restriction-removed message body", {
            username,
            messagePreview: messageBody.slice(0, 200),
        });

        // Deliver notification
        if (
            notifyMode === NotifyOnRestrictionLiftedReplyOptions.ReplyAsComment
        ) {
            if (!event.comment) {
                logger.warn(
                    "⚠️ No comment in event; falling back to PM notification",
                    { username }
                );

                await context.reddit.sendPrivateMessage({
                    to: username,
                    subject: `Your posting restriction has been lifted in r/${subredditName}`,
                    text: messageBody,
                });
            } else {
                const reply = await context.reddit.submitComment({
                    id: event.comment.id,
                    text: messageBody,
                });
                await reply.distinguish();
            }
        } else if (
            notifyMode === NotifyOnRestrictionLiftedReplyOptions.ReplyByPM
        ) {
            await context.reddit.sendPrivateMessage({
                to: username,
                subject: `Your posting restriction has been lifted in r/${subredditName}`,
                text: messageBody,
            });
        }

        // 🔥 Clean up state and set awaitingPostKey = "1"
        await Promise.all([
            context.redis.del(lastValidPostKey),
            context.redis.del(lastValidTitleKey),
            context.redis.del(requiredKey),
            context.redis.set(awaitingPostKey, "1"), // NEW: mark that the user must make a new post
        ]);

        logger.info("📬 Restriction lift notification sent", {
            username,
            notifyMode,
        });
    } catch (err) {
        logger.error("❌ Error while checking / notifying restriction lift", {
            username,
            err,
        });
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

    // ─────────────────────────────────────────────────────────────
    // Guards
    // ─────────────────────────────────────────────────────────────
    if (!event.comment || !event.post || !event.author || !event.subreddit) {
        logger.warn("❌ Missing required event data.");
        return;
    }

    let parentComment: Comment | undefined;
    try {
        parentComment = await context.reddit.getCommentById(
            event.comment.parentId
        );
    } catch {
        parentComment = undefined;
    }

    if (!parentComment) {
        logger.warn("❌ Parent comment not found (normal/mod flow).");
        return;
    }

    // ─────────────────────────────────────────────────────────────
    // Settings & common locals
    // ─────────────────────────────────────────────────────────────
    const awarder = event.author.name;
    const settings = await context.settings.getAll();
    const subredditName = event.subreddit.name;
    const commentBodyRaw = event.comment.body ?? "";
    const commentBody = commentBodyRaw.toLowerCase();

    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const pointSymbol = (settings[AppSetting.PointSymbol] as string) ?? "";
    const redisKey = POINTS_STORE_KEY;

    const accessControl = ((settings[AppSetting.AccessControl] as string[]) ?? [
        "everyone",
    ])[0];

    const isMod = await isModerator(context, subredditName, awarder);
    const isSuperUser = await getUserIsSuperuser(awarder, context);
    const userIsAltUser = await getUserIsAltUser(awarder, context);
    const isOP = event.author.id === event.post.authorId;

    // ─────────────────────────────────────────────────────────────
    // Disallowed flair scaffolding (normal flow only — ALT bypasses)
    // ─────────────────────────────────────────────────────────────
    const disallowedFlairList = (
        (settings[AppSetting.DisallowedFlairs] as string) ?? ""
    )
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    const notifyModOnly = ((settings[
        AppSetting.NotifyOnModOnlyDisallowed
    ] as string[]) ?? [NotifyOnModOnlyDisallowedReplyOptions.NoReply])[0];
    const notifyApprovedOnly = ((settings[
        AppSetting.NotifyOnApprovedOnlyDisallowed
    ] as string[]) ?? [NotifyOnApprovedOnlyDisallowedReplyOptions.NoReply])[0];
    const notifyOPOnly = ((settings[
        AppSetting.NotifyOnOPOnlyDisallowed
    ] as string[]) ?? [NotifyOnOPOnlyDisallowedReplyOptions.NoReply])[0];
    const notifyDisallowedFlair = ((settings[
        AppSetting.NotifyOnDisallowedFlair
    ] as string[]) ?? [NotifyOnDisallowedFlairReplyOptions.NoReply])[0];

    const msgModOnly =
        (settings[AppSetting.ModOnlyDisallowedMessage] as string) ??
        TemplateDefaults.ModOnlyDisallowedMessage;
    const msgApprovedOnly =
        (settings[AppSetting.ApprovedOnlyDisallowedMessage] as string) ??
        TemplateDefaults.ApprovedOnlyDisallowedMessage;
    const msgOPOnly =
        (settings[AppSetting.OPOnlyDisallowedMessage] as string) ??
        TemplateDefaults.OPOnlyDisallowedMessage;
    const msgDisallowedFlair =
        (settings[AppSetting.DisallowedFlairMessage] as string) ??
        TemplateDefaults.DisallowedFlairMessage;

    // Success path notifications (normal flow)
    const notifySuccess = ((settings[
        AppSetting.NotifyOnSuccess
    ] as string[]) ?? ["none"])[0];

    // Duplicate (normal flow)
    const dupAlreadyMessage =
        (settings[AppSetting.DuplicateAwardMessage] as string) ??
        TemplateDefaults.DuplicateAwardMessage;
    const notifyDup = ((settings[
        AppSetting.NotifyOnPointAlreadyAwarded
    ] as string[]) ?? ["none"])[0];

    // Self-award
    const selfMsgTemplate =
        (settings[AppSetting.SelfAwardMessage] as string) ??
        TemplateDefaults.NotifyOnSelfAwardTemplate;
    const notifySelf = ((settings[
        AppSetting.NotifyOnSelfAward
    ] as string[]) ?? [NotifyOnSelfAwardReplyOptions.NoReply])[0];

    // Bot self-award
    const botAwardMessage = formatMessage(
        (settings[AppSetting.BotAwardMessage] as string) ??
            TemplateDefaults.BotAwardMessage,
        { name: pointName }
    );

    // Alternate Command users list (expects values like: u/example)
    const altCommandUsersRaw =
        (settings[AppSetting.AlternatePointCommandUsers] as string) ?? "";
    const altCommandUsers = altCommandUsersRaw
        .split("\n")
        .map((u) => u.trim().toLowerCase())
        .filter(Boolean);

    // Alt success/fail notify & messages
    const notifyAltSuccess = ((settings[
        AppSetting.NotifyOnAlternateCommandSuccess
    ] as string[]) ?? [NotifyOnAlternateCommandSuccessReplyOptions.NoReply])[0];
    const notifyAltFail = ((settings[
        AppSetting.NotifyOnAlternateCommandFail
    ] as string[]) ?? [NotifyOnAlternateCommandFailReplyOptions.NoReply])[0];

    const altSuccessMessageTemplate =
        (settings[AppSetting.AlternateCommandSuccessMessage] as string) ??
        TemplateDefaults.AlternateCommandSuccessMessage;
    const altFailMessageTemplate =
        (settings[AppSetting.AlternateCommandFailMessage] as string) ??
        TemplateDefaults.AlternateCommandFailMessage;
    // Triggers: normal user commands (array of strings)
    const userCommands = (
        (settings[AppSetting.PointTriggerWords] as string) ?? "!award\n.award"
    )
        .split("\n")
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => c.toLowerCase());

    // Superuser/Mod award command
    const modCommand = (
        (settings[AppSetting.ModAwardCommand] as string) ?? "!modaward"
    )
        .toLowerCase()
        .trim();

    const allTriggers = Array.from(
        new Set([...userCommands, modCommand].filter((t) => t && t.length > 0))
    );

    // helper to escape regex
    function escapeForRegex(str: string) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    // ─────────────────────────────────────────────────────────────
    // Redis Keys (LOGIC PRESERVING)
    // ─────────────────────────────────────────────────────────────

    const recipient = parentComment.authorName;
    const commentId = event.comment.id;
    const postId = event.post.id;
    const postLink = event.post.permalink;
    const postTitle = event.post.title;

    const userBlockedFromAwardingPointsKey = `award:block:${subredditName}:${awarder}`;

    const userIsAuthorizedModAwardKey = `award:mod:auth:${subredditName}:${awarder}`;

    const originalAltDupKey = `award:alt:dup:${postId}`;

    const altSuccessKey = `award:alt:success:${commentId}`;

    const normalDupKey = `award:normal:dup:${commentId}:${awarder}`;

    const normalSuccess = `award:normal:success:${commentId}`;

    const selfAwardKey = `award:self:${commentId}:${awarder}`;

    const modDupKey = `award:mod:dup:${parentComment.id}`;

    const modSuccessKey = `award:mod:success:${commentId}`;

    const disallowedFlairKey = `award:blocked:flair:${postId}`;
    // ─────────────────────────────────────────────────────────────
    // Early Redis guards
    // ─────────────────────────────────────────────────────────────

    if ((await context.redis.get(selfAwardKey)) === "1") {
        logger.debug("⛔ Recipient tried to award themselves", {
            awarder,
            recipient,
        });
        return;
    }
    if ((await context.redis.get(normalDupKey)) === "1") {
        logger.debug("⛔ Comment has already received a normal award", {
            commentId,
            commentBodyRaw,
        });
        return;
    }
    if ((await context.redis.get(modDupKey)) === "1") {
        logger.debug("⛔ Comment has already received a mod award", {
            commentId,
            commentBodyRaw,
        });
        return;
    }
    if ((await context.redis.get(disallowedFlairKey)) === "1") {
        logger.debug("⛔ Post has disallowed flair", {
            postId,
            postTitle,
            postLink,
        });
        return;
    }
    if ((await context.redis.get(userBlockedFromAwardingPointsKey)) === "1") {
        logger.debug("⛔ User currently blocked from awarding points", {
            awarder,
        });
        return;
    }

    if (
        (await context.redis.get(altSuccessKey)) === `${commentId}-alt-success`
    ) {
        logger.debug("🧩 ALT award already handled for this comment", {
            commentId,
        });
        return;
    }

    if ((await context.redis.get(normalSuccess)) === "1") {
        logger.debug("🧩 Normal award already handled for this comment", {
            commentId,
        });
        return;
    }

    if ((await context.redis.get(selfAwardKey)) === "1") {
        logger.debug("🧩 Self-award already handled for this comment", {
            commentId,
        });
        return;
    }

    if ((await context.redis.get(normalDupKey)) === "1") {
        const dupMsg = formatMessage(dupAlreadyMessage, { name: pointName });

        if (notifyDup === NotifyOnPointAlreadyAwardedReplyOptions.ReplyByPM) {
            await context.reddit.sendPrivateMessage({
                to: awarder,
                subject: `Duplicate award attempt`,
                text: dupMsg,
            });
        } else if (
            notifyDup === NotifyOnPointAlreadyAwardedReplyOptions.ReplyAsComment
        ) {
            const newComment = await context.reddit.submitComment({
                id: event.comment.id,
                text: dupMsg,
            });
            await newComment.distinguish();
        }

        logger.info("❌ Duplicate award attempt (normal)", {
            awarder,
            parentId: parentComment.id,
        });
        return;
    }

    // ─────────────────────────────────────────────────────────────
    // Detect trigger in comment
    // ─────────────────────────────────────────────────────────────

    const triggerUsed = allTriggers.find((t) => commentBody.includes(t));

    if (!triggerUsed) {
        logger.debug("❌ No valid award command found in comment");
        return;
    }

    const usedCommandRaw = triggerUsed; // preserve original case
    const usedCommand = usedCommandRaw.toLowerCase();

    logger.debug("🧩 Command detected", { triggerUsed: usedCommandRaw });

    // System users banned from awarding
    if (
        ["automoderator", context.appName.toLowerCase()].includes(
            awarder.toLowerCase()
        )
    ) {
        logger.debug("❌ System user attempted a command");
        return;
    }

    // ─────────────────────────────────────────────────────────────
    // ALT Mention Flow (non-modCommand, ALT user)
    // ─────────────────────────────────────────────────────────────

    let mentionedUsername: string | undefined;
    const altCommandMatch = commentBody.match(
        new RegExp(`${escapeForRegex(triggerUsed)}\\s+(\\S+)`, "i")
    );

    if (
        userIsAltUser &&
        altCommandMatch &&
        userCommands.includes(triggerUsed)
    ) {
        // candidate username
        const validMatch = commentBody.match(
            new RegExp(
                `${escapeForRegex(triggerUsed)}\\s+u/([a-z0-9_-]{3,21})`,
                "i"
            )
        );

        logger.debug("🧩 ALT trigger check", { triggerUsed, validMatch });

        if (validMatch) {
            mentionedUsername = validMatch[1];
        }
    }
    // Validate username length
    if (mentionedUsername) {
        const mentionUsername = mentionedUsername;

        if (mentionUsername.length < 3 || mentionUsername.length > 21) {
            const lengthMsg = formatMessage(
                (settings[AppSetting.UsernameLengthMessage] as string) ??
                    TemplateDefaults.UsernameLengthMessage,
                { awarder, awardee: mentionUsername }
            );

            const reply = await context.reddit.submitComment({
                id: event.comment.id,
                text: lengthMsg,
            });
            await reply.distinguish();

            logger.warn("❌ ALT username length invalid", {
                awarder,
                mentionUsername,
            });
            return;
        }

        // Validate allowed characters
        if (!/^[a-z0-9_-]+$/i.test(mentionUsername)) {
            const invalidCharMsg = formatMessage(
                (settings[AppSetting.InvalidUsernameMessage] as string) ??
                    TemplateDefaults.InvalidUsernameMessage,
                { awarder, awardee: mentionUsername }
            );

            const reply = await context.reddit.submitComment({
                id: event.comment.id,
                text: invalidCharMsg,
            });
            await reply.distinguish();

            logger.warn("❌ ALT username contains invalid characters", {
                awarder,
                mentionUsername,
            });
            return;
        }

        // Unauthorized ALT user check
        const authorized = altCommandUsers.includes(awarder.toLowerCase());

        if (!authorized) {
            const failMsg = formatMessage(altFailMessageTemplate, {
                altCommand: triggerUsed,
                subreddit: subredditName,
            });

            if (
                notifyAltFail ===
                NotifyOnAlternateCommandFailReplyOptions.ReplyAsComment
            ) {
                const failComment = await context.reddit.submitComment({
                    id: event.comment.id,
                    text: failMsg,
                });
                await failComment.distinguish();
            } else if (
                notifyAltFail ===
                NotifyOnAlternateCommandFailReplyOptions.ReplyByPM
            ) {
                await context.reddit.sendPrivateMessage({
                    to: awarder,
                    subject: "Alternate Command Not Allowed",
                    text: failMsg,
                });
            }

            logger.warn("🚫 Unauthorized ALT award attempt", {
                awarder,
                mentionedUsername,
            });
            return;
        }

        // Duplicate ALT check
        const altDupKey = `customAward-${event.post.id}-${mentionedUsername}`;
        if (
            (await context.redis.get(altDupKey)) ===
            `customAward-${event.post.id}-${mentionedUsername}`
        ) {
            const dupMsg = formatMessage(
                (settings[
                    AppSetting.PointAlreadyAwardedToUserMessage
                ] as string) ??
                    TemplateDefaults.PointAlreadyAwardedToUserMessage,
                { name: pointName, awardee: mentionedUsername }
            );

            if (
                notifyAltSuccess ===
                NotifyOnAlternateCommandSuccessReplyOptions.ReplyAsComment
            ) {
                const newComment = await context.reddit.submitComment({
                    id: event.comment.id,
                    text: dupMsg,
                });
                await newComment.distinguish();
            } else if (
                notifyAltSuccess ===
                NotifyOnAlternateCommandSuccessReplyOptions.ReplyByPM
            ) {
                await context.reddit.sendPrivateMessage({
                    to: awarder,
                    subject: "Already Awarded",
                    text: dupMsg,
                });
            }

            logger.info("❌ Duplicate ALT award attempt", {
                awarder,
                mentionedUsername,
            });
            return;
        }

        // Record ALT award in Redis
        await context.redis.set(
            altDupKey,
            `customAward-${event.post.id}-${mentionedUsername}`
        );

        // Increment score
        const newScore = await context.redis.zIncrBy(
            redisKey,
            mentionedUsername,
            1
        );

        // Leaderboard update
        await context.scheduler.runJob({
            name: "updateLeaderboard",
            runAt: new Date(),
            data: {
                reason: `ALT award from ${awarder} to ${mentionedUsername} (new: ${newScore})`,
            },
        });

        // Notify success
        const leaderboard = `https://old.reddit.com/r/${subredditName}/wiki/${
            settings[AppSetting.LeaderboardName] ?? "leaderboard"
        }`;
        const awardeePage = `https://old.reddit.com/r/${event.subreddit.name}/wiki/user/${mentionedUsername}`;

        const successMsg = formatMessage(altSuccessMessageTemplate, {
            name: pointName,
            awardee: mentionedUsername,
            awarder,
            total: newScore.toString(),
            symbol: pointSymbol,
            leaderboard,
            awardeePage,
        });

        if (
            notifyAltSuccess ===
            NotifyOnAlternateCommandSuccessReplyOptions.ReplyAsComment
        ) {
            const newComment = await context.reddit.submitComment({
                id: event.comment.id,
                text: successMsg,
            });
            await newComment.distinguish();
        } else if (
            notifyAltSuccess ===
            NotifyOnAlternateCommandSuccessReplyOptions.ReplyByPM
        ) {
            await context.reddit.sendPrivateMessage({
                to: awarder,
                subject: "ALT Award Successful",
                text: successMsg,
            });
        }

        // Flair update (ALT)
        try {
            const recipientUser = await context.reddit.getUserByUsername(
                mentionedUsername
            );
            if (recipientUser) {
                const { currentScore: recipientScore } = await getCurrentScore(
                    recipientUser,
                    context,
                    settings
                );
                const zscore = await context.redis.zScore(
                    redisKey,
                    mentionedUsername
                );
                const recipientIsRestricted = await getUserIsRestricted(
                    mentionedUsername,
                    context
                );

                await updateAwardeeFlair(
                    context,
                    subredditName,
                    mentionedUsername,
                    (zscore ?? recipientScore) || 0,
                    settings,
                    recipientIsRestricted
                );
                logger.info("🎨 ALT flair updated", {
                    mentionedUsername,
                    score: zscore ?? recipientScore,
                });
            }
        } catch (err) {
            logger.error("❌ ALT flair update failed", { err });
        }
        // Update ALT user wikis
        try {
            const givenData = {
                postTitle: event.post.title,
                postUrl: event.post.permalink,
                recipient: mentionedUsername,
                commentUrl: event.comment.permalink,
            };
            await updateUserWiki(
                context,
                awarder,
                mentionedUsername,
                givenData
            );
        } catch (err) {
            logger.error("❌ Failed to update ALT user wiki", {
                awarder,
                mentionedUsername,
                err,
            });
        }

        // Mark ALT award success in Redis
        await context.redis.set(altSuccessKey, `${commentId}AwardSuccess`);

        return; // ALT flow handled completely
    }

    // ─────────────────────────────────────────────────────────────
    // MOD AWARD + NORMAL FLOW relies on parent comment
    // ─────────────────────────────────────────────────────────────

    // Guard: parent comment must not be a link
    if (isLinkId(event.comment.parentId)) {
        logger.debug("❌ Parent ID is a link — ignoring (normal/mod flow).");
        return;
    }

    // Guard: recipient must exist
    if (!recipient) {
        logger.warn("❌ No recipient found (normal/mod flow).");
        return;
    }

    // Check ignored contexts for each trigger in comment
    for (const trigger of allTriggers) {
        if (!new RegExp(`${escapeForRegex(trigger)}`, "i").test(commentBody))
            continue;

        if (commandUsedInIgnoredContext(commentBody, trigger)) {
            const ignoredText = getIgnoredContextType(commentBody, trigger);
            if (ignoredText) {
                const ignoreKey = `ignoreDM:${event.author.name.toLowerCase()}:${ignoredText}`;
                const alreadyConfirmed = await context.redis.exists(ignoreKey);

                if (!alreadyConfirmed) {
                    const contextLabel =
                        ignoredText === "quote"
                            ? "a quote block (`> this`)"
                            : ignoredText === "alt"
                            ? "alt text (``this``)"
                            : "a spoiler block (`>!this!<`)";

                    const dmText = `Hey u/${event.author.name}, I noticed you used the command **${trigger}** inside ${contextLabel}.\n\nIf this was intentional, reply with **CONFIRM** (in all caps) on [the comment that triggered this](${event.comment.permalink}) and you will not receive this message again for ${ignoredText} text.\n\n---\n\n^(I am a bot - please contact the mods of ${event.subreddit.name} with any questions)\n\n---`;

                    await context.reddit.sendPrivateMessage({
                        to: event.author.name,
                        subject: `Your ${trigger} command was ignored`,
                        text: dmText,
                    });

                    await context.redis.set(
                        `pendingConfirm:${event.author.name.toLowerCase()}`,
                        ignoredText
                    );

                    logger.info(
                        "⚠️ Ignored command in special context; DM sent.",
                        { user: event.author.name, trigger, ignoredText }
                    );
                } else {
                    logger.info(
                        "ℹ️ Ignored command in special context; user pre-confirmed no DMs.",
                        { user: event.author.name, trigger, ignoredText }
                    );
                }

                return; // stop here — do NOT award points
            }
        }
    }

    // Guard: bot cannot be awardee
    if (recipient === context.appName) {
        const newComment = await context.reddit.submitComment({
            id: event.comment.id,
            text: botAwardMessage,
        });
        await newComment.distinguish();
        logger.debug("❌ Bot cannot award itself points");
        return;
    }

    // ─────────────────────────────────────────────────────────────
    // MOD AWARD FLOW
    // ─────────────────────────────────────────────────────────────
    if (usedCommand === modCommand) {
        logger.debug("🔧 ModAwardCommand detected", {
            modCommand,
            triggerUsed: usedCommandRaw,
        });

        // Extract username after modCommand if present
        let modAwardUsername: string | undefined;
        const idx = commentBody.indexOf(usedCommand);
        if (idx >= 0) {
            const after =
                commentBodyRaw
                    .slice(idx + usedCommandRaw.length)
                    .trim()
                    .split(/\s+/)[0] ?? "";

            if (after) {
                modAwardUsername = after.startsWith("u/")
                    ? after.slice(2)
                    : after;
            }
        }

        if (modAwardUsername) {
            modAwardUsername = modAwardUsername.toLowerCase();
        }

        // Default to parent comment author if no valid token
        if (!modAwardUsername || !/^[a-z0-9_-]{3,21}$/.test(modAwardUsername)) {
            modAwardUsername = recipient.toLowerCase();
            logger.debug(
                "ℹ️ No explicit username after modCommand; using parent comment author",
                { modAwardUsername }
            );
        } else {
            logger.debug("🎯 ModAward target token detected", {
                modAwardUsername,
            });
        }

        // Bot self-prevention
        if (modAwardUsername === context.appName.toLowerCase()) {
            const newComment = await context.reddit.submitComment({
                id: event.comment.id,
                text: botAwardMessage,
            });
            await newComment.distinguish();
            logger.debug("❌ Bot cannot receive mod awards either");
            return;
        }

        // Authorization check (must be mod or superuser)
        const authorized = isMod || isSuperUser;
        if (!authorized) {
            const failTemplate =
                (settings[AppSetting.ModAwardCommandFail] as string) ??
                TemplateDefaults.ModAwardCommandFailMessage;
            const failMsg = formatMessage(failTemplate, {
                command: usedCommandRaw,
                name: pointName,
                awarder,
            });

            const notifyModFail = ((settings[
                AppSetting.NotifyOnModAwardFail
            ] as string[]) ?? [NotifyOnModAwardFailReplyOptions.NoReply])[0];

            if (
                notifyModFail ===
                NotifyOnModAwardFailReplyOptions.ReplyAsComment
            ) {
                const comment = await context.reddit.submitComment({
                    id: event.comment.id,
                    text: failMsg,
                });
                await comment.distinguish();
            } else if (
                notifyModFail === NotifyOnModAwardFailReplyOptions.ReplyByPM
            ) {
                await context.reddit.sendPrivateMessage({
                    to: awarder,
                    subject: "Mod Award Command Not Allowed",
                    text: failMsg,
                });
            }

            logger.warn("🚫 Unauthorized mod award attempt", {
                awarder,
                modAwardUsername,
            });
            await context.redis.set(
                userIsAuthorizedModAwardKey,
                `${awarder}-authorized`
            );
            return;
        }

        await context.redis.set(
            userIsAuthorizedModAwardKey,
            `${awarder}-notAuthorized`
        );
        // Duplicate key specific to mod-award (comment + target)
        const modDupKey = `modAward-${parentComment.id}`;
        if (await context.redis.exists(modDupKey)) {
            const alreadyMsg =
                (settings[AppSetting.ModAwardAlreadyGiven] as string) ??
                TemplateDefaults.ModAwardAlreadyGivenMessage;

            const out = formatMessage(alreadyMsg, {
                awardee: modAwardUsername,
                name: pointName,
            });

            const notifyAlready = ((settings[
                AppSetting.NotifyOnModAwardFail
            ] as string[]) ?? [NotifyOnModAwardFailReplyOptions.NoReply])[0];

            if (
                notifyAlready ===
                NotifyOnModAwardFailReplyOptions.ReplyAsComment
            ) {
                const newComment = await context.reddit.submitComment({
                    id: event.comment.id,
                    text: out,
                });
                await newComment.distinguish();
            } else if (
                notifyAlready === NotifyOnModAwardFailReplyOptions.ReplyByPM
            ) {
                await context.reddit.sendPrivateMessage({
                    to: awarder,
                    subject: "Mod Award Already Given",
                    text: out,
                });
            }

            logger.info("❌ Mod award duplicate attempt", {
                awarder,
                modAwardUsername,
            });
            await context.redis.set(modDupKey, "1");
            return;
        }

        // Increment score (mod-award)
        const newScore = await context.redis.zIncrBy(
            redisKey,
            modAwardUsername,
            1
        );

        // Leaderboard update
        await context.scheduler.runJob({
            name: "updateLeaderboard",
            runAt: new Date(),
            data: {
                reason: `Mod award from ${awarder} to ${modAwardUsername} (new: ${newScore})`,
            },
        });

        // Build success message
        const modSuccessTemplate =
            (settings[AppSetting.ModAwardCommandSuccess] as string) ??
            TemplateDefaults.ModAwardCommandSuccessMessage;

        let user: User | undefined;
        try {
            user = await context.reddit.getUserByUsername(modAwardUsername);
        } catch {
            //
        }
        if (!user) {
            logger.warn("⚠️ Mod award target user not found", {
                modAwardUsername,
            });
            return;
        }

        const leaderboard = `https://old.reddit.com/r/${subredditName}/wiki/${
            settings[AppSetting.LeaderboardName] ?? "leaderboard"
        }`;
        const awardeePage = `https://old.reddit.com/r/${event.subreddit.name}/wiki/user/${modAwardUsername}`;
        const successMessage = formatMessage(modSuccessTemplate, {
            awardee: modAwardUsername,
            awarder,
            name: pointName,
            symbol: pointSymbol,
            total: newScore.toString(),
            leaderboard,
            awardeePage,
        });

        // Deliver success notification
        const notifyModSuccess = ((settings[
            AppSetting.NotifyOnModAwardSuccess
        ] as string[]) ?? [
            NotifyOnModAwardSuccessReplyOptions.ReplyAsComment,
        ])[0];

        if (
            notifyModSuccess ===
            NotifyOnModAwardSuccessReplyOptions.ReplyAsComment
        ) {
            const newComment = await context.reddit.submitComment({
                id: event.comment.id,
                text: successMessage,
            });
            await newComment.distinguish();
        } else if (
            notifyModSuccess === NotifyOnModAwardSuccessReplyOptions.ReplyByPM
        ) {
            await context.reddit.sendPrivateMessage({
                to: awarder,
                subject: "Mod Award Successful",
                text: successMessage,
            });
        }

        // Flair update
        try {
            const recipientUser = await context.reddit.getUserByUsername(
                modAwardUsername
            );
            if (recipientUser) {
                const recScore = await context.redis.zScore(
                    redisKey,
                    modAwardUsername
                );
                const restricted = await getUserIsRestricted(
                    modAwardUsername,
                    context
                );

                const { currentScore: currentScoreForFlair } =
                    await getCurrentScore(recipientUser, context, settings);

                await updateAwardeeFlair(
                    context,
                    subredditName,
                    modAwardUsername,
                    recScore ?? currentScoreForFlair,
                    settings,
                    restricted
                );

                logger.info("🎨 Mod award flair updated", {
                    modAwardUsername,
                    score: recScore ?? currentScoreForFlair,
                });
            }
        } catch (err) {
            logger.error("❌ Flair update failed (mod award)", { err });
        }

        // Auto-superuser notification (MOD AWARD)
        await maybeNotifyAutoSuperuser(
            context,
            settings,
            modAwardUsername,
            parentComment.permalink,
            parentComment.id,
            newScore,
            modCommand
        );

        logger.info(
            `🏅 MOD award: ${awarder} → ${modAwardUsername} +1 ${pointName}`
        );

        // User wiki handling for MOD awarder + awardee
        try {
            const safeWiki = new SafeWikiClient(context.reddit);
            const awarderPage = await safeWiki.getWikiPage(
                subredditName,
                `user/${awarder.toLowerCase()}`
            );
            const recipientPage = await safeWiki.getWikiPage(
                subredditName,
                `user/${modAwardUsername}`
            );

            if (!awarderPage) {
                logger.info("📄 Creating missing awarder wiki", {
                    awarder,
                });
                await InitialUserWikiOptions(context, awarder);
            }

            if (!recipientPage) {
                logger.info("📄 Creating missing recipient wiki", {
                    recipient: modAwardUsername,
                });
                await InitialUserWikiOptions(context, modAwardUsername);
            }

            const givenData = {
                postTitle: event.post.title,
                postUrl: event.post.permalink,
                recipient: modAwardUsername,
                commentUrl: event.comment.permalink,
            };

            await updateUserWiki(context, awarder, modAwardUsername, givenData);
        } catch (err) {
            logger.error("❌ Failed to update user wiki (MOD award)", {
                awarder,
                modAwardUsername,
                err,
            });
        }

        // Mark awarded
        await context.redis.set(modSuccessKey, ``);

        return; // ✔ DONE — exit before normal flow starts
    }
    // ─────────────────────────────────────────────────────────────
    // NORMAL FLOW (user commands, no alt username, no modCommand)
    // ─────────────────────────────────────────────────────────────

    // Permission matrix
    const hasPermission =
        accessControl === "everyone" ||
        (accessControl === "moderators-only" && isMod) ||
        (accessControl === "moderators-and-superusers" &&
            (isMod || isSuperUser)) ||
        (accessControl === "moderators-superusers-and-op" &&
            (isMod || isSuperUser || isOP));

    if (!hasPermission) {
        let replyChoice: string | undefined;
        let msg = "";
        switch (accessControl) {
            case "moderators-only":
                replyChoice = notifyModOnly;
                msg = msgModOnly;
                break;
            case "moderators-and-superusers":
                replyChoice = notifyApprovedOnly;
                msg = msgApprovedOnly;
                break;
            case "moderators-superusers-and-op":
                replyChoice = notifyOPOnly;
                msg = msgOPOnly;
                break;
            default:
                // fallback generic
                replyChoice = notifyModOnly;
                msg = msgModOnly;
        }
        const out = formatMessage(msg, { name: pointName });

        if (
            replyChoice === NotifyOnModOnlyDisallowedReplyOptions.ReplyAsComment
        ) {
            const newComment = await context.reddit.submitComment({
                id: event.comment.id,
                text: out,
            });
            await newComment.distinguish();
        } else if (
            replyChoice === NotifyOnModOnlyDisallowedReplyOptions.ReplyByPM
        ) {
            await context.reddit.sendPrivateMessage({
                to: awarder,
                subject: `You can't award ${pointName}s here`,
                text: out,
            });
        }

        logger.warn("❌ Award attempt without permission", {
            awarder,
            accessControl,
        });
        await context.redis.set(userBlockedFromAwardingPointsKey, "1");
        return;
    }

    await context.redis.set(userBlockedFromAwardingPointsKey, "0");

    // Self-award prevention
    if (awarder === recipient) {
        const selfText = formatMessage(selfMsgTemplate, {
            awarder,
            name: pointName,
        });
        if (notifySelf === NotifyOnSelfAwardReplyOptions.ReplyAsComment) {
            const newComment = await context.reddit.submitComment({
                id: event.comment.id,
                text: selfText,
            });
            await newComment.distinguish();
        } else if (notifySelf === NotifyOnSelfAwardReplyOptions.ReplyByPM) {
            await context.reddit.sendPrivateMessage({
                to: awarder,
                subject: `You tried to award yourself a ${pointName}`,
                text: selfText,
            });
        }
        await context.redis.set(selfAwardKey, "1");
        logger.debug("❌ User tried to award themselves.");
        return;
    }

    // Disallowed flair check (NORMAL flow only)
    try {
        const postFlair =
            (event.post as any)?.linkFlairText ??
            (event.post as any)?.flairText ??
            "";
        if (postFlair && disallowedFlairList.length > 0) {
            const blocked = disallowedFlairList.some(
                (f) => f.toLowerCase() === String(postFlair).toLowerCase()
            );
            if (blocked) {
                const text = formatMessage(msgDisallowedFlair, {});
                if (
                    notifyDisallowedFlair ===
                    NotifyOnDisallowedFlairReplyOptions.ReplyAsComment
                ) {
                    const newComment = await context.reddit.submitComment({
                        id: event.comment.id,
                        text,
                    });
                    await newComment.distinguish();
                } else if (
                    notifyDisallowedFlair ===
                    NotifyOnDisallowedFlairReplyOptions.ReplyByPM
                ) {
                    await context.reddit.sendPrivateMessage({
                        to: awarder,
                        subject: "Points cannot be awarded on this post",
                        text,
                    });
                }

                await context.redis.set(disallowedFlairKey, "1");
                logger.warn("🚫 Award blocked by disallowed flair", {
                    postFlair,
                });
                return;
            }
        }
    } catch (err) {
        logger.error("⚠️ Flair check failure (continuing)", { err });
    }

    // Duplicate award per parent comment (NORMAL flow)
    const authorUser = await context.reddit.getUserByUsername(awarder);
    const newScore = await context.redis.zIncrBy(redisKey, recipient, 1);
    await context.redis.set(normalDupKey, "1");

    await setCleanupForUsers([recipient], context);
    await context.scheduler.runJob({
        name: "updateLeaderboard",
        runAt: new Date(),
        data: {
            reason: `Awarded a point to ${recipient}. New score: ${newScore}`,
        },
    });

    const isPostAuthor = event.post.authorId === event.author.id;

    // Restriction counters (normal)
    if (isPostAuthor) {
        const restrictionLifted = await updateAuthorRedis(
            context,
            awarder,
            event.comment.id
        );

        if (restrictionLifted) {
            await maybeNotifyRestrictionLifted(context, event, awarder);
        }
    }

    // Success notify (normal)
    {
        const leaderboard = `https://old.reddit.com/r/${
            event.subreddit.name
        }/wiki/${settings[AppSetting.LeaderboardName] ?? "leaderboard"}`;
        const awardeePage = `https://old.reddit.com/r/${event.subreddit.name}/wiki/user/${recipient}`;
        const successMessage = formatMessage(
            (settings[AppSetting.SuccessMessage] as string) ??
                TemplateDefaults.NotifyOnSuccessTemplate,
            {
                awardee: recipient,
                awarder,
                total: newScore.toString(),
                name: pointName,
                symbol: pointSymbol,
                leaderboard,
                awardeePage,
            }
        );

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
        } else if (
            notifySuccess === NotifyOnSuccessReplyOptions.ReplyAsComment
        ) {
            const newComment = await context.reddit.submitComment({
                id: event.comment.id,
                text: successMessage,
            });
            await newComment.distinguish();
        }
    }

    logger.info(`🏅 NORMAL award: ${awarder} → ${recipient} +1 ${pointName}`);
    const safeWiki = new SafeWikiClient(context.reddit);

    // ─────────────────────────────────────────────────────────────
    // User Wiki Handling (awarder + recipient)
    // ─────────────────────────────────────────────────────────────
    try {
        const awarderPage = await safeWiki.getWikiPage(
            subredditName,
            `user/${awarder.toLowerCase()}`
        );
        const recipientPage = await safeWiki.getWikiPage(
            subredditName,
            `user/${recipient.toLowerCase()}`
        );

        if (!awarderPage) {
            logger.info("📄 Creating missing awarder wiki", { awarder });
            await InitialUserWikiOptions(context, awarder);
        }

        if (!recipientPage) {
            logger.info("📄 Creating missing recipient wiki", { recipient });
            await InitialUserWikiOptions(context, recipient);
        }

        const awarderPageNow = await safeWiki.getWikiPage(
            subredditName,
            `user/${awarder.toLowerCase()}`
        );
        const recipientPageNow = await safeWiki.getWikiPage(
            subredditName,
            `user/${recipient.toLowerCase()}`
        );

        if (awarderPageNow && recipientPageNow) {
            const givenData = {
                postTitle: event.post.title,
                postUrl: event.post.permalink,
                recipient,
                commentUrl: event.comment.permalink,
            };

            await updateUserWiki(context, awarder, recipient, givenData);
        }
    } catch (err) {
        logger.error("❌ Failed to update user wiki (NORMAL)", {
            awarder,
            recipient,
            err,
        });
    }

    // Flair + Leaderboard updates (normal)
    try {
        const recipientUser = await context.reddit.getUserByUsername(recipient);
        if (!recipientUser) return;

        const { currentScore: recipientScore } = await getCurrentScore(
            recipientUser,
            context,
            settings
        );
        const score = await context.redis.zScore(redisKey, recipient);

        const recipientIsRestricted = await getUserIsRestricted(
            recipient,
            context
        );
        await updateAwardeeFlair(
            context,
            subredditName,
            recipient,
            (score ?? recipientScore) || 0,
            settings,
            recipientIsRestricted
        );
        logger.info(
            `🎨 Updated flair for ${recipient} (${
                score ?? recipientScore ?? 0
            }${pointSymbol})`
        );

        // OP counter update (only if OP)
        if (isPostAuthor) {
            await updateAuthorRedis(
                context,
                event.author.name,
                event.comment.id
            );
            logger.debug(
                `🧩 OP ${event.author.name} restriction counter incremented`
            );
        }
    } catch (err) {
        logger.error("❌ Flair/author update error (normal flow)", { err });
    }

    // Auto-superuser notification (NORMAL)
    await maybeNotifyAutoSuperuser(
        context,
        settings,
        recipient,
        parentComment.permalink,
        parentComment.id,
        newScore,
        modCommand
    );
}

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
    const lastValidPostKey = `lastValidPost:${username}`;

    try {
        const deleted = await Promise.all([
            context.redis.del(restrictedKey),
            context.redis.del(lastValidPostKey),
        ]);

        logger.info("🧹 Manual restriction removal complete", {
            username,
            removedKeys: [restrictedKey, lastValidPostKey],
            results: deleted,
        });
    } catch (err) {
        logger.error("❌ Error during manual restriction removal", {
            username,
            err,
        });
    }
}

export async function updateAuthorRedisManualRequirementRemoval(
    context: TriggerContext,
    username: string
) {
    const requiredKey = `awardsRequired:${username}`;
    const lastValidPostKey = `lastValidPost:${username}`;

    try {
        const deleted = await Promise.all([
            context.redis.del(requiredKey),
            context.redis.del(lastValidPostKey),
        ]);

        logger.info("🧹 Manual requirement removal complete", {
            username,
            removedKeys: [requiredKey, lastValidPostKey],
            results: deleted,
        });
    } catch (err) {
        logger.error("❌ Error during manual requirement removal", {
            username,
            err,
        });
    }
}

export async function updateAuthorRedisOnPostSubmit(
    context: TriggerContext,
    username: string
): Promise<void> {
    const restrictedKey = `restrictedUser:${username}`;
    const requiredKey = `awardsRequired:${username}`;

    logger.debug("🔔 updateAuthorRedisOnPostSubmit called", {
        username,
        restrictedKey,
        requiredKey,
    });

    const [restrictedExists, requiredExists] = await Promise.all([
        context.redis.exists(restrictedKey),
        context.redis.exists(requiredKey),
    ]);

    // If they already have counters, don't reset them
    if (restrictedExists || requiredExists) {
        logger.debug(
            "ℹ️ User already has restriction counters; leaving as-is on post submit",
            { username, restrictedExists, requiredExists }
        );
        return;
    }

    const settings = await context.settings.getAll();
    const awardsRequired =
        (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) ?? 0;

    if (awardsRequired <= 0) {
        logger.debug(
            "ℹ️ awardsRequiredToCreateNewPosts <= 0; not initializing restriction counters",
            { username, awardsRequired }
        );
        return;
    }

    // Initialize with 0 progress and full remaining requirement
    await Promise.all([
        context.redis.set(restrictedKey, "0"),
        context.redis.set(requiredKey, awardsRequired.toString()),
    ]);

    logger.info("🚧 Initial restriction counters set on post submit", {
        username,
        restrictedKey,
        requiredKey,
        restrictedUser: 0,
        remaining: awardsRequired,
    });
}

//todo: figure out why this increments weird and generally doesn't behave as expected
export async function updateAuthorRedis(
    context: TriggerContext,
    username: string,
    commentId: string
): Promise<boolean> {
    // ──────────────── Redis Keys ────────────────
    const restrictionKey = `restrictedUser:${username}`;
    const requiredKey = `awardsRequired:${username}`;
    const lastValidPostKey = `lastValidPost:${username}`;
    const lastValidTitleKey = `lastValidPostTitle:${username}`;
    const awaitingPostKey = `restrictionLiftedAwaitingPost:${username}`;

    logger.debug("🔔 updateAuthorRedis called (award path)", {
        username,
        restrictionKey,
        requiredKey,
        lastValidPostKey,
    });

    // ─────────────────────────────────────────────
    // 🚫 Case: Restriction was lifted already, waiting on user to make a new post
    // Prevents double-increment or re-restriction before user posts.
    // ─────────────────────────────────────────────
    const awaitingPostFlag = await context.redis.get(awaitingPostKey);
    if (awaitingPostFlag === "1") {
        logger.debug("⏭️ User restriction lifted already — awaiting new post", {
            username,
        });
        return true; // Already fulfilled requirement; do not increment
    }

    // ─────────────────────────────────────────────
    // 🔢 Load current restricted count
    // ─────────────────────────────────────────────
    const raw = await context.redis.get(restrictionKey);
    logger.debug("📥 Raw restricted value from Redis", {
        username,
        restrictionKey,
        raw,
        rawType: typeof raw,
    });

    let currentCount = 0;

    if (raw !== undefined && raw !== null && raw !== "") {
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed >= 0) {
            currentCount = parsed;
            logger.debug("🔢 Parsed existing restricted count", {
                username,
                parsedCount: currentCount,
            });
        } else {
            logger.warn("⚠️ Invalid restricted value in Redis — resetting", {
                username,
                raw,
            });
        }
    }

    const newCount = currentCount + 1;

    logger.debug("➕ Incrementing restricted count", {
        username,
        previousCount: currentCount,
        newCount,
    });

    await context.redis.set(restrictionKey, newCount.toString());

    // ─────────────────────────────────────────────
    // ⚙️ Load awardsRequired from settings
    // ─────────────────────────────────────────────
    const settings = await context.settings.getAll();
    const awardsRequired =
        (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) ?? 0;

    logger.debug("⚙️ Loaded awardsRequired setting", {
        username,
        awardsRequired,
    });

    // ─────────────────────────────────────────────
    // 🚫 Restriction system disabled
    // ─────────────────────────────────────────────
    if (awardsRequired <= 0) {
        logger.warn(
            "⚠️ awardsRequiredToCreateNewPosts <= 0, clearing restriction keys",
            { username, awardsRequired }
        );

        await Promise.all([
            context.redis.del(restrictionKey),
            context.redis.del(requiredKey),
            context.redis.del(lastValidPostKey),
            context.redis.del(lastValidTitleKey),
        ]);

        return false;
    }

    // ─────────────────────────────────────────────
    // 📊 Compute remaining required awards
    // ─────────────────────────────────────────────
    const remaining = Math.max(0, awardsRequired - newCount);

    logger.debug("📊 Computed remaining awards required", {
        username,
        awardsRequired,
        newCount,
        remaining,
    });

    // ─────────────────────────────────────────────
    // Still restricted — store remaining and exit
    // ─────────────────────────────────────────────
    if (remaining > 0) {
        await context.redis.set(requiredKey, remaining.toString());

        logger.info("📊 Updated Redis (restriction still active)", {
            username,
            restrictedUser: newCount,
            remaining,
            restrictionKey,
            requiredKey,
        });

        return false;
    }

    // ─────────────────────────────────────────────
    // 🎉 Requirement completed — restriction lifted!
    // ─────────────────────────────────────────────
    await Promise.all([
        context.redis.del(restrictionKey),
        context.redis.del(requiredKey),
        context.redis.del(lastValidPostKey),
        context.redis.del(lastValidTitleKey),
    ]);

    // NEW: Add awaiting-new-post flag
    await context.redis.set(awaitingPostKey, "1");

    logger.info("🎉 Restriction lifted — awaiting new post", {
        username,
        finalCount: newCount,
        awardsRequired,
        removedKeys: [
            restrictionKey,
            requiredKey,
            lastValidPostKey,
            lastValidTitleKey,
        ],
    });

    // ─────────────────────────────────────────────
    // 💬 Notify user (comment or PM)
    // ─────────────────────────────────────────────
    const liftedMsg =
        (settings[AppSetting.RestrictionRemovedMessage] as string) ??
        TemplateDefaults.RestrictionRemovedMessage;

    const notify = ((settings[
        AppSetting.NotifyOnRestrictionLifted
    ] as string[]) ?? ["none"])[0];

    let msg = "";
    let replyChoice: string | undefined;

    const notifyLifted = ((settings[
        AppSetting.NotifyOnRestrictionLifted
    ] as string[]) ?? [NotifyOnRestrictionLiftedReplyOptions.NoReply])[0];

    switch (notify) {
        case NotifyOnRestrictionLiftedReplyOptions.ReplyAsComment:
            replyChoice = notifyLifted;
            msg = liftedMsg;
            break;
        case NotifyOnRestrictionLiftedReplyOptions.ReplyByPM:
            replyChoice = notifyLifted;
            msg = liftedMsg;
            break;
    }

    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const helpPage = (settings[AppSetting.PointSystemHelpPage] as string) ?? "";
    const discord = (settings[AppSetting.DiscordServerLink] as string) ?? "";
    const requirement =
        (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) ?? 0;

    const output = formatMessage(msg, {
        awarder: username,
        subreddit: await getSubredditName(context),
        requirement: requirement.toString(),
        name: pointName,
        helpPage,
        discord,
    });

    if (replyChoice === NotifyOnRestrictionLiftedReplyOptions.ReplyAsComment) {
        const newComment = await context.reddit.submitComment({
            id: commentId,
            text: output,
        });
        newComment.distinguish();
    } else if (
        replyChoice === NotifyOnRestrictionLiftedReplyOptions.ReplyByPM
    ) {
        await context.reddit.sendPrivateMessage({
            subject: "Post Restriction Removal Notification",
            text: output,
            to: username,
        });
    }

    return true; // requirement met
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

    // Make sure newScore is a safe primitive
    const scoreValue =
        newScore !== undefined && newScore !== null ? Number(newScore) : 0;

    let flairText = "";
    switch (flairSetting) {
        case ExistingFlairOverwriteHandling.OverwriteNumericSymbol:
            flairText = `${scoreValue}${pointSymbol}`;
            break;
        case ExistingFlairOverwriteHandling.OverwriteNumeric:
        default:
            flairText = `${scoreValue}`;
            break;
    }

    // CSS class + template logic
    let cssClass = settings[AppSetting.CSSClass] as string | undefined;
    let flairTemplate = settings[AppSetting.FlairTemplate] as
        | string
        | undefined;

    // If using a flair template, CSS class cannot be used
    if (flairTemplate) cssClass = undefined;

    try {
        await context.reddit.setUserFlair({
            subredditName,
            username: commentAuthor,
            cssClass,
            flairTemplateId: flairTemplate,
            text: flairText,
        });

        logger.info(
            `🧑‍🎨 Awardee flair updated: u/${commentAuthor} → (“${flairText}”)`
        );
    } catch (err) {
        logger.error("❌ Failed to update awardee flair", {
            user: commentAuthor,
            err,
        });
    }
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

    const entry = event.values.newScore as number | undefined;
    if (
        typeof entry !== "number" ||
        isNaN(entry) ||
        parseInt(entry.toString(), 10) < 0
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

    const redisKey = POINTS_STORE_KEY;

    const zMemberUser = await context.redis.zScore(redisKey, user.username);

    const newScore = await context.redis.zAdd(redisKey, {
        member: user.username,
        score: entry,
    });

    await updateAwardeeFlair(
        context,
        subreddit,
        comment.authorName,
        entry,
        settings,
        recipientIsRestricted
    );

    await context.scheduler.runJob({
        name: "updateLeaderboard",
        runAt: new Date(),
        data: {
            reason: `Updated score for ${comment.authorName}. New score: ${entry}`,
        },
    });

    context.ui.showToast(`Score for ${comment.authorName} is now ${entry}`);
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
        context.ui.showToast("❌ Unable to identify the post to update.");
        logger.error("❌ No postId in context for restriction removal.");
        return;
    }

    // 🔹 Confirm moderator input
    const confirmText = (
        event.values.restrictionRemovalConfirmation as string | undefined
    )?.trim();
    if (confirmText !== "CONFIRM") {
        context.ui.showToast(
            "⚠️ Action cancelled — you must type CONFIRM in all caps."
        );
        logger.warn("⚠️ Moderator failed confirmation input.", { confirmText });
        return;
    }

    // 🔹 Fetch the post
    const post = await context.reddit.getPostById(context.postId);
    if (!post) {
        context.ui.showToast("❌ Could not fetch post data.");
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
        context.ui.showToast(
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
    const lastValidTitleKey = `lastValidPostTitle:${user.username}`;
    const awaitingPostKey = `awaitingPost:${user.username}`;

    // ──────────────── Check Restriction State ────────────────
    const authorName = user.username;
    const restrictedFlagExists = await restrictedKeyExists(context, authorName);
    const requiredFlagExists = await requiredKeyExists(context, authorName);

    const isRestricted = restrictedFlagExists || requiredFlagExists;
    if (!isRestricted) {
        context.ui.showToast(
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
    await Promise.all([
        context.redis.del(lastValidPostKey),
        context.redis.del(lastValidTitleKey),
        context.redis.del(requiredKey),
        context.redis.del(restrictionKey),
        context.redis.del(awaitingPostKey),
    ]);

    logger.info("✅ Restriction fully removed from Redis", {
        username: user.username,
        removedKeys: [
            restrictionKey,
            requiredKey,
            lastValidPostKey,
            lastValidTitleKey,
            awaitingPostKey,
        ],
    });

    // ──────────────── Notify Moderator ────────────────
    context.ui.showToast(`✅ Post restriction removed for u/${user.username}.`);
    logger.info(
        `✅ Manual post restriction removal successful for u/${user.username}.`
    );
}
