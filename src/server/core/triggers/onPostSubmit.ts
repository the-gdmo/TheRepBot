import { redis } from "@devvit/web/server";
import { OnPostCreateRequest, TriggerResponse } from "@devvit/web/shared";
import { Context } from "hono";
import { handleClientPostCreate } from "../clientCore/handlePostOrComment";

export const onPostCreate = async (c: Context): Promise<Response> => {
    const event = await c.req.json<OnPostCreateRequest>();

    if (!event.post?.id) {
        console.error(
            "PostCreate event missing post information",
            JSON.stringify(event)
        );
        return c.json<TriggerResponse>(
            { message: "PostCreate event missing post information" },
            400
        );
    }

    const postCreateKey = `PostCreate:${event.post.id}`;

    if (await redis.exists(postCreateKey)) {
        console.log(
            `PostCreate event for post ${event.post.id} has already been handled, skipping.`
        );
        return c.json<TriggerResponse>(
            { message: "PostCreate event already handled" },
            200
        );
    }

    await redis.set(postCreateKey, "1");

    await handleClientPostCreate(event);

    return c.json<TriggerResponse>(
        { message: "PostCreate event handled successfully" },
        200
    );
};
