import { CommentSubmit, CommentUpdate } from "@devvit/protos";
import { TriggerContext, Comment, SettingsValues } from "@devvit/public-api";
import {
    CommentTriggerContext,
    getParentComment,
} from "./comment-trigger-context.js";
import { logger } from "../../logger.js";
import {
    commentContainsUserCommand,
    executeUserCommand,
} from "./user-specific-logic/normal-user-action.js";
import {
    commentContainsModCommand,
    executeModCommand,
} from "./user-specific-logic/mod-user-action.js";
import {
    commentContainsAltCommand,
    handleAltUserAction,
} from "./user-specific-logic/alt-user-action.js";
import {
    AppSetting,
    NotifyOnDisallowedFlairReplyOptions,
    NotifyOnModAwardFailReplyOptions,
    NotifyOnSelfAwardReplyOptions,
    NotifyOnUnflairedPostReplyOptions,
    TemplateDefaults,
} from "../../settings.js";
import {
    formatMessage,
    getIgnoredContextType,
    getTriggers,
    modCommandValue,
} from "../utils/common-utilities.js";

export async function handleThanksEvent(
    event: CommentSubmit | CommentUpdate,
    devvitContext: TriggerContext
) {
    if (!event.post || !event.author || !event.comment) {
        logger.warn("❌ Missing required event data", { event });
        return;
    }

    // ─────────────────────────────────────────────
    // Initialize context
    // ─────────────────────────────────────────────
    const commentTriggerContext = new CommentTriggerContext();
    await commentTriggerContext.init(event, devvitContext);

    const parentComment: Comment | undefined = await getParentComment(
        event,
        devvitContext
    );
    if (!parentComment) {
        logger.warn("❌ Parent comment not found", {
            commentId: event.comment.id,
        });
        return;
    }

    const settings = await devvitContext.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const awarder = event.author.name;
    const commentBody = event.comment.body.toLowerCase();
    const triggers = await getTriggers(devvitContext);
    const triggerUsed = triggers.find((t) =>
        commentBody.includes(t.toLowerCase())
    );

    if (!triggerUsed) {
        logger.debug("❌ No valid award command found.");
        return;
    }

    const ignoredType = getIgnoredContextType(event.comment.body, triggerUsed);

    const IgnoredContextNeedsHandling = await ignoredContextNeedsHandling(
        event,
        devvitContext,
        triggerUsed
    );
    if (ignoredType) {
        logger.info(`ignoredType exists in comment`, { ignoredType });
        if (IgnoredContextNeedsHandling) {
            logger.info(`Running handleIgnoredContext()`, {
                IgnoredContextNeedsHandling,
            });
            await handleIgnoredContext(event, devvitContext, triggerUsed);
            return;
        } else {
            logger.info(`Ignored context doesn't need handling`);
            return;
        }
    }

    await unflairedPostLogic(event, devvitContext, awarder, settings);

    await flairTextNotAllowedLogic(
        event,
        devvitContext,
        awarder,
        commentBody,
        triggerUsed,
        settings
    );

    const recipient = parentComment.authorName;
    if (!recipient) {
        logger.warn("❌ No recipient found", { parentComment });
        return;
    }

    const isMod = commentTriggerContext.isMod;
    const isSuperUser = commentTriggerContext.isSuperUser;
    const isAltUser = commentTriggerContext.isAltUser;
    const userCanAward = commentTriggerContext.userCanAward;

    // ─────────────────────────────────────────────
    // Prevent system/bot self-awards
    // ─────────────────────────────────────────────
    await awarderIsBot(event, devvitContext, awarder, settings);

    // ─────────────────────────────────────────────
    // Access control enforcement
    // ─────────────────────────────────────────────
    await checkPermissionOfUser(
        event,
        awarder,
        commentTriggerContext,
        devvitContext,
        settings
    );

    // ─────────────────────────────────────────────
    // Detect which command type exists
    // ─────────────────────────────────────────────
    const containsMod = await commentContainsModCommand(event, devvitContext);
    const containsUser = await commentContainsUserCommand(event, devvitContext);
    const containsAlt = await commentContainsAltCommand(event, devvitContext);

    await selfAwardAttemptLogic(
        event,
        devvitContext,
        awarder,
        recipient,
        settings
    );

    await recipientIsBot(event, devvitContext, awarder, recipient, settings);

    // ─────────────────────────────────────────────
    // Normal user command logic
    // ─────────────────────────────────────────────
    if (containsUser && !containsMod && !containsAlt) {
        if (userCanAward) {
            await executeUserCommand(event, devvitContext);
        } else {
            // Blocked user already handled inside executeUserCommand
            logger.debug("❌ User blocked from awarding points", { awarder });
        }
        return;
    }

    // ─────────────────────────────────────────────
    // Mod command logic
    // ─────────────────────────────────────────────
    if (containsMod && !containsUser && !containsAlt) {
        if (isMod || isSuperUser) {
            await executeModCommand(event, devvitContext);
            return;
        } else {
            const command = await modCommandValue(devvitContext);
            //send message saying no perms
            // ModAwardCommandFailMessage
            const modAwardFailMsg = formatMessage(
                (settings[AppSetting.ModAwardCommandFail] as string) ??
                    TemplateDefaults.ModAwardCommandFailMessage,
                {
                    awarder,
                    awardee: recipient,
                    command,
                }
            );

            const notify = ((settings[
                AppSetting.NotifyOnModAwardFail
            ] as string[]) ?? ["none"])[0];

            if (notify === NotifyOnModAwardFailReplyOptions.ReplyByPM) {
                await devvitContext.reddit.sendPrivateMessage({
                    to: awarder,
                    text: modAwardFailMsg,
                    subject: "Unsuccessful Award",
                });
            } else if (
                notify === NotifyOnModAwardFailReplyOptions.ReplyAsComment
            ) {
                const modAwardFailComment =
                    await devvitContext.reddit.submitComment({
                        id: event.comment.id,
                        text: modAwardFailMsg,
                    });

                await modAwardFailComment.distinguish();
            }
        }
    }

    // ─────────────────────────────────────────────
    // Alt command logic (with user or mod command)
    // ─────────────────────────────────────────────
    if (containsAlt && (containsUser || containsMod) && !isAltUser) {
        logger.error(
            `User tried to execute alt command and is not an alt user`
        );
        return;
    }
    if (containsAlt && (containsUser || containsMod)) {
        const handled = await handleAltUserAction(event, devvitContext);
        if (handled) return;
    }

    // ─────────────────────────────────────────────
    // Fallback unexpected flow
    // ─────────────────────────────────────────────
    logger.error("Unexpected command flow detected", {
        containsMod,
        containsUser,
        containsAlt,
        awarder,
        commentId: event.comment.id,
    });
}

