import { OnCommentCreateRequest, TriggerResponse } from "@devvit/web/shared";
import { Context } from "hono";
import { handleClientCommentCreate } from "./handlePostOrComment";
import { logger } from "../../utils/logger";

export const onCommentCreate = async (c: Context): Promise<Response> => {
    try {
        const event = await c.req.json<OnCommentCreateRequest>();

        if (!event.comment?.id) {
            return c.json<TriggerResponse>(
                { message: "CommentCreate event missing comment ID" },
                400
            );
        }

        await handleClientCommentCreate(event);

        return c.json<TriggerResponse>(
            { message: "CommentCreate event handled successfully" },
            200
        );
    } catch (error) {
        logger.error("CommentCreate event failed", { error });

        return c.json<TriggerResponse>(
            { message: "CommentCreate event failed" },
            500
        );
    }
};
