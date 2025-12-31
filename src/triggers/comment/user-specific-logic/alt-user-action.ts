import { CommentSubmit, CommentUpdate } from "@devvit/protos";
import { TriggerContext } from "@devvit/public-api";
import {
    escapeForRegex,
    formatMessage,
    modCommandValue,
    triggerUsed,
    userCommandValues,
} from "../../../utils/common-utilities.js";
import { CommentTriggerContext } from "../comment-trigger-context.js";
import { logger } from "../../../logger.js";
import { AppSetting, TemplateDefaults } from "../../../settings.js";

export async function commentContainsAltCommand(
    event: CommentSubmit | CommentUpdate,
    devvitContext: TriggerContext,
    commentId: string
): Promise<boolean> {
    if (!event.comment) return false;

    const commentBodyRaw = event.comment.body ?? "";
    const commentBody = commentBodyRaw.toLowerCase();

    logger.info(`Comment registered in commentContainsAltCommand()`, {
        commentId,
    });
    const triggerUsedInCommand = await triggerUsed(devvitContext, commentId);
    if (!triggerUsedInCommand) {
        logger.info(`❌ No valid award command found.`);
        return false;
    }

    const altCommandMatch = commentBody.match(
        new RegExp(`${triggerUsed}\\s+(\\S+)`, "i")
    );

    logger.info(`altCommandMatch:`, {
        altCommandMatch,
    });

    if (altCommandMatch) {
        return true;
    } else {
        return false;
    }
}

//TODO: IMPLEMENT POINT ALREADY AWARDED TO USER WITH ALT COMMAND ON POST LOGIC, NOTIFY IF USER BECOMES SUPERUSER FROM ALT COMMAND LOGIC
async function pointAlreadyAwardedWithAltCommand() {}
async function notifyUserOnSuperUserAltCommand() {}
async function awardPointToUserAltCommand() {}
async function invalidAltUsername(
    event: CommentSubmit | CommentUpdate,
    devvitContext: TriggerContext,
    commentId: string,
    awarder: string
) {
    if (!event.comment) return false;

    const settings = await devvitContext.settings.getAll();
    const commentBodyRaw = event.comment.body;
    const commentBody = commentBodyRaw.toLowerCase();
    const usedTrigger = await triggerUsed(devvitContext, commentId);
    const userCommands = await userCommandValues(devvitContext);
    const modCommand = await modCommandValue(devvitContext);

    let mentionedUsername: string | undefined;
    if (!usedTrigger) return;
    if (!event.comment) return;

    // Regex: match valid ALT username with space + u/
    const validMatch = commentBody.match(
        new RegExp(
            `${escapeForRegex(usedTrigger)}\\s+u/([a-z0-9_-]{3,21})`,
            "i"
        )
    );

    logger.debug(`🧩 TriggerUsed/validMatch:`, { triggerUsed, validMatch });

    if (validMatch) {
        mentionedUsername = validMatch[1];
        const mentionUsername = mentionedUsername.slice(2);

        // Validate allowed characters (letters, numbers, hyphen, underscore)
        if (!/^[a-z0-9_-]+$/i.test(mentionUsername)) {
            const invalidCharMessage = formatMessage(
                (settings[AppSetting.InvalidUsernameMessage] as string) ??
                    TemplateDefaults.InvalidUsernameMessage,
                { awarder, awardee: mentionUsername }
            );

            const reply = await devvitContext.reddit.submitComment({
                id: event.comment.id,
                text: invalidCharMessage,
            });
            await reply.distinguish();

            logger.warn("❌ ALT command username contains invalid characters", {
                awarder,
                triggerUsed,
                mentionUsername,
                mentionedUsername,
            });
            return; // Stop ALT flow
        }
    } else {
        // User typed a word after trigger but missing u/ prefix
        const fallbackMatch = commentBody.match(
            new RegExp(`${usedTrigger}\\s+(\\S+)`, "i")
        );

        if (fallbackMatch) {
            const invalidMention = fallbackMatch[1];
            const invalidMentionUsername = invalidMention.slice(2);

            // Validate allowed characters
            if (!/^[a-z0-9_-]+$/i.test(invalidMentionUsername)) {
                const invalidCharMessage = formatMessage(
                    (settings[AppSetting.InvalidUsernameMessage] as string) ??
                        TemplateDefaults.InvalidUsernameMessage,
                    { awarder, awardee: invalidMention }
                );

                const reply = await devvitContext.reddit.submitComment({
                    id: event.comment.id,
                    text: invalidCharMessage,
                });
                await reply.distinguish();

                logger.warn(
                    "❌ ALT command username contains invalid characters",
                    {
                        awarder,
                        triggerUsed,
                        invalidMention,
                        invalidMentionUsername,
                    }
                );
            }
        }
    }
}

async function altUsernameLengthInvalid(
    event: CommentSubmit | CommentUpdate,
    devvitContext: TriggerContext,
    commentId: string,
    awarder: string
) {
    const usedTrigger = await triggerUsed(devvitContext, commentId);
    const userCommands = await userCommandValues(devvitContext);
    const modCommand = await modCommandValue(devvitContext);

    let mentionedUsername: string | undefined;
    if (!usedTrigger) return;
    if (!event.comment) return;

    const commentBodyRaw = event.comment.body ?? "";
    const commentBody = commentBodyRaw.toLowerCase();

    const settings = await devvitContext.settings.getAll();
    // Only run ALT flow if user is an ALT user
    if (
        userCommands.includes(usedTrigger) ||
        modCommand.includes(usedTrigger)
    ) {
        // Regex: match valid ALT username with space + u/
        const validMatch = commentBody.match(
            new RegExp(
                `${escapeForRegex(usedTrigger)}\s+u\/([a-z0-9_-]{3,21})`,
                "i"
            )
        );

        logger.debug(`🧩 usedTrigger/validMatch:`, { usedTrigger, validMatch });

        if (validMatch) {
            mentionedUsername = validMatch[1];
            const mentionUsername = mentionedUsername.slice(2);

            // Validate username length explicitly (3–21 chars)
            if (mentionUsername.length < 3 || mentionUsername.length > 21) {
                const lengthMessage = formatMessage(
                    (settings[AppSetting.UsernameLengthMessage] as string) ??
                        TemplateDefaults.UsernameLengthMessage,
                    { awarder, awardee: mentionUsername }
                );

                const reply = await devvitContext.reddit.submitComment({
                    id: event.comment.parentId,
                    text: lengthMessage,
                });
                await reply.distinguish();

                logger.warn("❌ ALT username length invalid", {
                    awarder,
                    mentionUsername,
                    mentionedUsername,
                });
                return;
            }
        }
    }
}

/*
if (hasAltPermission) {
    await executeAltCommand(devvitContext, comment.parentId, awarder, recipient);
    } else {
    await altCommandExecutedByUserWithInsufficientPerms(
        devvitContext,
        comment.parentId
    );
}
*/

//todo: add awarder and recipient logic directly into function
export async function executeAltCommand(
    devvitContext: TriggerContext,
    commentId: string
) {}

export async function altCommandExecutedByUserWithInsufficientPerms(
    devvitContext: TriggerContext,
    commentId: string
) {}
