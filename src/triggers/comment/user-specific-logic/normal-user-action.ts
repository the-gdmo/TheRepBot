import { TriggerContext, User } from "@devvit/public-api";
import {
    formatMessage,
    updateAwardeeFlair,
    userCommandValues,
} from "../../utils/common-utilities.js";
import {
    AppSetting,
    NotifyOnPointAlreadyAwardedToUserReplyOptions,
    NotifyOnRestrictionLiftedReplyOptions,
    NotifyOnSuccessReplyOptions,
    TemplateDefaults,
} from "../../../settings.js";
import { CommentSubmit, CommentUpdate } from "@devvit/protos";
import { logger } from "../../../logger.js";
import {
    deleteRestrictedKey,
    getRestrictedKey,
    POINTS_STORE_KEY,
    restrictedKeyExists,
} from "../../post-logic/redisKeys.js";
import { getParentComment } from "../comment-trigger-context.js";
import {
    InitialUserWikiOptions,
    updateUserWiki,
} from "../../../leaderboard.js";
import { SafeWikiClient } from "../../../utility.js";

/**
 * Checks if a comment contains any user command keywords.
 */
export async function commentContainsUserCommand(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext
): Promise<boolean> {
    if (!event.comment) return false;

    const userCommands = await userCommandValues(context);
    const body = event.comment.body.toLowerCase();

    return userCommands.some((command) =>
        new RegExp(`${command}`, "i").test(body)
    );
}

/**
 * Checks if a normal user command point has already been awarded.
 */
async function pointAlreadyAwardedWithNormalCommand(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
    recipientId: string
): Promise<boolean> {
    if (!event.comment) return false;
    const key = `userCommand:${recipientId}-${event.comment.id}`;
    const exists = await context.redis.exists(key);
    return exists === 1;
}

/**
 * Awards a point to a normal user and performs all success side-effects.
 */
async function awardPointToUserNormalCommand(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
    awarder: string,
    recipient: string
) {
    const parentComment = await getParentComment(event, context);
    if (!parentComment || !event.subreddit || !event.comment || !event.post)
        return;

    const awardee = parentComment.authorName;
    const settings = await context.settings.getAll();
    const awardKey = `userCommand:${recipient}-${event.comment.id}`;

    // Mark as awarded
    await context.redis.set(awardKey, "1");

    // Increment score
    const newScore = await context.redis.zIncrBy(POINTS_STORE_KEY, awardee, 1);

    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const pointSymbol = (settings[AppSetting.PointSymbol] as string) ?? "";
    const notifySuccess =
        (settings[AppSetting.NotifyOnSuccess] as string[])?.[0] ??
        NotifyOnSuccessReplyOptions.NoReply;

    const leaderboard = `https://old.reddit.com/r/${
        event.subreddit.name
    }/wiki/${settings[AppSetting.LeaderboardName] ?? "leaderboard"}`;

    const awardeePage = `https://old.reddit.com/r/${event.subreddit.name}/wiki/user/${recipient}`;
    const awarderPage = `https://old.reddit.com/r/${event.subreddit.name}/wiki/user/${awarder}`;

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
            awarderPage,
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
    } else if (notifySuccess === NotifyOnSuccessReplyOptions.ReplyAsComment) {
        const reply = await context.reddit.submitComment({
            id: event.comment.id,
            text: successMessage,
        });
        await reply.distinguish();
    }

    // 🎨 Update flair
    await updateAwardeeFlair(
        context,
        event.subreddit.name,
        awardee,
        newScore,
        settings
    );

    let user: User | undefined;

    try {
        user = await context.reddit.getUserByUsername(awarder);
    } catch {
        user = undefined;
    }
    if (!user) return;

    if (await restrictedKeyExists(context, awarder)) {
        await updateAuthorRedis(event, user, context);
    }

    logger.info(`✅ Awarded 1 point to ${recipient} from ${awarder}`, {
        newScore,
    });
}

