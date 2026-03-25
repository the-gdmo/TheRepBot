import { Hono } from "hono";
import type { UiResponse } from "@devvit/web/shared";
import { context, reddit, redis, settings } from "@devvit/web/server";

type CreatePostFormValues = {
    postTitle?: string;
    numberOfUsers?: number;
    stickyPost?: boolean;
    removeExisting?: boolean;
    lockBotComment?: boolean;
};

export interface CustomPostData {
    postId: `t3_${string}`;
    numberOfUsers: number;
}

export const forms = new Hono();

const REDIS_KEY = "customPostData";
const NUMBER_OF_USERS_KEY = "leaderboard:numberOfUsers";
const MAX_USERS = 1_000_000_000_000_000;
const DEFAULT_USERS = 20;

forms.post("/create-post", async (c) => {
    try {
        const values = await c.req.json<CreatePostFormValues>();

        // ✅ Normalize + validate numberOfUsers
        let numberOfUsers =
            typeof values.numberOfUsers === "number"
                ? values.numberOfUsers
                : DEFAULT_USERS;

        if (numberOfUsers > MAX_USERS) {
            return c.json<UiResponse>({
                showToast: {
                    text: "User count must be less than or equal to 1,000,000,000,000,000",
                    appearance: "neutral",
                },
            });
        }

        if (numberOfUsers <= 0) {
            // "User count must be at least one (1).";
            return c.json<UiResponse>({
                showToast: {
                    text: "User count must be at least 1",
                    appearance: "neutral",
                },
            });
        }

        if (isNaN(numberOfUsers)) {
            numberOfUsers = DEFAULT_USERS;
        }

        console.log(`📊 Setting leaderboard size to ${numberOfUsers}`);
        await redis.set(NUMBER_OF_USERS_KEY, numberOfUsers.toString());

        // ✅ Resolve subreddit safely
        const subredditName =
            context.subredditName ?? (await reddit.getCurrentSubreddit())?.name;

        if (!subredditName) {
            throw new Error("Subreddit name could not be determined");
        }

        // ✅ Remove existing leaderboard post if requested
        if (values.removeExisting) {
            const existing = await redis.get(REDIS_KEY);

            if (existing) {
                try {
                    const data = JSON.parse(existing) as CustomPostData;
                    const oldPost = await reddit.getPostById(data.postId);
                    await oldPost.remove();
                    console.log("🗑️ Removed existing leaderboard post");
                } catch (err) {
                    console.warn("⚠️ Failed to remove old post:", err);
                }
            }
        }

        // ✅ Create new post
        const postTitle = values.postTitle ?? "TheRepBot High Scores";

        const post = await reddit.submitCustomPost({
            subredditName,
            title: postTitle,
        });

        // ✅ Store BOTH postId + numberOfUsers (your setter)
        const newData: CustomPostData = {
            postId: post.id,
            numberOfUsers,
        };

        await redis.set(REDIS_KEY, JSON.stringify(newData));

        console.log("✅ Stored leaderboard config:", newData);

        // ✅ Sticky if requested
        if (values.stickyPost) {
            await post.sticky();
        }

        const pointName = (await settings.get<string>("pointName")) ?? "point";

        // ✅ Bot comment
        const botComment = await reddit.submitComment({
            id: post.id,
            text: formatMessage(
                `This post displays the top **${newData.numberOfUsers}** users with the most ${pointName}s in this subreddit.\n\n` +
                    `It is updated periodically, but you can also refresh it manually by clicking the refresh button at the top of the leaderboard.\n\n` +
                    `Mods,\n\n` +
                    `If you add a help page to the bot settings, you must create a new leaderboard post or the help page link will not appear within the leaderboard.\n\n` +
                    `If you remove the help page, the same is true - you must create a new leaderboard post for the help page link to be removed.`,
                {},
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
        console.error("❌ Create post error:", error);

        return c.json<UiResponse>(
            {
                showToast: {
                    text: "Failed to create leaderboard post",
                    appearance: "neutral",
                },
            },
            400,
        );
    }
});

function formatMessage(
    template: string,
    placeholders: Record<string, string>,
): string {
    let result = template;
    for (const [key, value] of Object.entries(placeholders)) {
        const regex = new RegExp(`{{${key}}}`, "g");
        result = result.replace(regex, value);
    }

    const footer = `\n\n---\n\n^(I am a bot - please contact [my creator](https://reddit.com/message/compose?to=/r/TheRepBot) with any questions)`;
    if (
        !result
            .trim()
            .endsWith(
                `\n\n---\n\n^(I am a bot - please contact [my creator](https://reddit.com/message/compose?to=/r/TheRepBot) with any questions)`,
            )
    ) {
        result = result.trim() + footer;
    }

    return result;
}
