import { TriggerContext, User } from "@devvit/public-api";
import {
    formatMessage,
    userCommandValues,
} from "../../utils/common-utilities.js";
import {
    AppSetting,
    NotifyOnSelfAwardReplyOptions,
    NotifyOnSuccessReplyOptions,
    TemplateDefaults,
} from "../../../settings.js";
import { CommentSubmit, CommentUpdate } from "@devvit/protos";
import { logger } from "../../../logger.js";
import {
    deleteRestrictedKey,
    getRestrictedKey,
    POINTS_STORE_KEY,
} from "../../post-logic/redisKeys.js";
import {
    getCurrentScore,
    getParentComment,
} from "../comment-trigger-context.js";
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
): Promise<boolean | undefined> {
    if (!event.comment) return;
    const key = `userCommand:${recipientId}-${event.comment.id}`;
    const exists = await context.redis.exists(key);
    return exists === 1;
}

/**
 * Awards a point to a normal user.
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
    const key = `userCommand:${recipient}-${event.comment.id}`;

    await context.redis.set(key, "1"); // Mark as awarded
    const scoreKey = `score:${recipient}`;

    let user: User | undefined;
    try {
        user = await context.reddit.getUserByUsername(awarder);
    } catch {
        //
    }
    if (!user) return;

    // Increment recipient score
    const newScore = await context.redis.zIncrBy(POINTS_STORE_KEY, awardee, 1);
    await context.redis.set(scoreKey, newScore.toString());

    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const pointSymbol = (settings[AppSetting.PointSymbol] as string) ?? "";
    const notifySuccess =
        (settings[AppSetting.NotifyOnSuccess] as NotifyOnSuccessReplyOptions) ??
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
        const newComment = await context.reddit.submitComment({
            id: event.comment.id,
            text: successMessage,
        });
        await newComment.distinguish();
    }

    logger.info(`✅ Awarded 1 point to ${recipient} from ${awarder}`, {
        newScore,
    });

    const subredditName = event.subreddit.name;
    try {
        const safeWiki = new SafeWikiClient(context.reddit);
        const awarderPage = await safeWiki.getWikiPage(
            subredditName,
            `user/${awarder.toLowerCase()}`
        );
        const recipientPage = await safeWiki.getWikiPage(
            subredditName,
            `user/${recipient}`
        );

        if (!awarderPage) await InitialUserWikiOptions(context, awarder);
        if (!recipientPage) await InitialUserWikiOptions(context, recipient);

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
}

/**
 * Executes the user command workflow.
 */
/**
 * Updates a user's restricted award count if they are the OP of the post.
 * Returns true if the user has satisfied the awards requirement, false if still restricted.
 */
export async function updateAuthorRedisIfOP(
    event: CommentSubmit | CommentUpdate,
    author: User | undefined,
    context: TriggerContext
): Promise<boolean> {
    if (!event.author || !event.post || !author) return true;

    const isPostAuthor = event.post.authorId === event.author.id;
    if (!isPostAuthor) return true;

    const restrictionKey = await getRestrictedKey(author);
    const raw = await context.redis.get(restrictionKey);
    const currentCount = raw ? Number(raw) || 0 : 0;
    const oldCount = currentCount;
    await context.redis.set(restrictionKey, (currentCount + 1).toString());

    const settings = await context.settings.getAll();
    const awardsRequired =
        (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) ?? 0;

    logger.debug(
        `🔢 Updated OP restricted count: ${oldCount} → ${currentCount} / ${awardsRequired}`,
        { awarder: author.username }
    );

    if (currentCount < awardsRequired) {
        logger.info(
            `⏳ User ${author.username} is still restricted from creating new posts: ${oldCount}/${awardsRequired} points`
        );
        return false; // still restricted
    } else {
        logger.info(
            `✅ User ${author.username} has satisfied the awards requirement: ${oldCount}/${awardsRequired} points`
        );
        await deleteRestrictedKey(author, context);
        return true; // eligible
    }
}

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
    const settings = await context.settings.getAll();

    // Blocked users
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
        logger.warn("❌ Blocked user attempted to award points", { awarder });
        return;
    }

    if (!recipient) {
        logger.warn("❌ Cannot determine recipient, skipping award", {
            awarder,
        });
        return;
    }

    let user: User | undefined;
    try {
        user = await context.reddit.getUserByUsername(awarder);
    } catch {}

    // 🔢 Update OP restricted count and check eligibility first
    const eligible = await updateAuthorRedisIfOP(event, user, context);
    if (!eligible) return; // user still restricted → do not award point

    // ✅ Check if point already awarded (only now)
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

    // 🏆 Award point
    await awardPointToUserNormalCommand(event, context, awarder, recipient);
}