export async function unflairedPostLogic(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
    awarder: string,
    settings: SettingsValues
) {
    if (!event.post || !event.comment || !event.author) return;
    const allowUnflairedPosts =
        (settings[AppSetting.AllowUnflairedPosts] as boolean) ?? true;

    const unflairedMessage =
        (settings[AppSetting.UnflairedPostMessage] as string) ??
        TemplateDefaults.UnflairedPostMessage;

    const notifyUnflaired = ((settings[
        AppSetting.NotifyOnUnflairedPost
    ] as string[]) ?? [NotifyOnUnflairedPostReplyOptions.NoReply])[0];

    if (!event.post.linkFlair) {
        logger.error(`linkFlair doesn't exist`, {
            linkFlair: event.post.linkFlair,
        });
        return;
    }

    const rawDisallowedFlairs =
        (settings[AppSetting.DisallowedFlairs] as string | undefined) ?? "";

    const disallowedFlairs = rawDisallowedFlairs
        .split(/\r?\n/) // newline-only entries
        .map((flair) => flair.trim())
        .filter(Boolean);
    const postFlairText = event.post.linkFlair?.text?.trim();

    // 🚫 Unflaired posts not allowed
    if (!allowUnflairedPosts && postFlairText === "") {
        // 🚫 Ignore bot’s own comments to prevent loops
        if (event.author.name === context.appName) {
            logger.debug(
                "🤖 Bot-authored comment detected; skipping unflaired-post response"
            );
            return;
        }

        // 🔑 One response per award attempt (per comment)
        const responseKey = `unflairedResponse:${event.comment.id}`;

        if (await context.redis.exists(responseKey)) {
            logger.debug("ℹ️ Unflaired post response already sent — skipping", {
                commentId: event.comment.id,
            });
            return;
        }

        logger.info("🚫 Award blocked — post is unflaired", {
            awarder,
            postId: event.post.id,
            commentId: event.comment.id,
            notifyUnflaired,
        });

        try {
            if (
                notifyUnflaired === NotifyOnUnflairedPostReplyOptions.ReplyByPM
            ) {
                await context.reddit.sendPrivateMessage({
                    to: awarder,
                    subject: `Awards disabled for unflaired posts`,
                    text: unflairedMessage,
                });
            } else if (
                notifyUnflaired ===
                NotifyOnUnflairedPostReplyOptions.ReplyAsComment
            ) {
                const unflairedPostMessage = await context.reddit.submitComment(
                    {
                        id: event.comment.id,
                        text: unflairedMessage,
                    }
                );
                await unflairedPostMessage.distinguish();
            }
        } catch (err) {
            logger.error(
                "❌ Failed to notify user about unflaired post restriction",
                { awarder, commentId: event.comment.id, err }
            );
        }

        await context.redis.set(responseKey, "1");
        return; // ⛔ Stop award flow ONLY for unflaired posts
    }
}

