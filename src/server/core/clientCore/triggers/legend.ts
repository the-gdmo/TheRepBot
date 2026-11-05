import { reddit, redis, settings } from "@devvit/web/server";
import type {
    OnCommentCreateRequest,
    OnCommentUpdateRequest,
    T1,
    T3,
} from "@devvit/web/shared";
import {
    formatMessageOnComment,
    getNotifyMode,
    notifyUser,
} from "../../utils/common-utilities";
import { logger } from "../../utils/logger";
import { getParentComment, POINTS_STORE_KEY } from "../../utils/redisKeys";
import { isSystemAccount } from "./handlePostOrComment";

async function getLegendThreshold(): Promise<number> {
    return (await settings.get<number>("legendThreshold")) ?? 0;
}

/**
 * Runs after an award. A user who reaches the Legend threshold is
 * congratulated once, and is made an approved user if that's switched on.
 * Legends who were already past the threshold, such as players brought over
 * from RepBot, are approved at their next award but not congratulated again.
 */
export async function handleLegendPromotion(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    newScore: number
) {
    const threshold = await getLegendThreshold();
    if (threshold <= 0 || newScore < threshold) return;
    if (!event.comment || !event.subreddit) return;

    const parentComment = await getParentComment(event);
    const awardee = parentComment?.authorName;
    if (!awardee) return;

    if (await settings.get<boolean>("legendApprovedUser")) {
        const approvedKey = `legendApproved:${awardee.toLowerCase()}`;

        if (!(await redis.exists(approvedKey))) {
            try {
                await reddit.approveUser(awardee, event.subreddit.name);
                await redis.set(approvedKey, "1");
                logger.info("🏆 Made a Legend an approved user", { awardee });
            } catch (error) {
                logger.error("Couldn't make a Legend an approved user", {
                    awardee,
                    error: String(error),
                });
            }
        }
    }

    // Each award adds one point, so only a score exactly at the threshold has
    // just crossed it.
    if (newScore > threshold) return;

    const congratulatedKey = `legendCongratulated:${awardee.toLowerCase()}`;
    if (await redis.exists(congratulatedKey)) return;
    await redis.set(congratulatedKey, "1");

    const notifyMode = await getNotifyMode("notifyOnLegend");
    if (notifyMode === "none") return;

    const pointName = (await settings.get<string>("pointName")) ?? "point";
    const template = (await settings.get<string>("legendMessage")) ?? "";

    await notifyUser({
        mode: notifyMode,
        to: awardee,
        subject: `You're now a Legend of r/${event.subreddit.name}`,
        text: formatMessageOnComment(event, template, {
            awardee,
            threshold: threshold.toString(),
            name: pointName,
            subreddit: event.subreddit.name,
        }),
        commentId: event.comment.id,
    });

    logger.info("🏆 Congratulated a new Legend", { awardee, newScore });
}

/**
 * Creates or updates a moderator-distinguished Legend recognition
 * comment on the original post.
 *
 * Only top-level comments count.
 * The first Legend appears first, and subsequent Legends are
 * appended underneath in the order they comment.
 */

interface LegendComment {
    username: string;
    commentId: string;
    body: string;
    timestamp: number;
}

/**
 * Creates or updates a moderator-distinguished comment summarizing
 * all Legend comments on the original post.
 *
 * Only top-level comments count.
 * Multiple comments from the same Legend are allowed.
 * Comments are displayed chronologically.
 */
export async function notifyOpOfLegendReply(event: OnCommentCreateRequest) {
    if (!event.author || !event.comment || !event.post || !event.subreddit) {
        return;
    }

    if (!(await settings.get<boolean>("notifyOpOnLegendReply"))) return;

    // Only count top-level comments.
    if (!event.comment.parentId?.startsWith("t3_")) return;

    // Don't count the OP or system accounts.
    if (event.author.id === event.post.authorId) return;
    if (isSystemAccount(event.author.name)) return;

    const threshold = await getLegendThreshold();
    if (threshold <= 0) return;

    // Check whether the author qualifies as a Legend.
    const score = await redis.zScore(POINTS_STORE_KEY, event.author.name);

    if (score === undefined || score < threshold) return;

    const postId = event.post.id;

    // Redis keys.
    const commentKey = `legendReplyComment:${postId}`;
    const commentsKey = `legendReplyComments:${postId}`;

    // Get previously recorded Legend comments.
    const storedComments = await redis.get(commentsKey);

    const comments: LegendComment[] = storedComments
        ? JSON.parse(storedComments)
        : [];

    // Prevent processing the same comment twice.
    if (comments.some((comment) => comment.commentId === event.comment!.id)) {
        return;
    }

    // Add the new Legend comment.
    comments.push({
        username: event.author.name,
        commentId: event.comment.id,
        body: event.comment.body,
        timestamp: event.comment.createdAt
            ? new Date(event.comment.createdAt).getTime()
            : Date.now(),
    });

    // Sort chronologically.
    comments.sort((a, b) => a.timestamp - b.timestamp);

    // Format the summary.
    const formatLegendList = (legendComments: LegendComment[]) => {
        const count = legendComments.length;

        const entries = legendComments.map((comment) => {
            const commentId = comment.commentId.replace(/^t1_/, "");
            const cleanPostId = postId.replace(/^t3_/, "");
            const subreddit = event.subreddit!.name;

            const permalink = `https://www.reddit.com/r/${subreddit}/comments/${cleanPostId}/comment/${commentId}/`;

            const quotedText = comment.body
                .split("\n")
                .map((line) => `> ${line}`)
                .join("\n");

            return [
                `[**u/${comment.username} commented:**](${permalink})`,
                "",
                quotedText,
            ].join("\n");
        });

        return [
            `There ${count === 1 ? "is" : "are"} ${count} ${
                count === 1 ? "comment" : "comments"
            } from **legends** in this post:`,
            "",
            entries.join("\n\n"),
            "",
            "---",
            "",
            `This summary was generated automatically. If you have any questions, please contact r/${
                event.subreddit!.name
            } moderators.`,
        ].join("\n");
    };

    const commentText = formatLegendList(comments);

    // Check for an existing summary comment.
    const existingCommentId = await redis.get(commentKey);

    if (existingCommentId) {
        // Update the existing moderator comment.
        const existingComment = await reddit.getCommentById(
            existingCommentId as T1
        );

        await existingComment.edit({
            text: commentText,
        });
    } else {
        // Create the initial top-level summary comment.
        const newComment = await reddit.submitComment({
            id: postId as T3,
            text: commentText,
            runAs: "APP",
        });

        // Distinguish as a moderator without pinning.
        await newComment.distinguish(false);

        // Remember the summary comment ID.
        await redis.set(commentKey, newComment.id);
    }

    // Save the updated Legend comment list.
    await redis.set(commentsKey, JSON.stringify(comments));

    logger.info("🏆 Updated Legend comment summary", {
        legend: event.author.name,
        totalLegendComments: comments.length,
        postId,
    });
}
