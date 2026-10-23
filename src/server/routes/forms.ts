import { Hono } from "hono";
import {
    createCompatContext,
    toUiResponse,
    type UiCapture,
} from "../repbot/compat";
import {
    manualSetPointsFormHandler,
    manualSetUserWikiTotalsFormHandler,
    manualPostRestrictionRemovalHandler,
} from "../repbot/triggers/utils/mod-utilities";
import {
    manualSetFlairManagementFormHandler,
    manualSetFlairManagementForUserFormHandler,
    transferWikiFormHandler,
} from "../repbot/moderation";
import type { UiResponse } from "@devvit/web/shared";
import { reddit, redis, settings } from "@devvit/web/server";
import { POINTS_STORE_KEY } from "../repbot/triggers/utils/redisKeys";

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
 * Returns every user in POINTS_STORE_KEY, ordered from highest points to
 * lowest points. Rank is based on each user's position in that ordering.
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

forms.post("/create-post", async (c) => {
    try {
        const values = await c.req.json<CreatePostFormValues>();

        // Resolve subreddit safely.
        const subredditName = (await reddit.getCurrentSubreddit())?.name;

        if (!subredditName) {
            throw new Error("Subreddit name could not be determined");
        }

        // Remove the existing leaderboard post if requested.
        if (values.removeExisting) {
            const existing = await redis.get(REDIS_KEY);

            if (existing) {
                try {
                    const data = JSON.parse(existing) as CustomPostData;
                    const oldPost = await reddit.getPostById(data.postId);
                    await oldPost.remove();
                    console.log("Removed existing leaderboard post");
                } catch (err) {
                    console.warn("Failed to remove old post:", err);
                }
            }
        }

        // Create the new post.
        const postTitle = values.postTitle ?? "TheRepBot High Scores";

        const post = await reddit.submitCustomPost({
            subredditName,
            title: postTitle,
        });

        // Store only the post ID; leaderboard size is not part of this data.
        const newData: CustomPostData = {
            postId: post.id,
        };

        await redis.set(REDIS_KEY, JSON.stringify(newData));

        console.log("Stored leaderboard post configuration:", newData);

        // Sticky if requested.
        if (values.stickyPost) {
            await post.sticky();
        }

        const pointName = (await settings.get<string>("pointName")) ?? "point";

        // Bot comment.
        const botComment = await reddit.submitComment({
            id: post.id,
            text: formatMessage(
                `This leaderboard displays all users ranked by their total ${pointName}s in this subreddit, from highest to lowest.\n\n` +
                    `It is updated periodically, but you can also refresh it manually by clicking the refresh button at the top of the leaderboard.\n\n` +
                    `[Mod info regarding the leaderboard](https://reddit.com/r/${subredditName}/wiki/therepbot/modinfo)`,
                {}
            ),
        });

        await botComment.distinguish(true);

        if (values.lockBotComment) {
            await botComment.lock();
        }

        return c.json<UiResponse>({
            showToast: {
                text: "Leaderboard post has been created successfully",
                appearance: "success",
            },
            navigateTo: `https://reddit.com/r/${subredditName}/comments/${post.id}`,
        });
    } catch (error) {
        console.error("Create post error:", error);

        return c.json<UiResponse>(
            {
                showToast: {
                    text: "Failed to create leaderboard post",
                    appearance: "neutral",
                },
            },
            400
        );
    }
});

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
        "\n\n---\n\n^(I am a bot - please contact [my creator](https://reddit.com/message/compose?to=/r/TheRepBot) with any questions)";

    if (
        !result
            .trim()
            .endsWith(
                "\n\n---\n\n^(I am a bot - please contact [my creator](https://reddit.com/message/compose?to=/r/TheRepBot) with any questions)"
            )
    ) {
        result = result.trim() + footer;
    }

    return result;
}

const formHandlers: Record<string, (event: any, context: any) => Promise<any>> =
    {
        "/manualSetPointsForm": manualSetPointsFormHandler,
        "/manualSetUserWikiTotalsForm": manualSetUserWikiTotalsFormHandler,
        "/manualSetFlairManagementForm": manualSetFlairManagementFormHandler,
        "/manualSetFlairManagementForUserForm":
            manualSetFlairManagementForUserFormHandler,
        "/manualPostRestrictionRemovalForm":
            manualPostRestrictionRemovalHandler,
        "/transferWikiForm": transferWikiFormHandler,
    };

for (const [path, handler] of Object.entries(formHandlers)) {
    forms.post(path, async (c) => {
        const data = await c.req.json().catch(() => ({}));
        const values = data.values ?? data;
        const capture: UiCapture = {};

        await handler({ ...data, values }, createCompatContext(data, capture));

        return c.json<UiResponse>(toUiResponse(capture) as UiResponse, 200);
    });
}
