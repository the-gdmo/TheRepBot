import { TriggerContext } from "@devvit/public-api";
import {
    triggerUsed,
    userCommandValues,
} from "../../../utils/common-utilities.js";

export async function commentContainsUserCommand(
    devvitContext: TriggerContext,
    commentBody: string
): Promise<boolean> {
    const userCommands = await userCommandValues(devvitContext);
    const body = commentBody.toLowerCase();
    for (const command of userCommands) {
        if (new RegExp(`${command}`, "i").test(body)) {
            return true;
        }
    }
    return false;
}

/*
if (hasPermission) {
            await executeModCommand(context);
        } else {
            await modCommandExecutedByUserWithInsufficientPerms(
                devvitContext,
                parentcomment.parentId
            );
        }
*/

async function pointAlreadyAwardedWithNormalCommand() {}
async function notifyUserOnSuperUserNormalCommand() {}
async function awardPointToUserNormalCommand() {}
//todo: add awarder and recipient logic directly into function
export async function executeUserCommand(
    devvitContext: TriggerContext,
    commentId: string
) {}

export async function userCommandExecutedByBlockedUser(
    devvitContext: TriggerContext,
    commentId: string
) {}
