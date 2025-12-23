import { CommentSubmit, CommentUpdate } from "@devvit/protos";
import { Comment, TriggerContext } from "@devvit/public-api";
import {
    CommentTriggerContext,
    parentComment,
} from "./comment-trigger-context.js";
import {
    commentContainsModCommand,
    executeModCommand,
    modCommandExecutedByUserWithInsufficientPerms,
} from "./user-specific-logic/mod-user-action.js";
import { logger } from "../../logger.js";
import { commentContainsAltCommand } from "./user-specific-logic/alt-user-action.js";

export const handleOnCommentTrigger = async (
    event: CommentSubmit | CommentUpdate,
    devvitContext: TriggerContext
) => {
    // Create trigger context object
    const context = new CommentTriggerContext();
    await context.init(event, devvitContext);

    const comment = await parentComment(event, devvitContext);
    if (!event.comment) return;
    if (!comment) return;

    // Do this if true and continue to other actions
    const hasAltPermission = context.isAltUser;
    const hasPermission = context.isMod || context.isSuperUser;
    const userNotBlockedFromAwarding = context.userCanAward;
    if (await commentContainsAltCommand(event, devvitContext, comment.id)) {
        if (hasAltPermission) {
            await executeAltCommand(devvitContext, comment.id, awarder, recipient);
        } else {
            await altCommandExecutedByUserWithInsufficientPerms(
                devvitContext,
                comment.id
            );
        }
    } else if (await commentContainsModCommand(devvitContext, comment.id)) {
        if (hasPermission) {
            await executeModCommand(devvitContext, comment.id);
        } else {
            await modCommandExecutedByUserWithInsufficientPerms(
                devvitContext,
                comment.id
            );
        }
    } else if (
        await commentContainsUserCommand(
            devvitContext,
            comment.id,
            userNotBlockedFromAwarding
        )
    ) {
        if (userNotBlockedFromAwarding) {
            await executeUserCommand(devvitContext, comment.id);
        } else {
            await userCommandExecutedByBlockedUser(devvitContext, comment.id);
        }
    } else {
        logger.error("How did we get here?");
    }
};
