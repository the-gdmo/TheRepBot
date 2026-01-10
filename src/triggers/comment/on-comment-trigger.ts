import { CommentSubmit, CommentUpdate } from "@devvit/protos";
import { TriggerContext, Comment } from "@devvit/public-api";
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
    NotifyOnModAwardFailReplyOptions,
    NotifyOnRestrictionLiftedReplyOptions,
    NotifyOnSelfAwardReplyOptions,
    TemplateDefaults,
} from "../../settings.js";
import {
    commandUsedInIgnoredContext,
    formatMessage,
    getIgnoredContextType,
    getTriggers,
    modCommandValue,
} from "../utils/common-utilities.js";
import { restrictedKeyExists } from "../post-logic/redisKeys.js";

export async function handleThanksEvent(
    event: CommentSubmit | CommentUpdate,
    devvitContext: TriggerContext
) {
    if (!event.post || !event.author || !event.comment || !event.subreddit) {
        logger.warn("❌ Missing required event data", { event });
        return;
    }

    // ─────────────────────────────────────────────
    // Initialize context
    // ─────────────────────────────────────────────
    const context = new CommentTriggerContext();
    await context.init(event, devvitContext);

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

    const awarder = event.author.name;
    const recipient = parentComment.authorName;
    if (!recipient) {
        logger.warn("❌ No recipient found", { parentComment });
        return;
    }

    const isMod = context.isMod;
    const isSuperUser = context.isSuperUser;
    const isAltUser = context.isAltUser;
    const isOP = awarder === event.post.authorId;
    const userCanAward = context.userCanAward;

    const settings = await devvitContext.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";

    // ─────────────────────────────────────────────
    // Prevent system/bot self-awards
    // ─────────────────────────────────────────────
    if (
        ["automoderator", devvitContext.appName.toLowerCase()].includes(
            awarder.toLowerCase()
        )
    ) {
        logger.debug("❌ System user attempted a command");
        return;
    }

    if (
        awarder === devvitContext.appName ||
        awarder.toLowerCase() === "automoderator"
    ) {
        const botMsg = formatMessage(
            (settings[AppSetting.BotAwardMessage] as string) ??
                TemplateDefaults.BotAwardMessage,
            { name: pointName, awardee: recipient }
        );
        const reply = await devvitContext.reddit.submitComment({
            id: event.comment.id,
            text: botMsg,
        });
        await reply.distinguish();
        logger.debug(`❌ ${recipient} cannot be awarded points`);
        return;
    }

    // ─────────────────────────────────────────────
    // Access control enforcement
    // ─────────────────────────────────────────────
    const accessControl = ((settings[AppSetting.AccessControl] as string[]) ?? [
        "everyone",
    ])[0];
    const hasPermission =
        accessControl === "everyone" ||
        (accessControl === "moderators-only" && isMod) ||
        (accessControl === "moderators-and-superusers" &&
            (isMod || isSuperUser)) ||
        (accessControl === "moderators-superusers-and-op" &&
            (isMod || isSuperUser || isOP));

    if (!hasPermission) {
        const msg = formatMessage(
            (settings[AppSetting.ModOnlyDisallowedMessage] as string) ??
                TemplateDefaults.ModOnlyDisallowedMessage,
            { name: pointName }
        );
        const reply = await devvitContext.reddit.submitComment({
            id: event.comment.id,
            text: msg,
        });
        await reply.distinguish();
        return;
    }

    // ─────────────────────────────────────────────
    // Detect which command type exists
    // ─────────────────────────────────────────────
    const containsMod = await commentContainsModCommand(event, devvitContext);
    const containsUser = await commentContainsUserCommand(event, devvitContext);
    const containsAlt = await commentContainsAltCommand(event, devvitContext);

    // Detect exact trigger typed
    const commentBody = event.comment.body.toLowerCase();
    const triggers = await getTriggers(devvitContext);
    const triggerUsed = triggers.find((t) =>
        commentBody.includes(t.toLowerCase())
    );

    if (!triggerUsed) {
        logger.debug("❌ No valid award command found.");
        return;
    }

    if (commandUsedInIgnoredContext(commentBody, triggerUsed)) {
        const ignoredText = getIgnoredContextType(commentBody, triggerUsed);
        if (ignoredText) {
            const ignoreKey = `ignoreDM:${event.author.name.toLowerCase()}:${ignoredText}:${event.comment.id}`;
            const alreadyConfirmed = await devvitContext.redis.exists(
                ignoreKey
            );

            if (commentBody.includes("CONFIRM")) {
                await devvitContext.redis.set(ignoreKey, "1");
                logger.info(`User confirmed they wish to ignore the command version in question`);
            }

            if (!alreadyConfirmed) {
                const contextLabel =
                    ignoredText === "quote"
                        ? "a quote block (`> this`)"
                        : ignoredText === "alt"
                        ? "alt text (`this`)"
                        : "a spoiler block (`>!this!<`)";

                const dmText = `Hey u/${event.author.name}, I noticed you used the command **${triggerUsed}** inside ${contextLabel}.\n\nIf this was intentional, edit [the comment that triggered this](${event.comment.permalink}) with **CONFIRM** (in all caps) and you will not receive this message again for ${ignoredText} text.\n\n---\n\n^(I am a bot - please contact the mods of r/${event.subreddit.name} with any questions)\n\n---`;

                await devvitContext.reddit.sendPrivateMessage({
                    to: event.author.name,
                    subject: `Your ${triggerUsed} command was ignored`,
                    text: dmText,
                });

                await devvitContext.redis.set(
                    `pendingConfirm:${event.author.name.toLowerCase()}`,
                    ignoredText
                );

                logger.info("⚠️ Ignored command in special context; DM sent.", {
                    user: event.author.name,
                    triggerUsed,
                    ignoredText,
                });
            } else {
                logger.info(
                    "ℹ️ Ignored command in special context; user pre-confirmed no DMs.",
                    { user: event.author.name, triggerUsed, ignoredText }
                );
            }

            return; // stop here — do NOT award points
        }
    }

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
            const newComment = await devvitContext.reddit.submitComment({
                id: event.comment.id,
                text: selfText,
            });
            await newComment.distinguish();
        } else if (notifySelf === NotifyOnSelfAwardReplyOptions.ReplyByPM) {
            await devvitContext.reddit.sendPrivateMessage({
                to: awarder,
                subject: `You tried to award yourself a ${pointName}`,
                text: selfText,
            });
        }
        logger.debug("❌ User tried to award themselves.");
        return;
    }

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

        const newComment = await devvitContext.reddit.submitComment({
            id: event.comment.id,
            text: botAwardMessage,
        });
        await newComment.distinguish();
        logger.debug("❌ Bot cannot award itself points");
        return;
    }
    const restrictedFlagExists = await restrictedKeyExists(
        devvitContext,
        awarder
    );

    // ─────────────────────────────────────────────
    // Normal user command logic
    // ─────────────────────────────────────────────
    if (containsUser && !containsMod && !containsAlt) {
        if (userCanAward) {
            await executeUserCommand(event, devvitContext);
            if (!restrictedFlagExists) {
                await notifyPostAuthorWhenTheyBecomeUnrestricted(
                    event,
                    devvitContext,
                    awarder
                );
            }
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
            if (!restrictedFlagExists) {
                await notifyPostAuthorWhenTheyBecomeUnrestricted(
                    event,
                    devvitContext,
                    awarder
                );
            }
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
            }
        }
    }

    // ─────────────────────────────────────────────
    // Alt command logic (with user or mod command)
    // ─────────────────────────────────────────────
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

export async function notifyPostAuthorWhenTheyBecomeUnrestricted(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
    awarder: string
) {
    if (!event.comment) return;
    const settings = await context.settings.getAll();

    const notify = ((settings[
        AppSetting.NotifyOnRestrictionLifted
    ] as string[]) ?? ["none"])[0];

    const liftedMsg = formatMessage(
        (settings[AppSetting.RestrictionLiftedMessage] as string) ??
            TemplateDefaults.RestrictionLiftedMessage,
        {}
    );

    if (notify === NotifyOnRestrictionLiftedReplyOptions.ReplyByPM) {
        await context.reddit.sendPrivateMessage({
            to: awarder,
            subject: "Restriction Lifted",
            text: liftedMsg,
        });
    } else if (
        notify === NotifyOnRestrictionLiftedReplyOptions.ReplyAsComment
    ) {
        const reply = await context.reddit.submitComment({
            id: event.comment.id,
            text: liftedMsg,
        });

        await reply.distinguish();
    }
}
