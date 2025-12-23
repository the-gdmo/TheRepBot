import { TriggerContext } from "@devvit/public-api";
import { modCommandValue, triggerUsed } from "../../../utils/common-utilities.js";

export async function commentContainsModCommand (
    devvitContext: TriggerContext,
    comment: string,
): Promise<boolean> {
    const usedCommand = await triggerUsed(devvitContext, comment);
    const modCommand = await modCommandValue(devvitContext);
    if (usedCommand === modCommand) {
        return true;
    }
    return false;
};

/*
if (hasPermission) {
            await executeModCommand(context);
        } else {
            await modCommandExecutedByUserWithInsufficientPerms(
                devvitContext,
                parentComment.id
            );
        }
*/
export async function executeModCommand(devvitContext: TriggerContext, commentId: string) {

}

export async function modCommandExecutedByUserWithInsufficientPerms(devvitContext: TriggerContext, commentId: string) {

}