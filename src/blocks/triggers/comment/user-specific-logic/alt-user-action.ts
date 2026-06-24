import { CommentCreate, CommentSubmit, CommentUpdate } from "@devvit/protos";
import { TriggerContext, User } from "@devvit/public-api";

import {
    formatMessage,
    getTriggers,
    updateAwardeeFlair,
} from "../../utils/common-utilities";

import {
    flairToggleKeyExists,
    getAltDupKey,
    setAltDupKey,
} from "../../utils/redisKeys";

import { logger } from "../../../logger";
import {
    AppSetting,
    NotifyOnAlternateCommandFailReplyOptions,
    TemplateDefaults,
} from "../../../settings";
import { handleAutoSuperuserPromotion } from "../../utils/user-utilities";

/* ─────────────────────────────────────────────────────────────
 * Public entry
 * ───────────────────────────────────────────────────────────── */

export async function handleAltUserAction(
    event: CommentCreate | CommentUpdate,
    context: TriggerContext,
): Promise<boolean> {
    if (!event.comment || !event.post) return false;

    const commentBody = event.comment.body?.toLowerCase() ?? "";
    const awarder = event.author?.name;
    if (!awarder) return false;

    const triggers = await getTriggers(context);
    const triggerUsed = triggers.find((t) => commentBody.includes(t));
    if (!triggerUsed) return false;

    const mentionedUsername = extractAltUsername(commentBody, triggerUsed);
    if (!mentionedUsername) {
        await notifyMissingAltUsername(event, context, awarder);
        return true;
    }

    if (await validateAltUsername(event, context, awarder, mentionedUsername)) {
        return true;
    }

    if (!(await isAuthorizedAltUser(context, awarder))) {
        await notifyAltPermissionFailure(event, context, awarder, triggerUsed);
        return true;
    }

    if (await altDuplicateExists(event, context)) {
        await notifyAltDuplicate(event, context, awarder, mentionedUsername);
        return true;
    }

    await executeAltAward(
        event,
        context,
        awarder,
        mentionedUsername,
        triggerUsed,
    );
    return true;
}

/* ─────────────────────────────────────────────────────────────
 * Detection
 * ───────────────────────────────────────────────────────────── */
export async function commentContainsAltCommand(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
): Promise<boolean> {
    if (!event.comment || !event.subreddit) return false;

    let found = false;

    try {
        const body = event.comment.body ?? "";

        const triggers = await getTriggers(context);

        for (const trigger of triggers) {
            const regex = new RegExp(
                `${trigger}\\su\\/([a-z0-9_-]{3,21}).*`,
                "i",
            );

            const containsCommand = regex.test(body);

            logger.debug("🧩 Alt command check", {
                trigger,
                body,
                regex,
                containsCommand,
            });

            if (containsCommand) {
                logger.info("Comment contains alt command");
                found = true;
                break;
            }
        }

        if (!found) {
            logger.info("Comment does not contain alt command");
        }
    } catch (err) {
        const botCreator = "ryry50583583";

        const subjectRaw = `Alternate Command Error`;

        const messageRaw = `We encountered an error which is related to the alternate command in r/${event.subreddit.name}.
    
If you could take a look at it and provide any insights, that would be appreciated!

Error details:

${err instanceof Error ? err.stack || err.message : String(err)}`;

        const subject = encodeURIComponent(subjectRaw);
        const message = encodeURIComponent(messageRaw);

        const messageComposeLink = `https://www.reddit.com/message/compose?to=${botCreator}&subject=${subject}&message=${message}`;

        logger.error(
            `If you see this error, please [contact my developer](${messageComposeLink}).\n\n` +
                `Please send the message as-is unless you have any additional information to provide.`,
            {},
            context,
        );

        return false;
    }

    return found;
}

// async function detectAltTrigger(
//     context: TriggerContext,
//     commentBody: string,
// ): Promise<string | null> {
//     const triggers = await getTriggers(context);
//     for (const trigger of triggers) {
//         const regex = new RegExp(`${trigger}\su\/([a-z0-9_-]{3,21})`, "g");
//         if (regex.test(commentBody)) {
//             logger.info(`Trigger used`, { trigger });
//             return trigger;
//         }
//     }
//     logger.error(`No trigger found`);
//     return null;
// }

