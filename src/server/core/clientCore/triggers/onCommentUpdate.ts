import { redis } from "@devvit/web/server";
import { OnCommentUpdateRequest, TriggerResponse } from "@devvit/web/shared";
import { Context } from "hono";
import { handleClientCommentUpdate } from "./handlePostOrComment";

export const onCommentUpdate = async (c: Context): Promise<Response> => {
    const event = await c.req.json<OnCommentUpdateRequest>();

    if (!event.comment?.id) {
        return c.json<TriggerResponse>(
            { message: "CommentCreateOrUpdate event missing comment ID" },
            400
        );
    }
    const commentEventKey = `CommentEvent:${event.comment.id}`;

    if (await redis.exists(commentEventKey)) {
        return c.json<TriggerResponse>(
            { message: "CommentCreate event already handled" },
            200
        );
    }

    await redis.set(commentEventKey, "1");

    await handleClientCommentUpdate(event);

    return c.json<TriggerResponse>(
        { message: "CommentUpdate event handled successfully" },
        200
    );
};