export async function flairTextNotAllowedLogic(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
    awarder: string,
    commentBody: string,
    triggerUsed: string,
    settings: SettingsValues
) {
    if (!event.post || !event.comment || !event.author) return;
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const flairTextDisallowedMessage = formatMessage(
        (settings[AppSetting.DisallowedFlairMessage] as string) ??
            TemplateDefaults.DisallowedFlairMessage,
        { name: pointName }
    );
    const postFlairText = event.post.linkFlair?.text?.trim();

    const notifyFlairIgnored = ((settings[
        AppSetting.NotifyOnDisallowedFlair
    ] as string[]) ?? [NotifyOnDisallowedFlairReplyOptions.NoReply])[0];

    // ─────────────────────────────────────────────
    // Disallowed flair guard (non-terminating)
    // ─────────────────────────────────────────────

    if (!event.post.linkFlair || !postFlairText) {
        logger.error(
            `User attempted to award points on unflaired posts, but it's not allowed`,
            { linkFlair: event.post.linkFlair }
        );
        return;
    }

    const rawDisallowedFlairs =
        (settings[AppSetting.DisallowedFlairs] as string | undefined) ?? "";

    const disallowedFlairs = rawDisallowedFlairs
        .split(/\r?\n/) // newline-only entries
        .map((flair) => flair.trim())
        .filter(Boolean);

    if (
        disallowedFlairs.length !== 0 &&
        disallowedFlairs.includes(postFlairText)
    ) {
        logger.debug("🔍 Disallowed flair check", {
            postFlair: postFlairText,
            disallowedFlairs,
        });

        if (!triggerUsed || !commentBody.includes(triggerUsed)) {
            logger.info(`Comment in disallowed flair, but not a command`);
            return;
        }

        if (event.author.name === context.appName) {
            // 🚫 Ignore bot’s own comments to prevent loops
            logger.debug(
                "🤖 Bot-authored comment detected; skipping disallowed flair response"
            );
            return;
        }

        const responseKey = `disallowedFlairResponse:${event.comment.id}`;

        if (await context.redis.exists(responseKey)) {
            logger.debug(
                "♻️ Disallowed flair already handled for this comment",
                {
                    commentId: event.comment.id,
                }
            );
            return;
        }

        // Mark handled BEFORE replying
        await context.redis.set(responseKey, "1");

        logger.info("🚫 Award blocked due to disallowed flair", {
            postFlair: postFlairText,
        });

        if (
            notifyFlairIgnored === NotifyOnDisallowedFlairReplyOptions.ReplyByPM
        ) {
            await context.reddit.sendPrivateMessage({
                to: awarder,
                subject: `${pointName}s cannot be awarded on ${event.post.title}`,
                text: flairTextDisallowedMessage,
            });
        } else if (
            notifyFlairIgnored ===
            NotifyOnDisallowedFlairReplyOptions.ReplyAsComment
        ) {
            const disallowedFlairMessage = await context.reddit.submitComment({
                id: event.comment.id,
                text: flairTextDisallowedMessage,
            });
            await disallowedFlairMessage.distinguish();
        }
        return; // ⛔ block award
    }
}