function extractAltUsername(body: string, trigger: string): string | null {
    const prefix = `${trigger} u/`;

    if (!body.startsWith(prefix)) {
        return null;
    }

    logger.info(`Extracting username from alt command`, {
        body,
        trigger,
        returnValue: body.slice(prefix.length).trim().split(/\s+/)[0] ?? null,
    });

    return body.slice(prefix.length).trim().split(/\s+/)[0] ?? null;
}

/* ─────────────────────────────────────────────────────────────
 * Validation
 * ───────────────────────────────────────────────────────────── */

async function validateAltUsername(
    event: CommentCreate | CommentUpdate,
    context: TriggerContext,
    awarder: string,
    trigger: string,
): Promise<boolean> {
    const settings = await context.settings.getAll();

    const body = event.comment?.body?.trim() ?? "";
    const prefix = `${trigger} u/`;

    if (!body.startsWith(prefix)) {
        return false;
    }

    const username = body.slice(prefix.length).trim();

    if (!/^[a-z0-9_-]+$/i.test(username)) {
        await reply(
            context,
            event.comment!.id,
            formatMessage(
                event,
                (settings[AppSetting.InvalidUsernameMessage] as string) ??
                    TemplateDefaults.InvalidUsernameMessage,
                {
                    awarder,
                    awardee: username,
                },
            ),
        );
        return false;
    }

    if (username.length < 3 || username.length > 21) {
        await reply(
            context,
            event.comment!.id,
            formatMessage(
                event,
                (settings[AppSetting.UsernameLengthMessage] as string) ??
                    TemplateDefaults.UsernameLengthMessage,
                {
                    awarder,
                    awardee: username,
                },
            ),
        );
        return false;
    }

    return true;
}

/* ─────────────────────────────────────────────────────────────
 * Authorization
 * ───────────────────────────────────────────────────────────── */

async function isAuthorizedAltUser(
    context: TriggerContext,
    awarder: string,
): Promise<boolean> {
    const settings = await context.settings.getAll();
    const altUsers =
        (settings[AppSetting.AlternatePointCommandUsers] as string)
            ?.split("\n")
            .map((u) => u.trim().toLowerCase()) ?? [];

    return altUsers.includes(awarder.toLowerCase());
}

/* ─────────────────────────────────────────────────────────────
 * Duplicate handling
 * ───────────────────────────────────────────────────────────── */

async function altDuplicateExists(
    event: CommentCreate | CommentUpdate,
    context: TriggerContext,
): Promise<boolean> {
    const key = await getAltDupKey(event, context);
    if (!key) return false;
    return (await context.redis.exists(key)) === 1;
}

/* ─────────────────────────────────────────────────────────────
 * Execution
 * ───────────────────────────────────────────────────────────── */
async function executeAltAward(
    event: CommentCreate | CommentUpdate,
    context: TriggerContext,
    awarder: string,
    awardee: string,
    triggerUsed: string,
) {
    if (!event.subreddit) return;
    const settings = await context.settings.getAll();

    // Award point
    const newScore = await context.redis.zIncrBy(
        "thanksPointsStore",
        awardee,
        1,
    );

    await setAltDupKey(event, context, "1");

    // Auto-superuser promotion
    await handleAutoSuperuserPromotion(event, context, newScore, triggerUsed);

    // ALT success notification
    await notifyAlternateCommandSuccess(
        event,
        context,
        awarder,
        awardee,
        newScore,
    );

    logger.info("🏅 ALT award fully processed", {
        awarder,
        awardee,
        newScore,
    });

    let user: User | undefined;
    try {
        user = await context.reddit.getUserByUsername(awardee);
    } catch {}

    if (!user) {
        logger.error("Failed to fetch user for flair update after ALT award");
        return;
    }

    const flairHandlingDisabled = await flairToggleKeyExists(context, user);

    if (flairHandlingDisabled) {
        logger.info(
            "Flair handling is disabled for this user, skipping flair update",
        );
        return;
    }

    // Update flair
    await updateAwardeeFlair(
        context,
        event.subreddit.name,
        awardee,
        newScore,
        settings,
    );
}
/* ─────────────────────────────────────────────────────────────
 * Notifications
 * ───────────────────────────────────────────────────────────── */

