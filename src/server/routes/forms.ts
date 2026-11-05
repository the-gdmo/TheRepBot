import { Hono } from "hono";
import type { JsonObject, UiResponse } from "@devvit/web/shared";
import { reddit, redis, settings } from "@devvit/web/server";
import { POINTS_STORE_KEY } from "../core/utils/redisKeys";
import {
    createRequestContext,
    toUiResponse,
    UiCapture,
} from "../core/request-context";
import { logger } from "../core/utils/logger";
import { manualSetPointsFormHandler } from "../core/utils/mod-utilities";
import { FormOnSubmitEvent } from "../core/moderation";

type CreatePostFormValues = {
    postTitle?: string;
    stickyPost?: boolean;
    removeExisting?: boolean;
    lockBotComment?: boolean;
};

export interface CustomPostData {
    postId: `t3_${string}`;
}

export interface LeaderboardEntry {
    rank: number;
    username: string;
    points: number;
}

export const forms = new Hono();

const REDIS_KEY = "customPostData";

/**
 * Returns users ordered from highest points to lowest points.
 */
export async function getFullLeaderboard(): Promise<LeaderboardEntry[]> {
    const entries = await redis.zRange(POINTS_STORE_KEY, 0, -1, {
        by: "rank",
        reverse: true,
    });

    return entries.map((entry, index) => ({
        rank: index + 1,
        username: entry.member,
        points: entry.score,
    }));
}

/**
 * Create or replace the custom leaderboard post.
 */
forms.post("/create-post", async (c) => {
    try {
        const values = await c.req.json<CreatePostFormValues>();

        const subredditName = (await reddit.getCurrentSubreddit())?.name;

        if (!subredditName) {
            throw new Error("Subreddit name could not be determined");
        }

        // Remove the previous leaderboard post if requested.
        if (values.removeExisting) {
            const existing = await redis.get(REDIS_KEY);

            if (existing) {
                try {
                    const data = JSON.parse(existing) as CustomPostData;
                    const oldPost = await reddit.getPostById(data.postId);

                    await oldPost.remove();
                    console.log("Removed existing leaderboard post");
                } catch (error) {
                    console.warn("Failed to remove old post:", error);
                }
            }
        }

        const postTitle = values.postTitle?.trim() || "RepBot High Scores";

        // Create the leaderboard post.
        const post = await reddit.submitCustomPost({
            subredditName,
            title: postTitle,
        });

        const newData: CustomPostData = {
            postId: post.id as `t3_${string}`,
        };

        // Store the new leaderboard post ID.
        await redis.set(REDIS_KEY, JSON.stringify(newData));

        // Apply the requested sticky setting.
        if (values.stickyPost) {
            await post.sticky();
        }

        const pointName = (await settings.get<string>("pointName")) ?? "point";

        const commentText =
            `This leaderboard displays all users ranked by their total ${pointName}s in this subreddit, from highest to lowest.\n\n` +
            "It is updated periodically, but you can also refresh it manually by clicking the refresh button at the top of the leaderboard.\n\n" +
            `[Mod info regarding the leaderboard](https://reddit.com/r/${subredditName}/wiki/therepbot/modinfo)`;

        // Add and distinguish the explanatory bot comment.
        const botComment = await reddit.submitComment({
            id: post.id,
            text: commentText,
        });

        await botComment.distinguish(true);

        if (values.lockBotComment) {
            await botComment.lock();
        }

        const response: UiResponse = {
            showToast: {
                text: "Leaderboard post has been created successfully",
                appearance: "success",
            },
            navigateTo: `https://reddit.com/r/${subredditName}/comments/${post.id}`,
        };

        return c.json<UiResponse>(response, 200);
    } catch (error) {
        console.error("Create leaderboard post error:", error);

        const response: UiResponse = {
            showToast: {
                text: "Failed to create leaderboard post. Check the server logs for details.",
                appearance: "neutral",
            },
        };

        return c.json<UiResponse>(response, 500);
    }
});

forms.post("/set-points", async (c) => {
    const data = await c.req.json().catch(() => ({}));
    const capture: UiCapture = {};

    try {
        const context = await createRequestContext(data, capture);

        await manualSetPointsFormHandler(
            data as FormOnSubmitEvent<JsonObject>,
            context
        );

        return c.json<UiResponse>(toUiResponse(capture), 200);
    } catch (error) {
        logger.error(`Manual points form submission failed: ${error}`);

        return c.json<UiResponse>(
            {
                showToast: {
                    text: "Failed to update the user's score",
                    appearance: "neutral",
                },
            },
            500
        );
    }
});
