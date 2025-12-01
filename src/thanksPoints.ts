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
    appSettings,
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

    // 🔁 Refresh leaderboard
    const { currentScore } = await getCurrentScore(author, context, settings);
    logger.debug("📊 Current score fetched for leaderboard refresh", {
        username: authorName,
        currentScore,
    });

    await context.scheduler.runJob({
        name: "updateLeaderboard",
        runAt: new Date(),
        data: {
            reason: `Post submit by ${authorName}. Current score: ${currentScore}`,
        },
    });
    logger.info("✅ Scheduled leaderboard update", { username: authorName });

    const awardsRequiredEntry =
        (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) ?? 0;
    if (awardsRequiredEntry === 0) {
        logger.info("❌ Post restriction is not enabled", {
            username: authorName,
        });
        return;
    }

    // ──────────────── Redis Keys ────────────────
    const restrictedFlagKey = `restrictedUser:${author.username}`;
    const requiredKey = `awardsRequired:${author.username}`;
    const lastValidPostKey = `lastValidPost:${author.username}`;
    const lastValidPostTitleKey = `lastValidPostTitle:${author.username}`;

    logger.debug("🔑 Redis keys for restriction tracking", {
        restrictedFlagKey,
        requiredKey,
        lastValidPostKey,
        lastValidPostTitleKey,
    });

    // ──────────────── Check mod exemption ────────────────
    const modsExempt =
        (settings[AppSetting.ModeratorsExempt] as boolean) ?? true;
    const isMod = await isModerator(context, subredditName, authorName);
    if (isMod && modsExempt) {
        logger.info(
            `✅ ${author.username} is a moderator and exempt from restrictions`
        );
        return;
    }

    // ──────────────── Determine if user is restricted ────────────────
    const restrictedFlagExists = await restrictedKeyExists(context, authorName);
    const requiredFlagExists = await requiredKeyExists(context, authorName);
    const isRestricted = restrictedFlagExists || requiredFlagExists;

    logger.debug("⚙️ Restriction check", {
        username: authorName,
        restrictedFlagExists,
        requiredFlagExists,
        awardsRequired: awardsRequiredEntry,
        isRestricted,
    });

    // ✅ First post allowed — mark user as restricted after posting
    if (!isRestricted) {
        const restrictionTemplate =
            (settings[AppSetting.MessageToRestrictedUsers] as string) ??
            TemplateDefaults.MessageToRestrictedUsers;

        const pointTriggerWords =
            (settings[AppSetting.PointTriggerWords] as string) ??
            "!award\n.award";

        const triggerWordsArray = pointTriggerWords
            .split(/\r?\n/)
            .map((word) => word.trim())
            .filter(Boolean);

        const commandList = triggerWordsArray.join(", ");
        const pointName = (settings[AppSetting.PointName] as string) ?? "point";

        const helpPage = settings[AppSetting.PointSystemHelpPage] as
            | string
            | undefined;
        const discordLink = settings[AppSetting.DiscordServerLink] as
            | string
            | undefined;

        // 🧩 Build restriction message
        let restrictionText = restrictionTemplate
            .replace(/{{name}}/g, pointName)
            .replace(/{{commands}}/g, commandList)
            .replace(
                /{{markdown_guide}}/g,
                "https://www.reddit.com/wiki/markdown"
            )
            .replace(/{{subreddit}}/g, subredditName);

        if (helpPage) {
            restrictionText = restrictionText.replace(
                /{{helpPage}}/g,
                `https://www.reddit.com/r/${subredditName}/wiki/${helpPage}`
            );
        }
        if (discordLink) {
            restrictionText = restrictionText.replace(
                /{{discord}}/g,
                discordLink
            );
        }

        logger.debug("✉️ Built first-post restriction message", {
            username: authorName,
            messagePreview: restrictionText.slice(0, 200),
        });

        // 🗨️ Post comment
        const postRestrictionComment = await context.reddit.submitComment({
            id: event.post.id,
            text: restrictionText,
        });

        await postRestrictionComment.distinguish(true);
        logger.info("📌 Restriction comment posted and distinguished", {
            username: authorName,
            commentId: postRestrictionComment.id,
        });

        // 🧠 Store last valid post
        await context.redis.set(lastValidPostKey, event.post.permalink);
        await context.redis.set(lastValidPostTitleKey, event.post.title);
        logger.debug("💾 Stored last valid post in Redis", {
            username: authorName,
            lastValidPostKey,
            lastValidPostTitleKey,
        });

        // 🧮 Initialize restriction requirement
        await updateAuthorRedisOnPostSubmit(context, authorName);
        logger.info("✅ User restriction initialized post first submission", {
            username: authorName,
        });

        return;
    }

    // ──────────────── Subsequent posts while restricted ────────────────
    logger.debug("⚠️ User attempted subsequent post while restricted", {
        username: authorName,
    });

    const titleKey = await context.redis.get(lastValidPostTitleKey);
    const lastValidPost = await context.redis.get(lastValidPostKey);
    const PointTriggerWords =
        (settings[AppSetting.PointTriggerWords] as string) ?? "!award\n.award";

    const triggerWordsArray = PointTriggerWords.split(/\r?\n/)
        .map((word) => word.trim())
        .filter(Boolean);

    const commandList = triggerWordsArray.join(", ");
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const helpPageNotEmpty = settings[AppSetting.PointSystemHelpPage] !== "";
    const helpPage = helpPageNotEmpty
        ? `https://www.reddit.com/r/${subredditName}/wiki/${
              settings[AppSetting.PointSystemHelpPage] as string
          }`
        : "";
    const discordLinkNotEmpty = settings[AppSetting.DiscordServerLink] !== "";
    const discordLink = discordLinkNotEmpty
        ? (settings[AppSetting.DiscordServerLink] as string)
        : "";

    const requirement =
        (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) ?? 0;

    const subsequentPostRestrictionTemplate =
        (settings[AppSetting.SubsequentPostRestrictionMessage] as string) ??
        TemplateDefaults.SubsequentPostRestrictionMessage;

    let subsequentPostRestrictionMessage = subsequentPostRestrictionTemplate
        .replace(/{{name}}/g, pointName)
        .replace(/{{commands}}/g, commandList)
        .replace(/{{markdown_guide}}/g, "https://www.reddit.com/wiki/markdown")
        .replace(/{{requirement}}/g, requirement.toString())
        .replace(/{{subreddit}}/g, subredditName);

    if (titleKey) {
        subsequentPostRestrictionMessage =
            subsequentPostRestrictionMessage.replace(/{{title}}/g, titleKey);
    }
    if (helpPageNotEmpty) {
        subsequentPostRestrictionMessage =
            subsequentPostRestrictionMessage.replace(
                /{{helpPage}}/g,
                `https://www.reddit.com/r/${subredditName}/wiki/${helpPage}`
            );
    }
    if (discordLinkNotEmpty) {
        subsequentPostRestrictionMessage =
            subsequentPostRestrictionMessage.replace(
                /{{discord}}/g,
                discordLink
            );
    }
    if (lastValidPost) {
        subsequentPostRestrictionMessage =
            subsequentPostRestrictionMessage.replace(
                /{{permalink}}/g,
                lastValidPost
            );
    }
    // 🗨️ Post comment and remove post
    const postRestrictionComment = await context.reddit.submitComment({
        id: event.post.id,
        text: subsequentPostRestrictionMessage,
    });

    await postRestrictionComment.distinguish(true);
    await context.reddit.remove(event.post.id, false);

    logger.info("🚫 Removed post from restricted user and posted warning", {
        username: authorName,
        postId: event.post.id,
        commentId: postRestrictionComment.id,
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

async function replyToUser(
    context: TriggerContext,
    replyMode: AutoSuperuserReplyOptions,
    toUserName: string,
    messageBody: string,
    commentId: string
) {
    if (replyMode === AutoSuperuserReplyOptions.NoReply) {
        return;
    } else if (replyMode === AutoSuperuserReplyOptions.ReplyByPM) {
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
                `${commentId}: Error sending PM notification to ${toUserName}. User may only allow PMs from whitelisted users.`
            );
        }
    } else {
        // Reply by comment
        const newComment = await context.reddit.submitComment({
            id: commentId,
            text: messageBody,
        });
        await Promise.all([newComment.distinguish(), newComment.lock()]);
        console.log(
            `${commentId}: Public comment reply left in reply to ${toUserName}`
        );
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
    await replyToUser(
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

export async function maybeNotifyRestrictionLifted(
    context: TriggerContext,
    event: CommentSubmit | CommentUpdate,
    username: string
): Promise<void> {
    logger.debug("🔔 maybeNotifyRestrictionLifted called", { username });

    try {
        const [restrictedExists, remainingRaw] = await Promise.all([
            context.redis.exists(`restrictedUser:${username}`),
            context.redis.get(`awardsRequired:${username}`),
        ]);

        logger.debug("📊 Restriction state snapshot", {
            username,
            restrictedExists,
            remainingRaw,
        });

        let remaining: number | null = null;
        if (
            remainingRaw !== undefined &&
            remainingRaw !== null &&
            remainingRaw !== ""
        ) {
            const parsedRemaining = Number(remainingRaw);
            if (Number.isFinite(parsedRemaining) && parsedRemaining >= 0) {
                remaining = parsedRemaining;
                logger.debug("🔢 Parsed remaining awardsRequired", {
                    username,
                    remaining,
                });
            } else {
                logger.warn(
                    "⚠️ Invalid remaining awardsRequired value; treating as null",
                    {
                        username,
                        remainingRaw,
                    }
                );
            }
        }

        // If still restricted, do nothing
        if (restrictedExists || (remaining !== null && remaining > 0)) {
            logger.debug("ℹ️ User still restricted; not notifying", {
                username,
                restrictedExists,
                remaining,
            });
            return;
        }

        // 🎉 Restriction fully lifted
        const settings = await context.settings.getAll();

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

        if (notifyMode === NotifyOnRestrictionLiftedReplyOptions.NoReply) {
            logger.info("✅ Restriction lifted but no notification required", {
                username,
            });
        }

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

        // Send comment or PM
        if (
            notifyMode === NotifyOnRestrictionLiftedReplyOptions.ReplyAsComment
        ) {
            if (!event.comment) {
                logger.warn("⚠️ No comment to reply to; falling back to PM", {
                    username,
                });
                await context.reddit.sendPrivateMessage({
                    to: username,
                    subject: `Your posting restriction has been lifted in r/${subredditName}`,
                    text: messageBody,
                });
                logger.info("📬 Sent PM as fallback", { username });
            } else {
                const reply = await context.reddit.submitComment({
                    id: event.comment.id,
                    text: messageBody,
                });
                await reply.distinguish();
                logger.info("📬 Posted restriction-lifted comment", {
                    username,
                    commentId: event.comment.id,
                });
            }
        } else if (
            notifyMode === NotifyOnRestrictionLiftedReplyOptions.ReplyByPM
        ) {
            await context.reddit.sendPrivateMessage({
                to: username,
                subject: `Your posting restriction has been lifted in r/${subredditName}`,
                text: messageBody,
            });
            logger.info("📬 Sent PM to user", { username });
        }

        // Delete Redis keys
        const keysToDelete = [
            `restrictedUser:${username}`,
            `awardsRequired:${username}`,
            `lastValidPost:${username}`,
            `lastValidPostTitle:${username}`,
        ];

        for (const key of keysToDelete) {
            try {
                await context.redis.del(key);
                logger.debug("🗑️ Redis key deleted", { username, key });
            } catch (err) {
                logger.error("Error trying to delete redis key", { key, err });
            }
        }

        logger.info("✅ Restriction lift complete and keys cleared", {
            username,
        });
    } catch (err) {
        logger.error(
            "❌ Error while checking / notifying restriction lift",
            { username, err },
            context
        );
    }
}

async function notifyUser(
    context: TriggerContext,
    replyModeValue: string, // <-- this will be one of the enum values, e.g., "noreply"
    recipient: string,
    message: string,
    commentId?: string
) {
    try {
        switch (replyModeValue) {
            case "noreply":
                logger.debug("ℹ️ Notification skipped (NoReply)", {
                    recipient,
                });
                break;

            case "replybypm":
                await context.reddit.sendPrivateMessage({
                    to: recipient,
                    subject: `Notification from ${context.appName}`,
                    text: message,
                });
                logger.info("📩 PM sent", { recipient });
                break;

            case "replyascomment":
                if (!commentId) {
                    logger.warn(
                        "❌ Cannot reply as comment, commentId missing",
                        { recipient }
                    );
                    break;
                }
                await context.reddit.submitComment({
                    id: commentId,
                    text: message,
                });
                logger.info("💬 Comment reply sent", { recipient, commentId });
                break;

            default:
                logger.warn("⚠️ Unknown notification mode", { replyModeValue });
                break;
        }
    } catch (err) {
        logger.error("❌ Notification failed", { recipient, err });
    }
}

export async function handleThanksEvent(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext
) {
    if (!event.comment) return;
    if (!event.post) return;
    if (!event.subreddit) return;
    const commentId = event.comment.id;
    const postId = event.post.id;
    const awarder  = event.comment.author;
    const awarderName = await context.reddit.getUserByUsername(event.comment.author);;
    const subredditName = event.subreddit.name;
    const settings = await context.settings.getAll();

    logger.debug("✅ Event triggered", {
        commentId,
        postId,
        awarder,
        subredditName,
    });

    if (!awarder || !subredditName || !commentId) {
        logger.error("❌ Missing critical event info", {
            awarder,
            subredditName,
            commentId,
        });
        return;
    }

    const content = event.comment.body.trim();

    // ───────────────────────────────
    // Determine if this is a normal award or ALT award
    const pointTriggerWords: string[] = Array.isArray(
        settings[AppSetting.PointTriggerWords]
    )
        ? settings[AppSetting.PointTriggerWords]
        : [];

    const modTriggerWords: string[] = Array.isArray(
        settings[AppSetting.ModAwardCommand]
    )
        ? settings[AppSetting.ModAwardCommand]
        : [];

    const userCommandRegex = new RegExp(
        `^(!|\\?)(${pointTriggerWords.join("|")})\\b`,
        "i"
    );
    const modCommandRegex = new RegExp(
        `^(!|\\?)(${modTriggerWords.join("|")})\\b`,
        "i"
    );
    const altCommandRegex = new RegExp(
        `^(!|\\?)(${[
            ...(settings[AppSetting.PointTriggerWords] as string),
            ...(settings[AppSetting.ModAwardCommand] as string),
        ].join("|")})\\s+u/([a-z0-9_-]{3,21})`,
        "i"
    );

    let triggerUsed: string | null = null;
    let mentionedUsername: string | null = null;
    let isAlt = false;
    let isModCommand = false;

    const altMatch = content.match(altCommandRegex);
    if (altMatch) {
        isAlt = true;
        triggerUsed = altMatch[2];
        mentionedUsername = altMatch[3];
        const modCommands: string[] = Array.isArray(
            settings[AppSetting.ModAwardCommand]
        )
            ? settings[AppSetting.ModAwardCommand]
            : [];
        isModCommand = modCommands.includes(triggerUsed);
    } else {
        const userMatch = content.match(userCommandRegex);
        const modMatch = content.match(modCommandRegex);
        if (modMatch) {
            triggerUsed = modMatch[2];
            isModCommand = true;
        } else if (userMatch) {
            triggerUsed = userMatch[2];
            isModCommand = false;
        } else {
            logger.debug("⏩ No trigger matched, ignoring comment");
            return;
        }
    }

    const redisKey = POINTS_STORE_KEY;
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const pointSymbol = (settings[AppSetting.PointSymbol] as string) ?? "";

    // ───────────────────────────────
    // ALT command logic
    if (isAlt && mentionedUsername) {
        logger.debug("🔎 ALT flow detected", {
            triggerUsed,
            mentionedUsername,
        });

        // Username validation
        if (!/^[a-z0-9_-]{3,21}$/i.test(mentionedUsername)) {
            const msg = formatMessage(
                (settings[AppSetting.UsernameLengthMessage] as string) ??
                    TemplateDefaults.UsernameLengthMessage,
                { awardee: mentionedUsername, awarder }
            );
            const newComment = await context.reddit.submitComment({
                id: commentId,
                text: msg,
            });
            await newComment.distinguish();
            logger.warn("❌ ALT username failed validation", {
                awarder,
                mentionedUsername,
            });
            return;
        }

        // ALT authorization
        const altCommandUsers: string[] = Array.isArray(
            settings[AppSetting.AlternatePointCommandUsers]
        )
            ? settings[AppSetting.AlternatePointCommandUsers].map((u) =>
                  u.toLowerCase()
              )
            : [];

        if (!altCommandUsers.includes(awarder.toLowerCase())) {
            const failMessage = formatMessage(
                (settings[AppSetting.AlternateCommandFailMessage] as string) ??
                    TemplateDefaults.AlternateCommandFailMessage,
                {
                    altCommand: triggerUsed,
                    subreddit: subredditName,
                }
            );

            if (
                settings[AppSetting.NotifyOnAlternateCommandFail] ===
                NotifyOnAlternateCommandFailReplyOptions.ReplyAsComment
            ) {
                const failComment = await context.reddit.submitComment({
                    id: commentId,
                    text: failMessage,
                });
                await failComment.distinguish();
            } else if (
                settings[AppSetting.NotifyOnAlternateCommandFail] ===
                NotifyOnAlternateCommandFailReplyOptions.ReplyByPM
            ) {
                await context.reddit.sendPrivateMessage({
                    to: awarder,
                    subject: "Alternate Command Not Allowed",
                    text: failMessage,
                });
            }

            logger.warn("🚫 Unauthorized ALT award attempt", {
                awarder,
                triggerUsed,
                mentionedUsername,
            });
            return;
        }

        // Duplicate prevention
        const altDupKey = `customAward-${postId}-${mentionedUsername}`;
        if (await context.redis.exists(altDupKey)) {
            const dupMsg = formatMessage(
                (settings[
                    AppSetting.PointAlreadyAwardedToUserMessage
                ] as string) ??
                    TemplateDefaults.PointAlreadyAwardedToUserMessage,
                { name: pointName, awardee: mentionedUsername }
            );
            const notify = ((settings[
                AppSetting.NotifyOnPointAlreadyAwardedToUser
            ] as string[]) ?? ["none"])[0];

            if (
                notify ===
                NotifyOnPointAlreadyAwardedToUserReplyOptions.ReplyByPM
            ) {
                await context.reddit.sendPrivateMessage({
                    to: awarder,
                    subject: `Already awarded`,
                    text: dupMsg,
                });
            } else if (
                notify ===
                NotifyOnPointAlreadyAwardedToUserReplyOptions.ReplyAsComment
            ) {
                const newComment = await context.reddit.submitComment({
                    id: commentId,
                    text: dupMsg,
                });
                await newComment.distinguish();
            }

            logger.info("❌ Duplicate ALT award attempt", {
                awarder,
                mentionedUsername,
            });
            return;
        }
        await context.redis.set(altDupKey, "1");

        // Award points
        const newScore = await context.redis.zIncrBy(
            redisKey,
            mentionedUsername,
            1
        );

        // Update leaderboard
        await context.scheduler.runJob({
            name: "updateLeaderboard",
            runAt: new Date(),
            data: {
                reason: `ALT award: ${awarder} → ${mentionedUsername} (new: ${newScore})`,
            },
        });

        // Update flair
        const recipientIsRestricted = await getUserIsRestricted(
            mentionedUsername,
            context
        );
        await updateAwardeeFlair(
            context,
            subredditName,
            mentionedUsername,
            newScore,
            settings,
            recipientIsRestricted
        );

        // Notify ALT success
        const leaderboard = `https://old.reddit.com/r/${subredditName}/wiki/${
            settings[AppSetting.LeaderboardName] ?? "leaderboard"
        }`;
        const awardeePage = `https://old.reddit.com/r/${subredditName}/wiki/user/${mentionedUsername}`;
        const successMessage = formatMessage(
            (settings[AppSetting.AlternateCommandSuccessMessage] as string) ??
                TemplateDefaults.AlternateCommandSuccessMessage,
            {
                name: pointName,
                awardee: mentionedUsername,
                awarder,
                total: newScore.toString(),
                symbol: pointSymbol,
                leaderboard,
                awardeePage,
            }
        );

        if (
            settings[AppSetting.NotifyOnAlternateCommandSuccess] ===
            NotifyOnAlternateCommandSuccessReplyOptions.ReplyAsComment
        ) {
            const newComment = await context.reddit.submitComment({
                id: commentId,
                text: successMessage,
            });
            await newComment.distinguish();
        } else if (
            settings[AppSetting.NotifyOnAlternateCommandSuccess] ===
            NotifyOnAlternateCommandSuccessReplyOptions.ReplyByPM
        ) {
            await context.reddit.sendPrivateMessage({
                to: awarder,
                subject: "ALT Command Successful",
                text: successMessage,
            });
        }

        // Auto-superuser notification
        await maybeNotifyAutoSuperuser(
            context,
            settings,
            mentionedUsername,
            event.comment.permalink,
            commentId,
            newScore,
            isModCommand ? "mod" : "user" // convert boolean to string
        );

        logger.info(
            `🏅 ALT award: ${awarder} → ${mentionedUsername} +1 ${pointName}`
        );

        // Update user wiki
        try {
            await updateUserWiki(context, awarder, mentionedUsername, {
                postTitle: event.post.title,
                postUrl: event.post.permalink,
                commentUrl: event.comment.permalink,
            });
        } catch (err) {
            logger.error("❌ Failed to update user wiki (ALT)", {
                awarder,
                mentionedUsername,
                err,
            });
        }

        return; // ALT path fully handled
    }

    // ───────────────────────────────
    // Normal award logic (user/mod command without ALT)
    const awardeeUsername = await context.reddit.getUserByUsername(event.comment.);
    console.log("awardeeUsername:", awardeeUsername);
    if (awardeeUsername === awarder) {
        logger.warn("❌ Self-award detected or no awardee", { awarder });
        return;
    }

    const dupKey = `customAward-${postId}-${awardeeUsername}`;
    if (await context.redis.exists(dupKey)) {
        logger.info("❌ Duplicate award attempt", { awarder, awardeeUsername });
        return;
    }

    await context.redis.set(dupKey, "1");
    const newScore = await context.redis.zIncrBy(redisKey, awardeeUsername, 1);

    // Leaderboard update
    await context.scheduler.runJob({
        name: "updateLeaderboard",
        runAt: new Date(),
        data: {
            reason: `Award from ${awarder} → ${awardeeUsername} (new: ${newScore})`,
        },
    });

    const recipientIsRestricted = await getUserIsRestricted(
        awardeeUsername,
        context
    );
    await updateAwardeeFlair(
        context,
        subredditName,
        awardeeUsername,
        newScore,
        settings,
        recipientIsRestricted
    );

    // Notify success
    const leaderboard = `https://old.reddit.com/r/${subredditName}/wiki/${
        settings[AppSetting.LeaderboardName] ?? "leaderboard"
    }`;
    const awardeePage = `https://old.reddit.com/r/${subredditName}/wiki/user/${awardeeUsername}`;
    const successMessage = formatMessage(
        (settings[AppSetting.SuccessMessage] as string) ??
            TemplateDefaults.NotifyOnSuccessTemplate,
        {
            name: pointName,
            awardee: awardeeUsername,
            awarder,
            total: newScore.toString(),
            symbol: pointSymbol,
            leaderboard,
            awardeePage,
        }
    );

    const notifyOnSuccess = ((settings[
        AppSetting.NotifyOnSuccess
    ] as string[]) ?? [NotifyOnSuccessReplyOptions.NoReply])[0];
    if (notifyOnSuccess === NotifyOnSuccessReplyOptions.ReplyAsComment) {
        const newComment = await context.reddit.submitComment({
            id: commentId,
            text: successMessage,
        });
        await newComment.distinguish();
    } else if (notifyOnSuccess === NotifyOnSuccessReplyOptions.ReplyByPM) {
        await context.reddit.sendPrivateMessage({
            to: awarder,
            subject: "Award Successful",
            text: successMessage,
        });
    }

    // Auto-superuser notification
    await maybeNotifyAutoSuperuser(
        context,
        settings,
        awardeeUsername,
        event.comment.permalink,
        commentId,
        newScore,
        isModCommand ? "mod" : "user" // convert boolean to string
    );

    logger.info(`🏅 Award: ${awarder} → ${awardeeUsername} +1 ${pointName}`);
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
        context.redis.set(awaitingPostKey, "1"),
    ]);

    logger.info("✅ Restriction fully removed from Redis", {
        username: user.username,
        removedKeys: [
            restrictionKey,
            requiredKey,
            lastValidPostKey,
            lastValidTitleKey,
        ],
        updatedKeys: awaitingPostKey,
    });

    // ──────────────── Notify Moderator ────────────────
    context.ui.showToast(`✅ Post restriction removed for u/${user.username}.`);
    logger.info(
        `✅ Manual post restriction removal successful for u/${user.username}.`
    );
}
