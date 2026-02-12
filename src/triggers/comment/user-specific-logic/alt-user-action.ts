import { CommentCreate, CommentSubmit, CommentUpdate } from "@devvit/protos";
import { SettingsValues, TriggerContext } from "@devvit/public-api";

import {
    escapeForRegex,
    formatMessage,
    getTriggers,
    modCommandValue,
    updateAwardeeFlair,
    userCommandValues,
} from "../../utils/common-utilities.js";

import { getAltDupKey, setAltDupKey } from "../../post-logic/redisKeys.js";

import { logger } from "../../../logger.js";
import {
    AppSetting,
    AutoSuperuserReplyOptions,
    ExistingFlairOverwriteHandling,
    NotifyOnAlternateCommandFailReplyOptions,
    TemplateDefaults,
} from "../../../settings.js";
import { getParentComment } from "../comment-trigger-context.js";
import { handleAutoSuperuserPromotion } from "../../utils/user-utilities.js";

/* ─────────────────────────────────────────────────────────────
 * Public entry
 * ───────────────────────────────────────────────────────────── */

export async function handleAltUserAction(
    event: CommentCreate | CommentUpdate,
    context: TriggerContext
): Promise<boolean> {
    if (!event.comment || !event.post) return false;

    const commentBody = event.comment.body?.toLowerCase() ?? "";
    const awarder = event.author?.name;
    if (!awarder) return false;

    const triggerUsed = await detectAltTrigger(context, commentBody);
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
        triggerUsed
    );
    return true;
}

/* ─────────────────────────────────────────────────────────────
 * Detection
 * ───────────────────────────────────────────────────────────── */
export async function commentContainsAltCommand(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext
): Promise<boolean | undefined> {
    if (!event.comment) return false;

    try {
        const body = event.comment.body ?? "";

        // Fetch commands
        const triggers = await getTriggers(context); // e.g., "!mod"
        for (const trigger of triggers) {
            const regex = new RegExp(`${trigger}\su\/([a-z0-9_-]+)`, "i");
            if (regex.test(body)) {
                logger.debug("🧩 Alt command check", {
                    body,
                    containsCommand: regex.test(body),
                });
                return true;
            }
            logger.info(`Comment doesn't contain alt command`);
            return false;
        }
    } catch (err) {
        logger.error(`How did we get here?`, {}, context);
        return;
    }
    return;
}

async function detectAltTrigger(
    context: TriggerContext,
    commentBody: string
): Promise<string | null> {
    const triggers = await getTriggers(context);
    let altTrigger: string | null;
    for (const trigger of triggers) {
        const regex = new RegExp(`${trigger}\su\/([a-z0-9_-]{3,21})`, "i");
        if (regex.test(commentBody)) {
            logger.info(`Trigger used`, { trigger });
            return trigger;
        }
    }
    logger.error(`No trigger found`);
    return null;
}

function extractAltUsername(body: string, trigger: string): string | null {
    const match = body.match(
        new RegExp(`${escapeForRegex(trigger)}\su/([a-z0-9_-]{3,21})`, "i")
    );
    logger.info(`Extracted username`, {
        match: match?.[1] ?? null,
    });
    return match?.[1] ?? null;
}

/* ─────────────────────────────────────────────────────────────
 * Validation
 * ───────────────────────────────────────────────────────────── */

async function validateAltUsername(
    event: CommentCreate | CommentUpdate,
    context: TriggerContext,
    awarder: string,
    username: string
): Promise<boolean> {
    const settings = await context.settings.getAll();

    if (!/^[a-z0-9_-]+$/i.test(username)) {
        await reply(
            context,
            event.comment!.id,
            formatMessage(
                (settings[AppSetting.InvalidUsernameMessage] as string) ??
                    TemplateDefaults.InvalidUsernameMessage,
                { awarder, awardee: username }
            )
        );
        return true;
    }

    if (username.length < 3 || username.length > 21) {
        await reply(
            context,
            event.comment!.id,
            formatMessage(
                (settings[AppSetting.UsernameLengthMessage] as string) ??
                    TemplateDefaults.UsernameLengthMessage,
                { awarder, awardee: username }
            )
        );
        return true;
    }

    return false;
}

/* ─────────────────────────────────────────────────────────────
 * Authorization
 * ───────────────────────────────────────────────────────────── */

async function isAuthorizedAltUser(
    context: TriggerContext,
    awarder: string
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
    context: TriggerContext
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
    triggerUsed: string
) {
    if (!event.subreddit) return;
    const settings = await context.settings.getAll();

    // Award point
    const newScore = await context.redis.zIncrBy(
        "thanksPointsStore",
        awardee,
        1
    );

    await setAltDupKey(event, context, "1");

    // Update flair
    await updateAwardeeFlair(
        context,
        event.subreddit.name,
        awardee,
        newScore,
        settings
    );

    // Auto-superuser promotion
    await handleAutoSuperuserPromotion(event, context, newScore, triggerUsed);

    // ALT success notification
    await notifyAlternateCommandSuccess(
        event,
        context,
        awarder,
        awardee,
        newScore
    );

    logger.info("🏅 ALT award fully processed", {
        awarder,
        awardee,
        newScore,
    });
}
/* ─────────────────────────────────────────────────────────────
 * Notifications
 * ───────────────────────────────────────────────────────────── */

async function notifyAltDuplicate(
    event: CommentCreate | CommentUpdate,
    context: TriggerContext,
    awarder: string,
    awardee: string
) {
    const settings = await context.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const message = formatMessage(
        (settings[AppSetting.PointAlreadyAwardedToUserMessage] as string) ??
            TemplateDefaults.PointAlreadyAwardedToUserMessage,
        { awardee, name: pointName, awarder }
    );

    await reply(context, event.comment!.id, message);
}

async function notifyAlternateCommandSuccess(
    event: CommentCreate | CommentUpdate,
    context: TriggerContext,
    awarder: string,
    awardee: string,
    newScore: number
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
        }
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
    command: string
) {
    if (!event.subreddit || !event.comment) return;
    const settings = await context.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";

    const notifyMode = (
        settings[AppSetting.NotifyOnAlternateCommandFail] as string[]
    )?.[0];

    const failTemplate = formatMessage(
        (settings[AppSetting.AlternateCommandFailMessage] as string) ??
            TemplateDefaults.AlternateCommandFailMessage,
        {
            altCommand: command,
            subreddit: event.subreddit.name,
            name: pointName,
        }
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
    awarder: string
) {
    const settings = await context.settings.getAll();

    await reply(
        context,
        event.comment!.id,
        formatMessage(
            (settings[AppSetting.NoUsernameMentionMessage] as string) ??
                TemplateDefaults.NoUsernameMentionMessage,
            { awarder, awardee: "" }
        )
    );
}

/* ─────────────────────────────────────────────────────────────
 * Utility
 * ───────────────────────────────────────────────────────────── */

async function reply(context: TriggerContext, commentId: string, text: string) {
    const reply = await context.reddit.submitComment({ id: commentId, text });
    await reply.distinguish();
}
