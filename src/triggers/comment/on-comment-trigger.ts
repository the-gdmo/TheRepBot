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
    NotifyOnDisallowedFlairReplyOptions,
    NotifyOnModAwardFailReplyOptions,
    NotifyOnRestrictionLiftedReplyOptions,
    NotifyOnSelfAwardReplyOptions,
    NotifyOnUnflairedPostReplyOptions,
    TemplateDefaults,
} from "../../settings.js";
import {
    formatMessage,
    getTriggers,
    modCommandValue,
} from "../utils/common-utilities.js";
import { restrictedKeyExists } from "../post-logic/redisKeys.js";

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
    ``;

    const settings = await devvitContext.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const awarder = event.author.name;

    const allowUnflairedPosts =
        (settings[AppSetting.AllowUnflairedPosts] as boolean) ?? true;

    const unflairedMessage =
        (settings[AppSetting.UnflairedPostMessage] as string) ??
        TemplateDefaults.UnflairedPostMessage;

    const notifyUnflaired = ((settings[
        AppSetting.NotifyOnUnflairedPost
    ] as string[]) ?? [NotifyOnUnflairedPostReplyOptions.NoReply])[0];

    if (!event.post.linkFlair) {
        logger.error(
            `linkFlair doesn't exist`,
            { linkFlair: event.post.linkFlair },
            devvitContext
        );
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
        if (event.author.name === devvitContext.appName) {
            logger.debug(
                "🤖 Bot-authored comment detected; skipping unflaired-post response"
            );
            return;
        }

        // 🔑 One response per award attempt (per comment)
        const responseKey = `unflairedResponse:${event.comment.id}`;

        if (await devvitContext.redis.exists(responseKey)) {
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
                await devvitContext.reddit.sendPrivateMessage({
                    to: awarder,
                    subject: `Awards disabled for unflaired posts`,
                    text: unflairedMessage,
                });
            } else if (
                notifyUnflaired ===
                NotifyOnUnflairedPostReplyOptions.ReplyAsComment
            ) {
                const reply = await devvitContext.reddit.submitComment({
                    id: event.comment.id,
                    text: unflairedMessage,
                });
                await reply.distinguish();
            }
        } catch (err) {
            logger.error(
                "❌ Failed to notify user about unflaired post restriction",
                { awarder, commentId: event.comment.id, err }
            );
        }

        await devvitContext.redis.set(responseKey, "1");
        return; // ⛔ Stop award flow ONLY for unflaired posts
    }

    const flairTextDisallowedMessage = formatMessage(
        (settings[AppSetting.DisallowedFlairMessage] as string) ??
            TemplateDefaults.DisallowedFlairMessage,
        { name: pointName }
    );

    const notifyFlairIgnored = ((settings[
        AppSetting.NotifyOnDisallowedFlair
    ] as string[]) ?? [NotifyOnDisallowedFlairReplyOptions.NoReply])[0];

    // ─────────────────────────────────────────────
    // Disallowed flair guard (non-terminating)
    // ─────────────────────────────────────────────

    if (!event.post.linkFlair) {
        logger.error(
            `linkFlair doesn't exist`,
            { linkFlair: event.post.linkFlair },
            devvitContext
        );
        return;
    }

    if (
        disallowedFlairs.length !== 0 &&
        disallowedFlairs.includes(postFlairText)
    ) {
        logger.debug("🔍 Disallowed flair check", {
            postFlair: postFlairText,
            disallowedFlairs,
        });

        if (disallowedFlairs.includes(postFlairText)) {
            // 🚫 Ignore bot’s own comments to prevent loops
            if (event.author.name === devvitContext.appName) {
                logger.debug(
                    "🤖 Bot-authored comment detected; skipping disallowed flair response"
                );
                return;
            }

            const responseKey = `disallowedFlairResponse:${event.comment.id}`;

            if (await devvitContext.redis.exists(responseKey)) {
                logger.debug(
                    "♻️ Disallowed flair already handled for this comment",
                    {
                        commentId: event.comment.id,
                    }
                );
                return;
            }

            // Mark handled BEFORE replying
            await devvitContext.redis.set(responseKey, "1");

            logger.info("🚫 Award blocked due to disallowed flair", {
                postFlair: postFlairText,
            });

            if (
                notifyFlairIgnored ===
                NotifyOnDisallowedFlairReplyOptions.ReplyByPM
            ) {
                await devvitContext.reddit.sendPrivateMessage({
                    to: awarder,
                    subject: `${pointName}s cannot be awarded on ${event.post.title}`,
                    text: flairTextDisallowedMessage,
                });
            } else if (
                notifyFlairIgnored ===
                NotifyOnDisallowedFlairReplyOptions.ReplyAsComment
            ) {
                const msg = await devvitContext.reddit.submitComment({
                    id: event.comment.id,
                    text: flairTextDisallowedMessage,
                });
                await msg.distinguish();
            }
            return; // ⛔ block award
        }
        return;
    }

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
