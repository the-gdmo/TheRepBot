import { CommentSubmit, CommentUpdate } from "@devvit/protos";
import { Comment, TriggerContext } from "@devvit/public-api";
import {
    CommentTriggerContext,
    getParentComment,
} from "./comment-trigger-context.js";
import {
    commentContainsModCommand,
    executeModCommand,
    modCommandExecutedByUserWithInsufficientPerms,
} from "./user-specific-logic/mod-user-action.js";
import { logger } from "../../logger.js";
import {
    altCommandExecutedByUserWithInsufficientPerms,
    commentContainsAltCommand,
    executeAltCommand,
} from "./user-specific-logic/alt-user-action.js";
import {
    commentContainsUserCommand,
    executeUserCommand,
    userCommandExecutedByBlockedUser,
} from "./user-specific-logic/normal-user-action.js";

export async function handleOnCommentTrigger(
    event: CommentSubmit | CommentUpdate,
    devvitContext: TriggerContext
) {
    // Create trigger context object
    const context = new CommentTriggerContext();
    await context.init(event, devvitContext);

    const comment = await getParentComment(event, devvitContext);
    if (!event.comment) return;
    if (!comment) return;

    const hasAltPermission = context.isAltUser;
    const hasPermission = context.isMod || context.isSuperUser;
    const userCanAward = context.userCanAward;
    //AltCommand logic
    if (await commentContainsModCommand(devvitContext, comment.parentId)) {
        if (hasPermission) {
            await executeModCommand(devvitContext, comment.parentId);
        } else {
            await modCommandExecutedByUserWithInsufficientPerms(
                devvitContext,
                comment.parentId
            );
        }
    } else if (
        await commentContainsUserCommand(devvitContext, event.comment.body)
    ) {
        if (userCanAward) {
            await executeUserCommand(devvitContext, comment.parentId);
        } else {
            await userCommandExecutedByBlockedUser(
                devvitContext,
                comment.parentId
            );
        }
    } else if (
        await commentContainsAltCommand(event, devvitContext, comment.parentId)
    ) {
        if (hasAltPermission) {
            await executeAltCommand(devvitContext, comment.parentId);
        } else {
            await altCommandExecutedByUserWithInsufficientPerms(
                devvitContext,
                comment.parentId
            );
        }
    } else {
        logger.error("How did we get here?", {}, devvitContext);
    }
}
