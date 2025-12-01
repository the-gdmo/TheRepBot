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
    NotifyOnBotAwardReplyOptions,
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
    template: string | undefined | null,
    placeholders: Record<string, string>
): string {
    let result = String(template ?? ""); // <-- ensures result is a string

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

    // 🔒 Post restriction system
    const awardsRequiredEntry =
        (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) ?? 0;
    if (awardsRequiredEntry === 0) {
        logger.info("❌ Post restriction is not enabled", {
            username: authorName,
        });
        return;
    }

    // Redis keys
    const restrictedFlagKey = `restrictedUser:${author.username}`;
    const requiredKey = `awardsRequired:${author.username}`;
    const lastValidPostKey = `lastValidPost:${author.username}`;
    const lastValidPostTitleKey = `lastValidPostTitle:${author.username}`;
    const awaitingPostKey = `restrictionLiftedAwaitingPost:${author.username}`;
    const postRestrictionCommentKey = `postRestrictionNotificationSent:${author.username}`;

    logger.debug("🔑 Redis keys for restriction tracking", {
        restrictedFlagKey,
        requiredKey,
        lastValidPostKey,
        lastValidPostTitleKey,
        awaitingPostKey,
        postRestrictionCommentKey,
    });

    // Mod exemption
    const modsExempt =
        (settings[AppSetting.ModeratorsExempt] as boolean) ?? true;
    const isMod = await isModerator(context, subredditName, authorName);
    if (isMod && modsExempt) {
        logger.info(
            `✅ ${author.username} is a moderator and exempt from restrictions`
        );
        return;
    }

    // Determine restriction state
    const restrictedFlagExists = await context.redis.exists(restrictedFlagKey);
    const requiredFlagExists = await context.redis.exists(requiredKey);
    const awaitingPostFlag = await context.redis.get(awaitingPostKey);
    const postRestrictionSent = await context.redis.get(
        postRestrictionCommentKey
    );

    const isRestricted =
        restrictedFlagExists === 1 ||
        requiredFlagExists === 1 ||
        awaitingPostFlag === "1";

    logger.debug("⚙️ Restriction check", {
        username: authorName,
        restrictedFlagExists: restrictedFlagExists === 1,
        requiredFlagExists: requiredFlagExists === 1,
        awaitingPostFlag,
        postRestrictionSent,
        isRestricted,
    });

    // CASE 1 — Restriction was lifted recently & user is now allowed
    if (awaitingPostFlag === "1") {
        logger.info(
            `🔓 Restriction was lifted previously — marking awaitingPost=0 for ${author.username}`
        );
        await context.redis.set(awaitingPostKey, "0");
        await context.redis.del(restrictedFlagKey);
        await context.redis.del(requiredKey);
        await context.redis.set(postRestrictionCommentKey, "0"); // reset notification

        const restrictionTemplate =
            (settings[AppSetting.RestrictionRemovedMessage] as string) ??
            TemplateDefaults.RestrictionRemovedMessage;

        const PointTriggerWords =
            (settings[AppSetting.PointTriggerWords] as string) ??
            "!award\n.award";

        const triggerWordsArray = PointTriggerWords.split(/\r?\n/)
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

        // 🧩 Build the base text replacement
        let restrictionText = restrictionTemplate
            .replace(/{{name}}/g, pointName)
            .replace(/{{commands}}/g, commandList)
            .replace(
                /{{markdown_guide}}/g,
                "https://www.reddit.com/wiki/markdown"
            )
            .replace(/{{subreddit}}/g, subredditName);

        // Add help page and/or discord links as needed
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

        // 🗨️ Post comment
        const postRestrictionComment = await context.reddit.submitComment({
            id: event.post.id,
            text: restrictionText,
        });

        // 🏅 Distinguish and pin the comment
        await postRestrictionComment.distinguish(true);

        logger.info(
            "🧹 Cleared old restriction keys and reset postRestrictionNotificationSent",
            { username: authorName }
        );

        // Store new last valid post
        await context.redis.set(lastValidPostKey, event.post.permalink);
        await context.redis.set(lastValidPostTitleKey, event.post.title);
        logger.debug("💾 Stored last valid post after restriction lift", {
            username: authorName,
        });
        return;
    }

    // CASE 2 — User is NOT restricted (first post)
    if (!isRestricted) {
        const restrictionTemplate =
            (settings[AppSetting.MessageToRestrictedUsers] as string) ??
            TemplateDefaults.MessageToRestrictedUsers;
        const pointTriggerWords =
            (settings[AppSetting.PointTriggerWords] as string) ??
            "!award\n.award";

        const triggerWordsArray = pointTriggerWords
            .split(/\r?\n/)
            .map((w) => w.trim())
            .filter(Boolean);
        const commandList = triggerWordsArray.join(", ");
        const pointName = (settings[AppSetting.PointName] as string) ?? "point";

        const helpPage = settings[AppSetting.PointSystemHelpPage] as
            | string
            | undefined;
        const discordLink = settings[AppSetting.DiscordServerLink] as
            | string
            | undefined;

        let restrictionText = restrictionTemplate
            .replace(/{{name}}/g, pointName)
            .replace(/{{commands}}/g, commandList)
            .replace(
                /{{markdown_guide}}/g,
                "https://www.reddit.com/wiki/markdown"
            )
            .replace(/{{subreddit}}/g, subredditName);

        if (helpPage)
            restrictionText = restrictionText.replace(
                /{{helpPage}}/g,
                `https://www.reddit.com/r/${subredditName}/wiki/${helpPage}`
            );
        if (discordLink)
            restrictionText = restrictionText.replace(
                /{{discord}}/g,
                discordLink
            );

        const postRestrictionComment = await context.reddit.submitComment({
            id: event.post.id,
            text: restrictionText,
        });
        await postRestrictionComment.distinguish(true);
        logger.info("📌 Posted first-post restriction notice", {
            username: authorName,
            commentId: postRestrictionComment.id,
        });

        // Store first valid post
        await context.redis.set(lastValidPostKey, event.post.permalink);
        await context.redis.set(lastValidPostTitleKey, event.post.title);

        // Initialize restriction requirement
        await updateAuthorRedisOnPostSubmit(context, authorName);

        // Mark restriction warning as not sent yet (just in case)
        await context.redis.set(postRestrictionCommentKey, "0");

        return;
    }

    // CASE 3 — User IS restricted & is posting again
    logger.debug("⚠️ Restricted user attempted new post", {
        username: authorName,
    });

    const titleKey = await context.redis.get(lastValidPostTitleKey);
    const lastValidPost = await context.redis.get(lastValidPostKey);
    const pointTriggerWords =
        (settings[AppSetting.PointTriggerWords] as string) ?? "!award\n.award";
    const triggerWordsArray = pointTriggerWords
        .split(/\r?\n/)
        .map((w) => w.trim())
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
    const requirement = awardsRequiredEntry;

    const subsequentPostRestrictionTemplate =
        (settings[AppSetting.SubsequentPostRestrictionMessage] as string) ??
        TemplateDefaults.SubsequentPostRestrictionMessage;

    // Only send restriction comment if not already sent
    if (postRestrictionSent !== "1") {
        let msg = subsequentPostRestrictionTemplate
            .replace(/{{name}}/g, pointName)
            .replace(/{{commands}}/g, commandList)
            .replace(
                /{{markdown_guide}}/g,
                "https://www.reddit.com/wiki/markdown"
            )
            .replace(/{{requirement}}/g, requirement.toString())
            .replace(/{{subreddit}}/g, subredditName);

        if (titleKey) msg = msg.replace(/{{title}}/g, titleKey);
        if (helpPageNotEmpty) msg = msg.replace(/{{helpPage}}/g, helpPage);
        if (discordLinkNotEmpty) msg = msg.replace(/{{discord}}/g, discordLink);
        if (lastValidPost) msg = msg.replace(/{{permalink}}/g, lastValidPost);

        const postRestrictionComment = await context.reddit.submitComment({
            id: event.post.id,
            text: msg,
        });
        await postRestrictionComment.distinguish(true);
        await context.redis.set(postRestrictionCommentKey, "1"); // mark as sent
        logger.info("🚫 Removed restricted user's post and posted warning", {
            username: authorName,
            postId: event.post.id,
            commentId: postRestrictionComment.id,
        });
    }

    // Remove the post regardless
    await context.reddit.remove(event.post.id, false);
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

//todo: Figure out why this and updateAuthorRedis() award 
//todo: points to OP and system users and make it not happen
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
    if (!event.comment || !event.post || !event.author || !event.subreddit)
        return;

    const settings = await context.settings.getAll();
    const subredditName = event.subreddit.name;
    const awarder = event.author.name;
    const commentBody = (event.comment.body ?? "").toLowerCase();
    const commentId = event.comment.id;
    const postId = event.post.id;
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const pointSymbol = (settings[AppSetting.PointSymbol] as string) ?? "";
    const redisKey = POINTS_STORE_KEY;
    const accessControl = ((settings[AppSetting.AccessControl] as string[]) ?? [
        "everyone",
    ])[0];
    const isMod = await isModerator(context, subredditName, awarder);
    const isSuperUser = await getUserIsSuperuser(awarder, context);
    const isOP = event.author.id === event.post.authorId;

    const disallowedFlairList = (
        (settings[AppSetting.DisallowedFlairs] as string) ?? ""
    )
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

    const userCommands = (
        (settings[AppSetting.PointTriggerWords] as string) ?? "!award\n.award"
    )
        .split("\n")
        .map((c) => c.toLowerCase().trim())
        .filter(Boolean);
    const modCommand = (
        (settings[AppSetting.ModAwardCommand] as string) ?? "!modaward"
    )
        .toLowerCase()
        .trim();
    const allTriggers = Array.from(
        new Set([...userCommands, modCommand].filter((t) => t && t.length > 0))
    );
    const triggerUsed = allTriggers.find((t) => commentBody.includes(t));
    if (!triggerUsed) return;

    const lowerAwarder = awarder.toLowerCase();
    const botName = context.appName.toLowerCase();
    const isAutomod = lowerAwarder === "automoderator";

    // ---------------------------
    // Prevent awarding OP, Automod, or the Bot
    // ---------------------------
    if (isAutomod || isOP || lowerAwarder === botName) {
        const botAwardMessage = formatMessage(
            (settings[AppSetting.BotAwardMessage] as string) ??
                TemplateDefaults.BotAwardMessage,
            { name: pointName }
        );

        const notify =
            ((settings[AppSetting.NotifyOnBotAward] as string[]) ??
                [NotifyOnBotAwardReplyOptions.NoReply])[0];

        if (notify === NotifyOnBotAwardReplyOptions.ReplyAsComment) {
            const newComment = await context.reddit.submitComment({
                id: commentId,
                text: botAwardMessage,
            });
            await newComment.distinguish();
        } else if (notify === NotifyOnBotAwardReplyOptions.ReplyByPM) {
            await context.reddit.sendPrivateMessage({
                subject: "You attempted to award TheRepBot / OP / Automoderator",
                to: awarder,
                text: botAwardMessage,
            });
        }
        return;
    }

    // ---------------------------
    // Fetch parent comment
    // ---------------------------
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

    // ---------------------------
    // Handle restricted users
    // ---------------------------
    const postRestrictionCommentKey = `postRestrictionNotificationSent:${awarder}`;
    const userIsRestricted = await getUserIsRestricted(awarder, context);
    const restrictionAlreadySent = await context.redis.get(
        postRestrictionCommentKey
    );
    if (userIsRestricted && restrictionAlreadySent !== "1") {
        const helpPage = settings[AppSetting.PointSystemHelpPage] as
            | string
            | undefined;
        const discordLink = settings[AppSetting.DiscordServerLink] as
            | string
            | undefined;

        const restrictionTemplate = formatMessage(
            (settings[AppSetting.RestrictionRemovedMessage] as string) ??
                TemplateDefaults.RestrictionRemovedMessage,
            {
                awarder,
                name: pointName,
                subreddit: subredditName,
                helpPage: helpPage
                    ? `https://old.reddit.com/r/${subredditName}/wiki/${helpPage}`
                    : "",
                discord: discordLink ?? "",
            }
        );
        const newComment = await context.reddit.submitComment({
            id: commentId,
            text: restrictionTemplate,
        });
        await newComment.distinguish(true);
        await context.redis.set(postRestrictionCommentKey, "1");
        return;
    }

    // ---------------------------
    // Alternate command users
    // ---------------------------
    const altCommandUsers = (
        (settings[AppSetting.AlternatePointCommandUsers] as string) ?? ""
    )
        .split("\n")
        .map((u) => u.trim().toLowerCase())
        .filter(Boolean);
    const altUsersSet = new Set(altCommandUsers);
    const userIsAltUser = altUsersSet.has(lowerAwarder);

    const notifyOnAutoSuperuserString = ((settings[
        AppSetting.NotifyOnAutoSuperuser
    ] as string[] | undefined) ?? [
        AutoSuperuserReplyOptions.NoReply,
    ])[0] as AutoSuperuserReplyOptions;

    // ---------------------------
    // Alternate command handling
    // ---------------------------
    if (
        userIsAltUser &&
        (userCommands.includes(triggerUsed) || modCommand.includes(triggerUsed))
    ) {
        const idx = commentBody.indexOf(triggerUsed);
        if (idx >= 0) {
            const after = commentBody.slice(idx + triggerUsed.length);
            const spaceUMatch = after.match(/\s+u\/([a-z0-9_-]{3,21})/i);
            if (spaceUMatch) {
                const mentionedUsername = spaceUMatch[1].toLowerCase();
                const altDupKey = `customAward-${postId}-${mentionedUsername}`;
                if (await context.redis.exists(altDupKey)) {
                    const alreadyMsg = formatMessage(
                        (settings[
                            AppSetting.PointAlreadyAwardedToUserMessage
                        ] as string) ??
                            TemplateDefaults.PointAlreadyAwardedToUserMessage,
                        { awardee: mentionedUsername, name: pointName, awarder }
                    );
                    await replyToUser(
                        context,
                        notifyOnAutoSuperuserString,
                        awarder,
                        alreadyMsg,
                        commentId
                    );
                    return;
                }
                await context.redis.set(altDupKey, "1");
                const newScore = await context.redis.zIncrBy(
                    redisKey,
                    mentionedUsername,
                    1
                );

                await context.scheduler.runJob({
                    name: "updateLeaderboard",
                    runAt: new Date(),
                    data: {
                        reason: `Alternate award from ${awarder} to ${mentionedUsername} (new: ${newScore})`,
                    },
                });

                // Update OP restrictions if necessary
                try {
                    const authorUser = await context.reddit.getUserByUsername(
                        awarder
                    );
                    const isPostAuthor = event.post.authorId === authorUser?.id;
                    if (!authorUser) return;
                    if (isPostAuthor) {
                        const restrictionLifted = await updateAuthorRedis(
                            context,
                            awarder,
                            commentId
                        );

                        if (restrictionLifted)
                            await maybeNotifyRestrictionLifted(
                                context,
                                event,
                                awarder
                            );
                    }

                    logger.debug(
                        `🧩 OP ${authorUser.username} restriction counter incremented`
                    );
                } catch (err) {
                    logger.error(
                        `Error incrementing user restriction counter`,
                        { err, awarder }
                    );
                }

                const leaderboard = `https://old.reddit.com/r/${subredditName}/wiki/${
                    settings[AppSetting.LeaderboardName] ?? "leaderboard"
                }`;
                const awardeePage = `https://old.reddit.com/r/${subredditName}/wiki/user/${mentionedUsername}`;
                const successMessage = formatMessage(
                    (settings[
                        AppSetting.AlternateCommandSuccessMessage
                    ] as string) ??
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
                await replyToUser(
                    context,
                    notifyOnAutoSuperuserString,
                    awarder,
                    successMessage,
                    commentId
                );

                try {
                    const recipientUser =
                        await context.reddit.getUserByUsername(
                            mentionedUsername
                        );
                    if (recipientUser) {
                        const { currentScore: recipientScore } =
                            await getCurrentScore(
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
                    }
                } catch {}
                return;
            }
        }
    }

    // ---------------------------
    // Mod award handling
    // ---------------------------
    if (triggerUsed === modCommand) {
        let modAwardUsername: string | undefined;
        const idx = commentBody.indexOf(triggerUsed);
        if (idx >= 0) {
            const after =
                commentBody
                    .slice(idx + triggerUsed.length)
                    .trim()
                    .split(/\s+/)[0] ?? "";
            modAwardUsername = after
                ? after.startsWith("u/")
                    ? after.slice(2)
                    : after
                : undefined;
        }
        if (!modAwardUsername) return;
        if (!/^[a-z0-9_-]{3,21}$/i.test(modAwardUsername))
            modAwardUsername = modAwardUsername.toLowerCase();
        if (modAwardUsername === botName) {
            const botMsg = formatMessage(
                (settings[AppSetting.BotAwardMessage] as string) ??
                    TemplateDefaults.BotAwardMessage,
                { name: pointName }
            );
            await replyToUser(
                context,
                notifyOnAutoSuperuserString,
                awarder,
                botMsg,
                commentId
            );
            return;
        }
        const authorized = isMod || isSuperUser;
        if (!authorized) {
            const failMsg = formatMessage(
                (settings[AppSetting.ModAwardCommandFail] as string) ??
                    TemplateDefaults.ModAwardCommandFailMessage,
                { awarder, command: modCommand, name: pointName }
            );
            await replyToUser(
                context,
                notifyOnAutoSuperuserString,
                awarder,
                failMsg,
                commentId
            );
            return;
        }
        const modDupKey = `modAward-${event.comment.parentId}`;
        if (await context.redis.exists(modDupKey)) {
            const alreadyMsg = formatMessage(
                (settings[AppSetting.ModAwardAlreadyGiven] as string) ??
                    TemplateDefaults.ModAwardAlreadyGivenMessage,
                { awardee: modAwardUsername, name: pointName }
            );
            await replyToUser(
                context,
                notifyOnAutoSuperuserString,
                awarder,
                alreadyMsg,
                commentId
            );
            return;
        }
        await context.redis.set(modDupKey, "1");
        const newScore = await context.redis.zIncrBy(
            redisKey,
            modAwardUsername,
            1
        );
        await context.scheduler.runJob({
            name: "updateLeaderboard",
            runAt: new Date(),
            data: {
                reason: `Mod award from ${awarder} to ${modAwardUsername} (new: ${newScore})`,
            },
        });

        try {
            const authorUser = await context.reddit.getUserByUsername(awarder);
            const isPostAuthor = event.post.authorId === authorUser?.id;
            if (!authorUser) return;
            if (isPostAuthor) {
                const restrictionLifted = await updateAuthorRedis(
                    context,
                    awarder,
                    commentId
                );
                if (restrictionLifted)
                    await maybeNotifyRestrictionLifted(context, event, awarder);
            }

            logger.debug(
                `🧩 OP ${authorUser.username} restriction counter incremented`
            );
        } catch (err) {
            logger.error(`Error incrementing user restriction counter`, {
                err,
                awarder,
            });
        }

        const leaderboard = `https://old.reddit.com/r/${subredditName}/wiki/${
            settings[AppSetting.LeaderboardName] ?? "leaderboard"
        }`;
        const awardeePage = `https://old.reddit.com/r/${subredditName}/wiki/user/${modAwardUsername}`;
        const successMsg = formatMessage(
            (settings[AppSetting.ModAwardCommandSuccess] as string) ??
                TemplateDefaults.ModAwardCommandSuccessMessage,
            {
                awardee: modAwardUsername,
                awarder,
                total: newScore.toString(),
                symbol: pointSymbol,
                leaderboard,
                awardeePage,
                name: pointName,
            }
        );
        await replyToUser(
            context,
            notifyOnAutoSuperuserString,
            awarder,
            successMsg,
            commentId
        );
        return;
    }

    // ---------------------------
    // Normal awarding flow
    // ---------------------------
    const hasPermission =
        accessControl === "everyone" ||
        (accessControl === "moderators-only" && isMod) ||
        (accessControl === "moderators-and-superusers" &&
            (isMod || isSuperUser)) ||
        (accessControl === "moderators-superusers-and-op" &&
            (isMod || isSuperUser || isOP));
    if (!hasPermission) {
        const msgKey =
            accessControl === "moderators-only"
                ? AppSetting.ModOnlyDisallowedMessage
                : accessControl === "moderators-and-superusers"
                ? AppSetting.ApprovedOnlyDisallowedMessage
                : AppSetting.OPOnlyDisallowedMessage;
        const notifyKey =
            accessControl === "moderators-only"
                ? AppSetting.NotifyOnModOnlyDisallowed
                : accessControl === "moderators-and-superusers"
                ? AppSetting.NotifyOnApprovedOnlyDisallowed
                : AppSetting.NotifyOnOPOnlyDisallowed;
        const denyMsg = formatMessage(
            (settings[msgKey] as string) ??
                TemplateDefaults.ModOnlyDisallowedMessage,
            { awarder, name: pointName }
        );
        await replyToUser(
            context,
            notifyOnAutoSuperuserString,
            awarder,
            denyMsg,
            commentId
        );
        return;
    }

    try {
        const postFlairText =
            (event.post as any)?.linkFlair?.text ?? (event.post as any)?.flairText ?? "";
        if (disallowedFlairList.some(
            (f) => f.toLowerCase() === String(postFlairText).toLowerCase()
        )) {
            const msg = formatMessage(
                (settings[AppSetting.DisallowedFlairMessage] as string) ??
                    TemplateDefaults.DisallowedFlairMessage,
                { awarder, name: pointName }
            );
            await replyToUser(
                context,
                notifyOnAutoSuperuserString,
                awarder,
                msg,
                commentId
            );
            return;
        }
    } catch {}

    const dupKey = `thanks-${event.comment.parentId}`;
    if (await context.redis.exists(dupKey)) {
        const alreadyMsg = formatMessage(
            (settings[AppSetting.DuplicateAwardMessage] as string) ??
                TemplateDefaults.DuplicateAwardMessage,
            { awarder, name: pointName }
        );
        await replyToUser(
            context,
            notifyOnAutoSuperuserString,
            awarder,
            alreadyMsg,
            commentId
        );
        return;
    }

    if (event.author.id === parentComment.authorId) {
        const selfMsg = formatMessage(
            (settings[AppSetting.SelfAwardMessage] as string) ??
                TemplateDefaults.NotifyOnSelfAwardTemplate,
            { awarder, name: pointName }
        );
        await replyToUser(
            context,
            notifyOnAutoSuperuserString,
            awarder,
            selfMsg,
            commentId
        );
        return;
    }

    // Award the point normally
    await context.redis.set(dupKey, "1");
    const recipient = parentComment?.authorName ?? "";
    const newScoreNormal = await context.redis.zIncrBy(redisKey, recipient, 1);
    await context.scheduler.runJob({
        name: "updateLeaderboard",
        runAt: new Date(),
        data: {
            reason: `Awarded a point to ${recipient}. New score: ${newScoreNormal}`,
        },
    });

    try {
        const authorUser = await context.reddit.getUserByUsername(awarder);
        const isPostAuthor = event.post.authorId === authorUser?.id;
        if (!authorUser) return;
        if (isPostAuthor) {
            const restrictionLifted = await updateAuthorRedis(
                context,
                awarder,
                commentId
            );
            if (restrictionLifted)
                await maybeNotifyRestrictionLifted(context, event, awarder);
        }
        logger.debug(
            `🧩 OP ${authorUser.username} restriction counter incremented`
        );
    } catch (err) {
        logger.error(`Error incrementing user restriction counter`, {
            err,
            awarder,
        });
    }

    try {
        const recipientUser = await context.reddit.getUserByUsername(recipient);
        if (recipientUser) {
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
        }
    } catch {}

    const leaderboard = `https://old.reddit.com/r/${subredditName}/wiki/${
        settings[AppSetting.LeaderboardName] ?? "leaderboard"
    }`;
    const awardeePage = `https://old.reddit.com/r/${subredditName}/wiki/user/${recipient}`;
    const successMsg = formatMessage(
        (settings[AppSetting.SuccessMessage] as string) ??
            TemplateDefaults.NotifyOnSuccessTemplate,
        {
            awardee: recipient,
            awarder,
            total: newScoreNormal.toString(),
            symbol: pointSymbol,
            leaderboard,
            awardeePage,
            name: pointName,
        }
    );
    await replyToUser(
        context,
        notifyOnAutoSuperuserString,
        awarder,
        successMsg,
        commentId
    );

    try {
        await maybeNotifyAutoSuperuser(
            context,
            settings,
            recipient,
            parentComment.permalink ?? event.post.permalink,
            event.comment.parentId,
            newScoreNormal,
            "user"
        );
    } catch {}
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