export async function selfAwardAttemptLogic(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
    awarder: string,
    recipient: string,
    settings: SettingsValues
) {
    if (!event.comment || !event.author) return;
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const selfMsgTemplate =
        (settings[AppSetting.SelfAwardMessage] as string) ??
        TemplateDefaults.NotifyOnSelfAwardTemplate;
    const notifySelf = ((settings[
        AppSetting.NotifyOnSelfAward
    ] as string[]) ?? [NotifyOnSelfAwardReplyOptions.NoReply])[0];
    if (awarder === recipient) {
        const selfText = formatMessage(selfMsgTemplate, {
            awarder,
            name: pointName,
        });
        if (notifySelf === NotifyOnSelfAwardReplyOptions.ReplyAsComment) {
            const selfAwardMessage = await context.reddit.submitComment({
                id: event.comment.id,
                text: selfText,
            });
            await selfAwardMessage.distinguish();
        } else if (notifySelf === NotifyOnSelfAwardReplyOptions.ReplyByPM) {
            await context.reddit.sendPrivateMessage({
                to: awarder,
                subject: `You tried to award yourself a ${pointName}`,
                text: selfText,
            });
        }
        logger.debug("❌ User tried to award themselves.");
        return;
    }
}
export async function replyToUser(
    context: TriggerContext,
    notifyMode: string,
    recipient: string,
    message: string,
    commentId: string
) {
    if (!notifyMode || notifyMode === "none") {
        logger.debug("ℹ️ replyToUser: notifyMode is none — skipping reply");
        return;
    }

    // 🚫 Prevent bot loops
    if (
        recipient.toLowerCase() === context.appName.toLowerCase() ||
        recipient.toLowerCase() === "automoderator"
    ) {
        logger.debug("🤖 replyToUser: recipient is bot/system — skipping");
        return;
    }

    // 🔑 One reply per comment + notify type
    const responseKey = `replyToUser:${notifyMode}:${commentId}`;
    if (await context.redis.exists(responseKey)) {
        logger.debug("♻️ replyToUser: response already sent", {
            commentId,
            notifyMode,
        });
        return;
    }

    try {
        if (notifyMode === "replybypm") {
            await context.reddit.sendPrivateMessage({
                to: recipient,
                subject: "Award not allowed",
                text: message,
            });

            logger.info("📬 replyToUser: sent PM", {
                recipient,
                commentId,
            });
        } else if (notifyMode === "replybycomment") {
            const reply = await context.reddit.submitComment({
                id: commentId,
                text: message,
            });
            await reply.distinguish();

            logger.info("💬 replyToUser: posted comment reply", {
                commentId,
            });
        } else {
            logger.warn("⚠️ replyToUser: unknown notifyMode", {
                notifyMode,
            });
            return;
        }

        // ✅ Mark handled AFTER success
        await context.redis.set(responseKey, "1");
    } catch (err) {
        logger.error("❌ replyToUser failed", {
            recipient,
            commentId,
            notifyMode,
            err,
        });
    }
}

export async function checkPermissionOfUser(
    event: CommentSubmit | CommentUpdate,
    awarder: string,
    commentTriggerContext: CommentTriggerContext,
    devvitContext: TriggerContext,
    settings: SettingsValues
) {
    if (!event.post || !event.comment) return;
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";

    const isMod = commentTriggerContext.isMod;
    const isSuperUser = commentTriggerContext.isSuperUser;
    const isAltUser = commentTriggerContext.isAltUser;
    const isOP = awarder === event.post.authorId;
    const accessControl = ((settings[AppSetting.AccessControl] as string[]) ?? [
        "everyone",
    ])[0];

    const hasPermission =
        accessControl === "everyone" ||
        (accessControl === "moderators-only" && isMod) ||
        (accessControl === "moderators-and-superusers" &&
            (isMod || isSuperUser)) ||
        (accessControl === "moderators-superusers-and-op" &&
            (isMod || isSuperUser || isOP)) ||
        (accessControl === "alt-users-only" && isAltUser);
    if (!hasPermission) {
        let msgKey: AppSetting;
        let notifyKey: AppSetting;

        switch (accessControl) {
            case "alt-users-only":
                msgKey = AppSetting.AlternateUsersOnlyDisallowedMessage;
                notifyKey = AppSetting.NotifyOnAltUserDisallowed;
                break;

            case "moderators-only":
                msgKey = AppSetting.ModOnlyDisallowedMessage;
                notifyKey = AppSetting.NotifyOnModOnlyDisallowed;
                break;

            case "moderators-and-superusers":
                msgKey = AppSetting.ApprovedOnlyDisallowedMessage;
                notifyKey = AppSetting.NotifyOnApprovedOnlyDisallowed;
                break;

            case "moderators-superusers-and-op":
                msgKey = AppSetting.OPOnlyDisallowedMessage;
                notifyKey = AppSetting.NotifyOnOPOnlyDisallowed;
                break;

            default:
                logger.warn("⚠️ Unknown accessControl value", {
                    accessControl,
                });
                return;
        }

        const denyMsg = formatMessage(
            (settings[msgKey] as string) ??
                TemplateDefaults.ModOnlyDisallowedMessage,
            { awarder, name: pointName }
        );

        const notifyMode = ((settings[notifyKey] as string[]) ?? ["none"])[0];

        await replyToUser(
            devvitContext,
            notifyMode,
            awarder,
            denyMsg,
            event.comment.id
        );

        return;
    }
}

