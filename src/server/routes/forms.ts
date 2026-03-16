import { Hono } from "hono";
import type { UiResponse } from "@devvit/web/shared";
import { context, reddit, redis } from "@devvit/web/server";

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

forms.post("/create-post", async (c) => {
    const values = await c.req.json<CreatePostFormValues>();
    const redisKey = "customPostData";

    let postTitle = values.postTitle as string | undefined;
    postTitle ??= "TheRepBot High Scores";

    const subredditName =
        context.subredditName ?? (await reddit.getCurrentSubreddit())?.name;

    const post = await reddit.submitCustomPost({
        subredditName,
        title: postTitle,
    });

    const newData: CustomPostData = {
        postId: post.id,
        numberOfUsers: (values.numberOfUsers as number | undefined) ?? 20,
    };

    if (newData.numberOfUsers > 1000000000000000) {
        return c.json<UiResponse>(
            {
                showToast: {
                    text: "User count is too high.",
                    appearance: "neutral",
                },
            },
            400,
        );
    }

    if (values.removeExisting) {
        const customPostData = await redis.get(redisKey);
        if (customPostData) {
            const data = JSON.parse(customPostData) as CustomPostData;
            const post = await reddit.getPostById(data.postId);
            await post.remove();
        }
        console.log("🗑️ Removed existing leaderboard post");
    }

    await redis.set(redisKey, JSON.stringify(newData));

    if (values.stickyPost) {
        await post.sticky();
    }

    return c.json<UiResponse>(
        {
            showToast: {
                text: "Leaderboard post has been created successfully",
                appearance: "success",
            },
            navigateTo: `https://reddit.com/r/${context.subredditName}/comments/${post.id}`,
        },
        200,
    );
});
