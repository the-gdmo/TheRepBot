import { OnCommentCreateRequest, TriggerResponse } from "@devvit/web/shared";
import { Context } from "hono";
import { notifyOpOfLegendReply } from "./legend";
import { handleClientCommentCreate } from "./handlePostOrComment";

export const onCommentCreate = async (c: Context): Promise<Response> => {
    const event = await c.req.json<OnCommentCreateRequest>();

    if (!event.comment?.id) {
        return c.json<TriggerResponse>(
            { message: "CommentCreate event missing comment ID" },
            400
        );
    }

    await handleClientCommentCreate(event);
    await notifyOpOfLegendReply(event);

    return c.json<TriggerResponse>(
        { message: "CommentCreate event handled successfully" },
        200
    );
};
