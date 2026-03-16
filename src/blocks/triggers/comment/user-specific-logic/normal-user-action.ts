import { TriggerContext, User } from "@devvit/public-api";
import {
    formatMessage,
    getTriggers,
    updateAwardeeFlair,
    userCommandValues,
} from "../../utils/common-utilities";
import {
    AppSetting,
    NotifyOnBlockedUserReplyOptions,
    NotifyOnPointAlreadyAwardedToUserReplyOptions,
    NotifyOnSelfAwardReplyOptions,
    NotifyOnSuccessReplyOptions,
    TemplateDefaults,
} from "../../../settings";
import { CommentSubmit, CommentUpdate } from "@devvit/protos";
import { logger } from "../../../logger";
import {
    deleteRestrictedKey,
    getRestrictedKey,
    POINTS_STORE_KEY,
    restrictedKeyExists,
} from "../../post-logic/redisKeys";
import { getParentComment } from "../comment-trigger-context";
import {
    InitialUserWikiOptions,
    updateUserWiki,
} from "../../../leaderboard";
import { SafeWikiClient } from "../../../utility";
import { handleAutoSuperuserPromotion } from "../../utils/user-utilities";

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
        const commandSuccessMessage = await context.reddit.submitComment({
            id: event.comment.id,
            text: successMessage,
        });
        await commandSuccessMessage.distinguish();
        await commandSuccessMessage.lock();
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
            logger.info(
                `Sending restriction lifted Toast to u/${user.username}`,
                {
                    preview: liftedMsg.slice(0, 1000),
                }
            );

            await logger.info(
                `✅ Successfully sent restriction lifted Toast to u/${user.username}`
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

    const commentBody = event.comment.body;
    const awarder = event.author.name;
    const recipient = parentComment.authorName;
    const settings = await context.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    let user: User | undefined;

    try {
        user = await context.reddit.getUserByUsername(awarder);
    } catch {
        user = undefined;
    }

    if (!user) return;

    const triggers = await getTriggers(context);

    const triggerUsed = triggers.find((t) =>
        commentBody.includes(t.toLowerCase())
    );
    if (!triggerUsed) return;

    // if (await handleIgnoredContextIfNeeded(event, context, triggerUsed)) {
    //     logger.info("🚫 Command ignored due to ignored context", {
    //         awarder,
    //         triggerUsed,
    //     });
    //     return;
    // }

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
        const notifyBlockedUserMode = (
            settings[AppSetting.NotifyOnBlockedUser] as string[]
        )?.[0];

        const blockedMessage = formatMessage(blockedTemplate, {
            name: (settings[AppSetting.PointName] as string) ?? "point",
            awarder,
            subreddit: event.subreddit.name,
        });

        if (
            notifyBlockedUserMode ===
            NotifyOnBlockedUserReplyOptions.ReplyAsComment
        ) {
            const userIsBlockedFromAwardingPointsMessage =
                await context.reddit.submitComment({
                    id: event.comment.id,
                    text: blockedMessage,
                });
            await userIsBlockedFromAwardingPointsMessage.distinguish();
            await userIsBlockedFromAwardingPointsMessage.lock();
        } else if (
            notifyBlockedUserMode === NotifyOnBlockedUserReplyOptions.ReplyByPM
        ) {
            await context.reddit.sendPrivateMessage({
                to: awarder,
                text: blockedMessage,
                subject: `You do not have permission to award ${pointName}s in r/${event.subreddit.name}`,
            });
        }

        return;
    }

    // 🛑 Self award check
    if (awarder === recipient) {
        const selfAwardTemplate = formatMessage(
            (settings[AppSetting.SelfAwardMessage] as string) ??
                TemplateDefaults.SelfAwardMessage,
            { awarder, name: pointName }
        );
        const notifyNormalSelfAwardMode = (
            settings[AppSetting.NotifyOnSelfAward] as string[]
        )?.[0];

        if (
            notifyNormalSelfAwardMode ===
            NotifyOnSelfAwardReplyOptions.ReplyAsComment
        ) {
            const selfAwardComment = await context.reddit.submitComment({
                id: event.comment.id,
                text: selfAwardTemplate,
            });
            await selfAwardComment.distinguish();
            await selfAwardComment.lock();
        } else if (
            notifyNormalSelfAwardMode ===
            NotifyOnSelfAwardReplyOptions.ReplyByPM
        ) {
            await context.reddit.sendPrivateMessage({
                to: awarder,
                text: selfAwardTemplate,
                subject: `You tried to award yourself a ${pointName}`,
            });
        }

        return;
    }

    // 🛑 Duplicate award check
    const key = `userAwardGiven:${parentComment.id}`;
    const alreadyAwarded = await context.redis.exists(key);
    if (alreadyAwarded) {
        const alreadyAwardedTemplate = formatMessage(
            (settings[AppSetting.PointAlreadyAwardedToUserMessage] as string) ??
                TemplateDefaults.PointAlreadyAwardedToUserMessage,
            { awarder, awardee: recipient, name: pointName }
        );

        const notifyMode = (
            settings[AppSetting.NotifyOnPointAlreadyAwardedToUser] as string[]
        )?.[0];

        if (
            notifyMode ===
            NotifyOnPointAlreadyAwardedToUserReplyOptions.ReplyAsComment
        ) {
            const alreadyAwardedMessage = await context.reddit.submitComment({
                id: event.comment.id,
                text: alreadyAwardedTemplate,
            });
            await alreadyAwardedMessage.distinguish();
            await alreadyAwardedMessage.lock();
        } else if (
            notifyMode ===
            NotifyOnPointAlreadyAwardedToUserReplyOptions.ReplyByPM
        ) {
            await context.reddit.sendPrivateMessage({
                to: awarder,
                subject: `[This comment](${parentComment.permalink}) has already received a ${pointName}`,
                text: alreadyAwardedTemplate,
            });
        }

        logger.info("⚠️ Point already awarded for this command", {
            awarder,
            recipient,
        });
        return;
    }
    logger.info(`Point not awarded yet for this command`);
    await context.redis.set(key, "1");

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

    // 🏆 Award point + side effects
    await awardPointToUserNormalCommand(event, context, awarder, recipient);

    // Auto Superuser logic
    const commandUsed =
        (settings[AppSetting.PointTriggerWords] as string) ?? "!award\n.award";
    const currentScore =
        ((await context.redis.zScore(POINTS_STORE_KEY, recipient)) as number) ??
        0;
    await handleAutoSuperuserPromotion(
        event,
        context,
        currentScore,
        commandUsed
    );
}
