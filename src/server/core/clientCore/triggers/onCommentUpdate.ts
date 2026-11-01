import { OnCommentUpdateRequest, TriggerResponse } from "@devvit/web/shared";
import { Context } from "hono";
import { handleClientCommentUpdate } from "./handlePostOrComment";
import { logger } from "../../utils/logger";

export const onCommentUpdate = async (c: Context): Promise<Response> => {
    try {
        const event = await c.req.json<OnCommentUpdateRequest>();

        if (!event.comment?.id) {
            return c.json<TriggerResponse>(
                { message: "CommentUpdate event missing comment ID" },
                400
            );
        }

        await handleClientCommentUpdate(event);

        return c.json<TriggerResponse>(
            { message: "CommentUpdate event handled successfully" },
            200
        );
    } catch (error) {
        logger.error("CommentUpdate event failed", { error });

        return c.json<TriggerResponse>(
            { message: "CommentUpdate event failed" },
            500
        );
    }
};