export async function awarderIsBot(
    event: CommentSubmit | CommentUpdate,
    devvitContext: TriggerContext,
    awarder: string,
    settings: SettingsValues
) {
    if (!event.comment) return;
    if (
        ["automoderator", devvitContext.appName.toLowerCase()].includes(
            awarder.toLowerCase()
        )
    ) {
        logger.debug("❌ System user attempted a command");
        return;
    }

    const parentComment: Comment | undefined = await getParentComment(
        event,
        devvitContext
    );
    if (!parentComment) {
        logger.warn("❌ Parent comment not found", {
            commentId: event.comment.id,
        });
        return;
    }

    const recipient = parentComment.authorName;
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";

    if (
        awarder === devvitContext.appName ||
        awarder.toLowerCase() === "automoderator"
    ) {
        const botMsg = formatMessage(
            (settings[AppSetting.BotAwardMessage] as string) ??
                TemplateDefaults.BotAwardMessage,
            { name: pointName, awardee: recipient }
        );
        const botAwardMessage = await devvitContext.reddit.submitComment({
            id: event.comment.id,
            text: botMsg,
        });
        await botAwardMessage.distinguish();
        logger.debug(`❌ ${recipient} cannot be awarded points`);
        return;
    }
}

export async function recipientIsBot(
    event: CommentSubmit | CommentUpdate,
    devvitContext: TriggerContext,
    awarder: string,
    recipient: string,
    settings: SettingsValues
) {
    if (!event.comment) return;
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    if (
        ["automoderator", devvitContext.appName.toLowerCase()].includes(
            awarder.toLowerCase()
        )
    ) {
        logger.debug("❌ System user attempted a command");
        return;
    }

    if (
        ["automoderator", devvitContext.appName.toLowerCase()].includes(
            recipient.toLowerCase()
        )
    ) {
        // Prevent bot account or Automod granting points
        const botAwardMessage = formatMessage(
            (settings[AppSetting.BotAwardMessage] as string) ??
                TemplateDefaults.BotAwardMessage,
            { name: pointName, awardee: recipient }
        );

        const awardGivenToBotMessage = await devvitContext.reddit.submitComment(
            {
                id: event.comment.id,
                text: botAwardMessage,
            }
        );
        await awardGivenToBotMessage.distinguish();
        logger.debug("❌ Bot cannot award itself points");
        return;
    }
}

export async function handleIgnoredContext(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
    trigger: string
): Promise<void> {
    if (!event.comment || !event.author || !event.subreddit) return;

    const body = (event.comment.body ?? "").toLowerCase();
    const ignoredType = getIgnoredContextType(body, trigger);
    if (!ignoredType) return;

    const ignoreKey = `normalCommandIgnoreDM:${event.author.name.toLowerCase()}:${ignoredType}`;
    const alreadyConfirmed = await context.redis.exists(ignoreKey);

    if (alreadyConfirmed) return;

    const contextLabel =
        ignoredType === "quote"
            ? "a quote block (`> text`)"
            : ignoredType === "alt"
            ? "`alt text` (text surrounded by backticks (`))"
            : "a spoiler block (`>!text!<`)";

    const initialTriggerInContextLabelNotification = `Hey u/${event.author.name}, I noticed you used the command **${trigger}** inside ${contextLabel}.\n\n`;
    const confirmInfo = `Edit [this comment](${event.comment.permalink}) with **CONFIRM** if you intended to use the command this way and don't wish to be warned about this in the future.\n\n`;
    const botInfo = `---\n\n^(I am a bot — contact the mods of [r/${event.subreddit.name}](https://reddit.com/r/${event.subreddit.name}) with any questions or [r/TheRepBot](https://www.reddit.com/message/compose?to=r/TheRepBot) to talk directly with [my developer](https://reddit.com/u/ryry50583583))`;

    const dmText =
        initialTriggerInContextLabelNotification + confirmInfo + botInfo;

    await context.reddit.sendPrivateMessage({
        to: event.author.name,
        subject: `Your ${trigger} command was ignored`,
        text: dmText,
    });

    await context.redis.set(
        `pendingConfirm:${event.author.name.toLowerCase()}`,
        ignoredType
    );

    logger.info("⚠️ Normal command ignored due to context", {
        user: event.author.name,
        trigger,
        ignoredType,
    });

    return;
}

export async function ignoredContextNeedsHandling(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
    trigger: string
): Promise<boolean> {
    if (!event.comment || !event.author || !event.subreddit) return false;

    const body = (event.comment.body ?? "").toLowerCase();
    const ignoredType = getIgnoredContextType(body, trigger);
    if (!ignoredType) return false;

    const ignoreKey = `normalCommandIgnoreDM:${event.author.name.toLowerCase()}:${ignoredType}`;
    const alreadyConfirmed = await context.redis.exists(ignoreKey);

    if (alreadyConfirmed) return true;
    
    return false;
}
