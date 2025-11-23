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
import { isModerator, SafeWikiClient } from "./utility.js";
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
    // 🔁 Still OK to refresh the leaderboard – this does NOT change any scores
    const { currentScore } = await getCurrentScore(author, context, settings);
    await context.scheduler.runJob({
        name: "updateLeaderboard",
        runAt: new Date(),
        data: {
            reason: `Post submit by ${authorName}. Current score: ${currentScore}`,
        },
    });

    const awardsRequiredEntry =
        (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) ?? 0;
    if (awardsRequiredEntry === 0) {
        logger.info("❌ Post restriction is not enabled");
        return;
    }

    // ──────────────── Redis Keys ────────────────
    const restrictedFlagKey = `restrictedUser:${author.username}`;
    const requiredKey = `awardsRequired:${author.username}`;
    const lastValidPostKey = `lastValidPost:${author.username}`;
    const lastValidPostTitleKey = `lastValidPostTitle:${author.username}`;

    // ──────────────── Decide whether or not moderators should have the restriction applied to them ────────────────
    const modsExempt =
        (settings[AppSetting.ModeratorsExempt] as boolean) ?? true;
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
        restrictedFlagExists,
        requiredFlagExists,
        awardsRequired: awardsRequiredEntry,
        isRestricted,
    });

    // ✅ First post allowed — mark user as restricted *after* posting
    if (!isRestricted) {
        const restrictionTemplate =
            (settings[AppSetting.MessageToRestrictedUsers] as string) ??
            TemplateDefaults.MessageToRestrictedUsers;

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

        // 🧠 Store which post was valid
        await context.redis.set(lastValidPostKey, event.post.permalink);
        await context.redis.set(lastValidPostTitleKey, event.post.title);

        // 🧮 Initialize restriction requirement (but do NOT increment award counter)
        await updateAuthorRedisOnPostSubmit(context, authorName);

        logger.info(
            `✅ First post allowed for ${author.username}. Restriction notice pinned. Future posts restricted until ${awardsRequiredEntry} awards.`
        );
        return;
    }

    // ──────────────── Subsequent posts while restricted ────────────────
    const pointTriggerWords =
        (settings[AppSetting.PointTriggerWords] as string) ?? "!award\n.award";

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
    const titleKey = await context.redis.get(
        `lastValidPostTitle:${author.username}`
    );
    const lastValidPost = await context.redis.get(
        `lastValidPost:${author.username}`
    );
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

    if (helpPage) {
        subsequentPostRestrictionMessage =
            subsequentPostRestrictionMessage.replace(
                /{{helpPage}}/g,
                `https://www.reddit.com/r/${subredditName}/wiki/${helpPage}`
            );
    }
    if (discordLink) {
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

    // 🗨️ Post comment
    const postRestrictionComment = await context.reddit.submitComment({
        id: event.post.id,
        text: subsequentPostRestrictionMessage,
    });

    // 🏅 Distinguish and pin the comment, remove the new post
    await postRestrictionComment.distinguish(true);
    await context.reddit.remove(event.post.id, false);

    logger.info("🚫 Removed post from restricted user", {
        username: author.username,
        postId: event.post.id,
    });
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
                subject: `Message from ReputatorBot on ${subredditName}`,
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

async function maybeNotifyRestrictionLifted(
    context: TriggerContext,
    event: CommentSubmit | CommentUpdate,
    username: string
): Promise<void> {
    const restrictedKey = `restrictedUser:${username}`;
    const requiredKey = `awardsRequired:${username}`;

    logger.debug("🔔 maybeNotifyRestrictionLifted called", {
        username,
        restrictedKey,
        requiredKey,
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
        if (
            remainingRaw !== undefined &&
            remainingRaw !== null &&
            remainingRaw !== ""
        ) {
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

        // If the restricted flag still exists OR remaining>0, then they're still restricted
        if (restrictedExists || (remaining !== null && remaining > 0)) {
            logger.debug(
                "ℹ️ Marker present but user still appears restricted; not notifying yet",
                {
                    username,
                    restrictedExists,
                    remaining,
                }
            );
            return;
        }

        // At this point:
        // - restrictedKey does not exist
        // - remaining is null or 0
        // → This is our "restriction fully lifted" condition.

        const settings = await context.settings.getAll();

        // 1️⃣ Determine how to notify (fallback: none)
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
            notifySetting,
            notifyMode,
        });

        // If set to "none", mark as notified and bail
        if (notifyMode === NotifyOnRestrictionLiftedReplyOptions.NoReply) {
            logger.info(
                "✅ Restriction lifted but NotifyOnRestrictionLifted=none; no user-facing message sent",
                { username }
            );
            return;
        }

        // 2️⃣ Build message template & placeholders
        const pointName =
            (settings[AppSetting.PointName] as string | undefined) ?? "point";
        const awardsRequired =
            (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) ??
            0;

        const pointTriggerWordsRaw =
            (settings[AppSetting.PointTriggerWords] as string | undefined) ??
            "!award\n.award";

        const triggerWordsArray = pointTriggerWordsRaw
            .split(/\r?\n/)
            .map((w) => w.trim())
            .filter(Boolean);

        const commandsList = triggerWordsArray.join(", ");

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

        const commentPermalink = event.comment?.permalink ?? "";

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

        // 3️⃣ Deliver notification
        if (
            notifyMode === NotifyOnRestrictionLiftedReplyOptions.ReplyAsComment
        ) {
            if (!event.comment) {
                logger.warn(
                    "⚠️ NotifyOnRestrictionLifted=ReplyAsComment but no comment in event; falling back to PM",
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

    // ─────────────────────────────────────────────────────────────
    // Settings & common locals
    // ─────────────────────────────────────────────────────────────
    const settings = await context.settings.getAll();
    const subredditName = event.subreddit.name;
    const awarder = event.author.name;
    const commentBodyRaw = event.comment.body ?? "";
    const commentBody = commentBodyRaw.toLowerCase();

    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const pointSymbol = (settings[AppSetting.PointSymbol] as string) ?? "";
    const redisKey = POINTS_STORE_KEY;

    // Permissions scaffolding
    const accessControl = ((settings[AppSetting.AccessControl] as string[]) ?? [
        "everyone",
    ])[0];
    const isMod = await isModerator(context, subredditName, awarder);
    const isSuperUser = await getUserIsSuperuser(awarder, context);
    const isOP = event.author.id === event.post.authorId;

    // Disallowed flair scaffolding (normal flow only — ALT FLOW BYPASSES)
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

    // Alternate Command users list
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

    // Triggers: normal user commands
    const userCommands = (
        (settings[AppSetting.PointTriggerWords] as string) ?? "!award\n.award"
    )
        .split("\n")
        .map((c) => c.toLowerCase().trim())
        .filter(Boolean);

    // Superuser/Mod award command
    const modCommand = (
        (settings[AppSetting.ModAwardCommand] as string) ?? "!modaward"
    )
        .toLowerCase()
        .trim();

    const allTriggers = Array.from(
        new Set([...userCommands, modCommand].filter((t) => t && t.length > 0))
    );

    // ─────────────────────────────────────────────────────────────
    // Detect if any trigger exists in comment
    // ─────────────────────────────────────────────────────────────
    const triggerUsed = allTriggers.find((t) => commentBody.includes(t));
    if (!triggerUsed) {
        logger.debug("❌ No valid award command found.");
        return;
    }
    logger.debug("🧩 Command detected", { triggerUsed });

    // ban system users from triggering
    if (
        ["automoderator", context.appName.toLowerCase()].includes(
            awarder.toLowerCase()
        )
    ) {
        logger.debug("❌ System user attempted a command");
        return;
    }

    // ─────────────────────────────────────────────────────────────
    // ALT MENTION FLOW
    // - Only when NOT using modCommand
    // - pattern: "<triggerUsed> u/username"
    // - username must be 3–21 chars [a-z0-9_-]
    // - ALT rights: awarder must be in altCommandUsers
    // ─────────────────────────────────────────────────────────────
    let mentionedUsername: string | undefined;

    const altUserSetting =
        (settings[AppSetting.AlternatePointCommandUsers] as
            | string
            | undefined) ?? "";
    const altUsers = altUserSetting
        .split(",")
        .map((user) => user.trim().toLowerCase());
    // Is the awarder an ALT user?
    const awarderLower = event.author.name.toLowerCase();
    const userIsAltUser = altUsers.includes(awarderLower);

    if (!userIsAltUser) {
        logger.debug("⛔ ALT flow skipped — awarder is NOT an ALT user", {
            awarder,
            triggerUsed,
            altUsers,
            userIsAltUser,
        });
        return;
    }

    if (triggerUsed && userIsAltUser) {
        // Extract username token immediately after the trigger
        const idx = commentBody.indexOf(triggerUsed);
        if (idx >= 0) {
            const rawAfter = commentBody.slice(idx + triggerUsed.length);

            // Must have a space and then u/<username>
            // Example: " u/ryry50583583"
            const spaceMatch = rawAfter.match(/\su\/([A-Za-z0-9_-]+)/);

            // Log if match is truly null
            if (spaceMatch === null) {
                logger.debug(
                    "❌ ALT username parse failed — spaceMatch was null",
                    {
                        awarder,
                        triggerUsed,
                        rawAfter,
                        spaceMatch,
                    }
                );
                return;
            }

            // Extract username BEFORE any validation
            mentionedUsername = spaceMatch[1].toLowerCase();

            logger.debug("🔍 ALT extracted username (pre-validation)", {
                awarder,
                triggerUsed,
                rawAfter,
                extracted: mentionedUsername,
            });
        }

        // If we extracted a username, validate + continue ALT logic
        if (mentionedUsername) {
            if (!/^[a-z0-9_-]{3,21}$/i.test(mentionedUsername)) {
                const usernameLengthTemplate = formatMessage(
                    (settings[AppSetting.UsernameLengthMessage] as
                        | string
                        | undefined) ?? TemplateDefaults.UsernameLengthMessage,
                    { awardee: mentionedUsername, awarder }
                );

                const newComment = await context.reddit.submitComment({
                    id: event.comment.id,
                    text: usernameLengthTemplate,
                });
                await newComment.distinguish();

                logger.warn("❌ ALT username failed validation", {
                    awarder,
                    mentionedUsername,
                });
                return;
            }

            const authorized = altCommandUsers.includes(awarder.toLowerCase());
            if (!authorized) {
                const failMessage = formatMessage(altFailMessageTemplate, {
                    altCommand: triggerUsed,
                    subreddit: subredditName,
                });

                if (
                    notifyAltFail ===
                    NotifyOnAlternateCommandFailReplyOptions.ReplyAsComment
                ) {
                    const failComment = await context.reddit.submitComment({
                        id: event.comment.id,
                        text: failMessage,
                    });
                    await failComment.distinguish();
                } else if (
                    notifyAltFail ===
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

            // MAIN ALT FLOW (everything stays exactly the same)
            logger.debug("🔎 ALT flow username probe", {
                extracted: mentionedUsername,
                triggerUsed,
            });

            // Duplicate-prevention for ALT flow
            const altDupKey = `customAward-${event.post.id}-${mentionedUsername}`;
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
                        subject: `You've already awarded this comment`,
                        text: dupMsg,
                    });
                } else if (
                    notify ===
                    NotifyOnPointAlreadyAwardedToUserReplyOptions.ReplyAsComment
                ) {
                    const newComment = await context.reddit.submitComment({
                        id: event.comment.id,
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

            // Award (ALT)
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
                    reason: `Alternate award from ${awarder} to ${mentionedUsername} (new: ${newScore})`,
                },
            });

            // Restriction progress (ALT)
            const restrictionLifted = await updateAuthorRedis(context, awarder);
            if (restrictionLifted) {
                await maybeNotifyRestrictionLifted(context, event, awarder);
            }

            // Notify success (ALT)
            const leaderboard = `https://old.reddit.com/r/${subredditName}/wiki/${
                settings[AppSetting.LeaderboardName] ?? "leaderboard"
            }`;
            const symbol = pointSymbol;
            const awardeePage = `https://old.reddit.com/r/${event.subreddit.name}/wiki/user/${mentionedUsername}`;

            const successMessage = formatMessage(altSuccessMessageTemplate, {
                name: pointName,
                awardee: mentionedUsername,
                awarder,
                total: newScore.toString(),
                symbol,
                leaderboard,
                awardeePage,
            });

            if (
                notifyAltSuccess ===
                NotifyOnAlternateCommandSuccessReplyOptions.ReplyAsComment
            ) {
                const newComment = await context.reddit.submitComment({
                    id: event.comment.id,
                    text: successMessage,
                });
                await newComment.distinguish();
            } else if (
                notifyAltSuccess ===
                NotifyOnAlternateCommandSuccessReplyOptions.ReplyByPM
            ) {
                await context.reddit.sendPrivateMessage({
                    to: awarder,
                    subject: "Alternate Command Successful",
                    text: successMessage,
                });
            }

            // Flair update (ALT)
            try {
                const recipientUser = await context.reddit.getUserByUsername(
                    mentionedUsername
                );
                if (recipientUser) {
                    const { currentScore: recipientScore } =
                        await getCurrentScore(recipientUser, context, settings);
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
                logger.error("❌ ALT flair update error", { err });
            }

            // Auto-superuser notification (ALT)
            await maybeNotifyAutoSuperuser(
                context,
                settings,
                mentionedUsername,
                event.comment.permalink,
                event.comment.id,
                newScore,
                modCommand
            );

            logger.info(
                `🏅 ALT award: ${awarder} → ${mentionedUsername} +1 ${pointName}`
            );

            // Update user wikis
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
                logger.error("❌ Failed to update user wiki (ALT)", {
                    awarder,
                    mentionedUsername,
                    err,
                });
            }

            return; // ALT path fully handled
        }
    }

    // ─────────────────────────────────────────────────────────────
    // From here on: flows that rely on parent comment
    // (MOD AWARD + NORMAL FLOW)
    // ─────────────────────────────────────────────────────────────

    // Parent comment guard (must not be a link)
    if (isLinkId(event.comment.parentId)) {
        logger.debug("❌ Parent ID is a link — ignoring (normal/mod flow).");
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

    const recipient = parentComment.authorName;
    if (!recipient) {
        logger.warn("❌ No recipient found (normal/mod flow).");
        return;
    }

    // Ignored context (quote/alt/spoiler) check for *each* trigger found in text
    for (const trigger of allTriggers) {
        if (!new RegExp(`${trigger}`, "i").test(commentBody)) continue;
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
                        {
                            user: event.author.name,
                            trigger,
                            ignoredText,
                        }
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

    // Bot can't be awardee
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
    // MOD AWARD FLOW (AppSetting.ModAwardCommand)
    // ─────────────────────────────────────────────────────────────
    if (triggerUsed === modCommand) {
        logger.debug("🔧 ModAwardCommand detected", {
            modCommand,
            triggerUsed,
        });

        // Extract target username after modCommand, if present
        let modAwardUsername: string | undefined;
        {
            const idx = commentBody.indexOf(triggerUsed);
            if (idx >= 0) {
                const after =
                    commentBody
                        .slice(idx + triggerUsed.length)
                        .trim()
                        .split(/\s+/)[0] ?? "";

                if (after) {
                    modAwardUsername = after.startsWith("u/")
                        ? after.slice(2)
                        : after;
                }
            }
        }

        if (modAwardUsername) {
            modAwardUsername = modAwardUsername.toLowerCase();
        }

        // If no valid username token, default to parent comment author
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

        // Prevent awarding the bot itself
        if (modAwardUsername === context.appName.toLowerCase()) {
            const newComment = await context.reddit.submitComment({
                id: event.comment.id,
                text: botAwardMessage,
            });
            await newComment.distinguish();
            logger.debug("❌ Bot cannot receive mod awards either");
            return;
        }

        // Authorization: must be mod or trusted user
        const authorized = isMod || isSuperUser;
        if (!authorized) {
            const failTemplate =
                (settings[AppSetting.ModAwardCommandFail] as string) ??
                TemplateDefaults.ModAwardCommandFailMessage;

            const failMessage = formatMessage(failTemplate, {
                command: triggerUsed,
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
                    text: failMessage,
                });
                await comment.distinguish();
            } else if (
                notifyModFail === NotifyOnModAwardFailReplyOptions.ReplyByPM
            ) {
                await context.reddit.sendPrivateMessage({
                    to: awarder,
                    subject: "Mod Award Command Not Allowed",
                    text: failMessage,
                });
            }

            logger.warn("🚫 Unauthorized mod award attempt", {
                awarder,
                modAwardUsername,
            });
            return;
        }

        // Duplicate key specific to mod-award path (by comment+target)
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
            return;
        }

        // Mark awarded
        await context.redis.set(modDupKey, "1");

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

        // Restriction progress (MOD)
        const restrictionLifted = await updateAuthorRedis(context, awarder);
        if (restrictionLifted) {
            await maybeNotifyRestrictionLifted(context, event, awarder);
        }

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
                logger.info("📄 Creating missing awarder wiki", { awarder });
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
                msg = `You do not have permission to award {{name}}s.`;
        }
        const out = formatMessage(msg, { name: pointName });

        if (
            replyChoice ===
                NotifyOnModOnlyDisallowedReplyOptions.ReplyAsComment ||
            replyChoice ===
                NotifyOnApprovedOnlyDisallowedReplyOptions.ReplyAsComment ||
            replyChoice === NotifyOnOPOnlyDisallowedReplyOptions.ReplyAsComment
        ) {
            const newComment = await context.reddit.submitComment({
                id: event.comment.id,
                text: out,
            });
            await newComment.distinguish();
        } else if (
            replyChoice === NotifyOnModOnlyDisallowedReplyOptions.ReplyByPM ||
            replyChoice ===
                NotifyOnApprovedOnlyDisallowedReplyOptions.ReplyByPM ||
            replyChoice === NotifyOnOPOnlyDisallowedReplyOptions.ReplyByPM
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
        return;
    }

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
    const alreadyKey = `thanks-${parentComment.id}`;
    if (await context.redis.exists(alreadyKey)) {
        const dupMsg = formatMessage(dupAlreadyMessage, { name: pointName });

        if (notifyDup === NotifyOnPointAlreadyAwardedReplyOptions.ReplyByPM) {
            await context.reddit.sendPrivateMessage({
                to: awarder,
                subject: `You've already awarded this comment`,
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

    // Award (NORMAL)
    const authorUser = await context.reddit.getUserByUsername(awarder);
    const newScore = await context.redis.zIncrBy(redisKey, recipient, 1);
    await context.redis.set(alreadyKey, "1");

    await setCleanupForUsers([recipient], context);
    await context.scheduler.runJob({
        name: "updateLeaderboard",
        runAt: new Date(),
        data: {
            reason: `Awarded a point to ${recipient}. New score: ${newScore}`,
        },
    });

    // Restriction counters (normal)
    const restrictionLifted = await updateAuthorRedis(context, awarder);
    if (restrictionLifted) {
        await maybeNotifyRestrictionLifted(context, event, awarder);
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
        const isPostAuthor = event.post.authorId === authorUser?.id;
        if (isPostAuthor && authorUser) {
            await updateAuthorRedis(context, authorUser.username);
            logger.debug(
                `🧩 OP ${authorUser.username} restriction counter incremented`
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

export async function updateAuthorRedis(
    context: TriggerContext,
    username: string
): Promise<boolean> {
    const restrictedKey = `restrictedUser:${username}`;
    const requiredKey = `awardsRequired:${username}`;
    const lastValidPostKey = `lastValidPost:${username}`;

    logger.debug("🔔 updateAuthorRedis called (award path)", {
        username,
        restrictedKey,
        requiredKey,
        lastValidPostKey,
    });

    // 🔢 Read current restricted count
    const raw = await context.redis.get(restrictedKey);
    logger.debug("📥 Raw restricted value from Redis", {
        username,
        restrictedKey,
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
            logger.warn(
                "⚠️ Invalid restricted value in Redis, resetting to 0",
                { username, raw }
            );
        }
    } else {
        logger.debug("ℹ️ No existing restricted count, starting at 0", {
            username,
        });
    }

    const newCount = currentCount + 1;

    logger.debug("➕ Incrementing restricted count", {
        username,
        previousCount: currentCount,
        newCount,
    });

    await context.redis.set(restrictedKey, newCount.toString());

    // ⚙️ Load config for awards required
    const settings = await context.settings.getAll();
    const awardsRequired =
        (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) ?? 0;

    logger.debug("⚙️ Loaded awardsRequired setting", {
        username,
        awardsRequired,
    });

    // If feature is off or misconfigured, don't keep them restricted
    if (awardsRequired <= 0) {
        logger.warn(
            "⚠️ awardsRequiredToCreateNewPosts <= 0, clearing restriction keys",
            { username, awardsRequired }
        );

        await Promise.all([
            context.redis.del(restrictedKey),
            context.redis.del(requiredKey),
            context.redis.del(lastValidPostKey),
        ]);

        return false;
    }

    const remaining = Math.max(0, awardsRequired - newCount);

    logger.debug("📊 Computed remaining awards required", {
        username,
        awardsRequired,
        newCount,
        remaining,
    });

    // Still under requirement → store remaining and keep restriction
    if (remaining > 0) {
        await context.redis.set(requiredKey, remaining.toString());

        logger.info("📊 Updated Redis (restriction still active)", {
            username,
            restrictedUser: newCount,
            remaining,
            restrictedKey,
            requiredKey,
        });

        return false; // requirement NOT yet met
    }

    // 🎉 Requirement COMPLETED — clean up keys & set permanent marker
    await Promise.all([
        context.redis.del(restrictedKey),
        context.redis.del(requiredKey),
        context.redis.del(lastValidPostKey),
    ]);

    logger.info("🎉 User restriction fully lifted and keys cleared", {
        username,
        finalCount: newCount,
        awardsRequired,
        removedKeys: [restrictedKey, requiredKey, lastValidPostKey],
    });

    return true; // requirement was met on this call
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
    ]);

    logger.info("✅ Restriction fully removed from Redis", {
        username: user.username,
        removedKeys: [
            restrictionKey,
            requiredKey,
            lastValidPostKey,
            lastValidTitleKey,
        ],
    });

    // ──────────────── Notify Moderator ────────────────
    context.ui.showToast(`✅ Post restriction removed for u/${user.username}.`);
    logger.info(
        `✅ Manual post restriction removal successful for u/${user.username}.`
    );
}