async function notifyAltDuplicate(
    event: CommentCreate | CommentUpdate,
    context: TriggerContext,
    awarder: string,
    awardee: string,
) {
    const settings = await context.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const message = formatMessage(
        event,
        (settings[AppSetting.PointAlreadyAwardedToUserMessage] as string) ??
            TemplateDefaults.PointAlreadyAwardedToUserMessage,
        { awardee, name: pointName, awarder },
    );

    await reply(context, event.comment!.id, message);
}

async function notifyAlternateCommandSuccess(
    event: CommentCreate | CommentUpdate,
    context: TriggerContext,
    awarder: string,
    awardee: string,
    newScore: number,
) {
    if (!event.subreddit) return;
    const settings = await context.settings.getAll();

    const notifyMode = (
        settings[AppSetting.NotifyOnAlternateCommandSuccess] as string[]
    )?.[0];

    if (!notifyMode || notifyMode === "none") return;

    const awardeePage = `https://old.reddit.com/r/${event.subreddit.name}/wiki/user/${awardee}`;
    const awarderPage = `https://old.reddit.com/r/${event.subreddit.name}/wiki/user/${awarder}`;

    const leaderboard = `https://old.reddit.com/r/${
        event.subreddit.name
    }/wiki/${settings[AppSetting.LeaderboardName] ?? "leaderboard"}`;
    const message = formatMessage(
        event,
        (settings[AppSetting.AlternateCommandSuccessMessage] as string) ??
            TemplateDefaults.AlternateCommandSuccessMessage,
        {
            awarder,
            awardee,
            name: awarder,
            total: newScore.toString(),
            symbol: (settings[AppSetting.PointSymbol] as string) ?? "",
            leaderboard,
            awardeePage,
            awarderPage,
        },
    );

    if (notifyMode === "replybypm") {
        await context.reddit.sendPrivateMessage({
            to: awarder,
            subject: "Alternate command successful",
            text: message,
        });
    } else {
        const alternateCommandSuccessMessage =
            await context.reddit.submitComment({
                id: event.comment!.id,
                text: message,
            });
        await alternateCommandSuccessMessage.distinguish();
    }
}

async function notifyAltPermissionFailure(
    event: CommentCreate | CommentUpdate,
    context: TriggerContext,
    awarder: string,
    command: string,
) {
    if (!event.subreddit || !event.comment) return;
    const settings = await context.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";

    const notifyMode = (
        settings[AppSetting.NotifyOnAlternateCommandFail] as string[]
    )?.[0];

    const failTemplate = formatMessage(
        event,
        (settings[AppSetting.AlternateCommandFailMessage] as string) ??
            TemplateDefaults.AlternateCommandFailMessage,
        {
            altCommand: command,
            subreddit: event.subreddit.name,
            name: pointName,
        },
    );

    if (
        notifyMode === NotifyOnAlternateCommandFailReplyOptions.ReplyAsComment
    ) {
        const failMessage = await context.reddit.submitComment({
            id: event.comment.id,
            text: failTemplate,
        });
        await failMessage.distinguish();
    } else if (
        notifyMode === NotifyOnAlternateCommandFailReplyOptions.ReplyByPM
    ) {
        await context.reddit.sendPrivateMessage({
            to: awarder,
            subject: `You do not have permission to award ${pointName}s in r/${event.subreddit.name}`,
            text: failTemplate,
        });
    }
}

async function notifyMissingAltUsername(
    event: CommentCreate | CommentUpdate,
    context: TriggerContext,
    awarder: string,
) {
    const settings = await context.settings.getAll();

    await reply(
        context,
        event.comment!.id,
        formatMessage(
            event,
            (settings[AppSetting.NoUsernameMentionMessage] as string) ??
                TemplateDefaults.NoUsernameMentionMessage,
            { awarder, awardee: "" },
        ),
    );
}

/* ─────────────────────────────────────────────────────────────
 * Utility
 * ───────────────────────────────────────────────────────────── */

async function reply(context: TriggerContext, commentId: string, text: string) {
    const reply = await context.reddit.submitComment({ id: commentId, text });
    await reply.distinguish();
}
