import { CommentSubmit, CommentUpdate } from "@devvit/protos";
import { Comment, TriggerContext } from "@devvit/public-api";
import { CommentTriggerContext } from "./comment-trigger-context.js";
import { commentContainsModCommand } from "../mod-user-action.js";
import { logger } from "../../logger.js";

export const handleOnCommentTrigger = async (
    event: CommentSubmit | CommentUpdate,
    devvitContext: TriggerContext
) => {
    // Create trigger context object
    const context = new CommentTriggerContext();
    await context.init(event, devvitContext);

    if (!event.comment) return;
    let parentComment: Comment | undefined;
    try {
        parentComment = await devvitContext.reddit.getCommentById(
            event.comment.parentId
        );
    } catch {
        parentComment = undefined;
    }
    if (!parentComment) {
        logger.warn("❌ Parent comment not found.");
        return;
    }

    // Do this if true and continue to other actions
    const hasAltPermission = context.isAltUser;
    const hasPermission = context.isMod || context.isSuperUser;
    const userNotBlockedFromAwarding = context.userCanAward;
    if (await commentContainsModCommand(devvitContext, parentComment.id)) {
        if (hasPermission) {
            await executeModCommand(context);
        } else {
            await modCommandExecutedByUserWithInsufficientPerms(
                devvitContext,
                parentComment.id
            );
        }
    } else if (
        await commentContainsAltCommand(
            devvitContext,
            parentComment.id,
            hasPermission
        )
    ) {
        if (hasAltPermission) {
            await executeAltCommand(devvitContext, parentComment.id);
        } else {
            await altCommandExecutedByUserWithInsufficientPerms();
        }
    } else if (
        await commentContainsUserCommand(
            devvitContext,
            parentComment.id,
            userNotBlockedFromAwarding
        )
    ) {
        if (userNotBlockedFromAwarding) {
            await executeUserCommand(devvitContext, parentComment.id);
        } else {
            await userCommandExecutedByBlockedUser();
        }
    } else {
        logger.error("How did we get here?");
    }
};
