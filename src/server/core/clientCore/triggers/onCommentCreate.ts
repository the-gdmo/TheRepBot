import { redis } from "@devvit/web/server";
import { OnCommentCreateRequest, TriggerResponse } from "@devvit/web/shared";
import { Context } from "hono";
import { handleClientCommentCreate } from "./handlePostOrComment";

export const onCommentCreate = async (c: Context): Promise<Response> => {
    const event = await c.req.json<OnCommentCreateRequest>();

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

    await handleClientCommentCreate(event);

    return c.json<TriggerResponse>(
        { message: "CommentCreate event handled successfully" },
        200
    );
};