/**
 * Updates OP restricted award count.
 * Missing restriction key = already eligible (never re-count).
 */
export async function updateAuthorRedis(
    event: CommentSubmit | CommentUpdate,
    author: User | undefined,
    context: TriggerContext
): Promise<void> {
    if (!event.author || !event.post || !author) return;

    const isPostAuthor = event.post.authorId === event.author.id;
    if (!isPostAuthor) return;

    const settings = await context.settings.getAll();
    const awardsRequired =
        (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) ?? 0;
    const awarder = event.author.name;

    let user: User | undefined;

    try {
        user = await context.reddit.getUserByUsername(awarder);
    } catch {
        user = undefined;
    }
    if (!user) return;

    const restrictionKey = await getRestrictedKey(author);
    const raw = await context.redis.get(restrictionKey);

    // 🔒 If the restriction key no longer exists, NEVER re-increment
    if (raw === null) {
        const notificationKey = `liftedMessageSent:${user.username}:${event.post.id}`;

        logger.debug(
            "Checking if restriction lifted notification already sent",
            {
                notificationKey,
            }
        );

        const notificationSent = await context.redis.exists(notificationKey);
        if (notificationSent) {
            logger.info("Notification has already been sent, skipping.", {
                notificationKey,
            });
            return;
        }

        logger.debug("Marking notification as sent in Redis", {
            notificationKey,
        });
        await context.redis.set(notificationKey, "1");

        const subredditName = event.subreddit?.name ?? "";

        logger.debug("Preparing lifted restriction message", {
            awarder,
            subredditName,
        });

        const liftedMsg = formatMessage(
            (settings[AppSetting.RestrictionLiftedMessage] as string) ??
                TemplateDefaults.RestrictionLiftedMessage,
            { awarder, subreddit: subredditName }
        );

        try {
            logger.info(`Sending restriction lifted PM to u/${user.username}`, {
                subject: `Restriction lifted in r/${subredditName}`,
                preview: liftedMsg.slice(0, 1000),
            });

            await context.reddit.sendPrivateMessage({
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
        await context.redis.set(restrictionKey, (currentCount + 1).toString());

        logger.info(
            `⏳ User ${author.username} still restricted: ${currentCount}/${awardsRequired}`
        );
        return;
    }

    logger.info(
        `✅ User ${author.username} satisfied award requirement: ${currentCount}/${awardsRequired}`
    );

    await deleteRestrictedKey(author, context);

    const notificationKey = `liftedMessageSent:${user.username}:${event.post.id}`;

    logger.debug("Checking if restriction lifted notification already sent", {
        notificationKey,
    });

    const notificationSent = await context.redis.exists(notificationKey);
    if (notificationSent) {
        logger.info("Notification has already been sent, skipping.", {
            notificationKey,
        });
        return;
    }

    logger.debug("Marking notification as sent in Redis", {
        notificationKey,
    });
    await context.redis.set(notificationKey, "1");

    const subredditName = event.subreddit?.name ?? "unknown-subreddit";

    logger.debug("Preparing lifted restriction message", {
        awarder,
        subredditName,
    });

    const liftedMsg = formatMessage(
        (settings[AppSetting.RestrictionLiftedMessage] as string) ??
            TemplateDefaults.RestrictionLiftedMessage,
        { awarder, subreddit: subredditName }
    );

    try {
        logger.info(`Sending restriction lifted PM to u/${user.username}`, {
            subject: `Restriction lifted in r/${subredditName}`,
            preview: liftedMsg.slice(0, 100),
        });

        await context.reddit.sendPrivateMessage({
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
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext
) {
    const parentComment = await getParentComment(event, context);
    if (
        !event.author ||
        !event.comment ||
        !event.post ||
        !event.subreddit ||
        !parentComment
    ) {
        logger.warn("❌ Missing required event data", { event });
        return;
    }
    const awarder = event.author.name;
    const recipient = parentComment.authorName;
    const userDupKey = `userAward:${parentComment.id}`;
    const settings = await context.settings.getAll();

    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const subredditName = event.subreddit.name;
    const dupMsg =
        (settings[AppSetting.PointAlreadyAwardedToUserMessage] as string) ??
        TemplateDefaults.PointAlreadyAwardedToUserMessage;
    const dupTemplate = formatMessage(dupMsg, {
        awarder,
        awardee: recipient,
        name: pointName,
    });

    if (await context.redis.exists(userDupKey)) {
        const notifyAlreadyAwardedUserCommand = ((settings[
            AppSetting.NotifyOnPointAlreadyAwardedToUser
        ] as string[]) ?? [
            NotifyOnPointAlreadyAwardedToUserReplyOptions.NoReply,
        ])[0];
        if (
            notifyAlreadyAwardedUserCommand ===
            NotifyOnPointAlreadyAwardedToUserReplyOptions.ReplyByPM
        ) {
            await context.reddit.sendPrivateMessage({
                to: recipient,
                subject: `You received a ${pointName} in ${subredditName}`,
                text: dupTemplate,
            });
        } else if (
            notifyAlreadyAwardedUserCommand ===
            NotifyOnPointAlreadyAwardedToUserReplyOptions.ReplyAsComment
        ) {
            const reply = await context.reddit.submitComment({
                id: event.comment.id,
                text: dupTemplate,
            });

            await reply.distinguish();
        }

        logger.info(`Comment has already received a user award`, {
            commentId: parentComment.id,
        });
        return;
    }

    let user: User | undefined;

    try {
        user = await context.reddit.getUserByUsername(awarder);
    } catch {
        user = undefined;
    }

    if (!user) return;

    // 🚫 Blocked users
    const blockedUsers = (
        (settings[AppSetting.UsersWhoCannotAwardPoints] as string) ?? ""
    )
        .split(/\r?\n/)
        .map((w) => w.trim())
        .filter(Boolean);

    if (blockedUsers.includes(awarder)) {
        const blockedTemplate =
            (settings[AppSetting.UsersWhoCannotAwardPointsMessage] as string) ??
            TemplateDefaults.UsersWhoCannotAwardPointsMessage;

        const blockedMessage = formatMessage(blockedTemplate, {
            name: (settings[AppSetting.PointName] as string) ?? "point",
            awarder,
        });

        const reply = await context.reddit.submitComment({
            id: event.comment.id,
            text: blockedMessage,
        });
        await reply.distinguish();
        return;
    }

    // 📘 Always update both user wiki pages on successful award
    try {
        const subredditName = event.subreddit.name;
        const safeWiki = new SafeWikiClient(context.reddit);

        const awarderWiki = await safeWiki.getWikiPage(
            subredditName,
            `user/${awarder.toLowerCase()}`
        );
        const recipientWiki = await safeWiki.getWikiPage(
            subredditName,
            `user/${recipient}`
        );

        if (!awarderWiki) await InitialUserWikiOptions(context, awarder);
        if (!recipientWiki) await InitialUserWikiOptions(context, recipient);

        const givenData = {
            postTitle: event.post.title,
            postUrl: event.post.permalink,
            recipient,
            commentUrl: event.comment.permalink,
        };

        await updateUserWiki(context, awarder, recipient, givenData);
    } catch (err) {
        logger.error("❌ Failed to update user wiki (Normal award)", {
            awarder,
            recipient,
            err,
        });
    }

    // 🛑 Duplicate award check
    const alreadyAwarded = await pointAlreadyAwardedWithNormalCommand(
        event,
        context,
        recipient
    );
    if (alreadyAwarded) {
        logger.info("⚠️ Point already awarded for this command", {
            awarder,
            recipient,
        });
        return;
    }

    await context.redis.set(userDupKey, "1");

    // 🏆 Award point + side effects
    await awardPointToUserNormalCommand(event, context, awarder, recipient);
}
