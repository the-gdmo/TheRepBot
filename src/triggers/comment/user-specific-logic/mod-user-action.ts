import { CommentSubmit, CommentUpdate } from "@devvit/protos";
import { TriggerContext, User } from "@devvit/public-api";
import {
    AppSetting,
    NotifyOnModAwardFailReplyOptions,
    NotifyOnModAwardSuccessReplyOptions,
    NotifyOnRestrictionLiftedReplyOptions,
    NotifyOnSelfAwardReplyOptions,
    TemplateDefaults,
} from "../../../settings.js";
import {
    escapeForRegex,
    formatMessage,
    getIgnoredContextType,
    getTriggers,
    modCommandValue,
    triggerUsed,
    updateAwardeeFlair,
} from "../../utils/common-utilities.js";
import {
    CommentTriggerContext,
    getParentComment,
} from "../comment-trigger-context.js";
import { logger } from "../../../logger.js";
import {
    getModDupKey,
    restrictedKeyExists,
    setModDupKey,
} from "../../post-logic/redisKeys.js";
import { handleAutoSuperuserPromotion } from "../../utils/user-utilities.js";
import {
    InitialUserWikiOptions,
    updateUserWiki,
} from "../../../leaderboard.js";
import { SafeWikiClient } from "../../../utility.js";
import { updateAuthorRedis } from "./normal-user-action.js";

export async function commentContainsModCommand(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext
): Promise<boolean> {
    if (!event.comment) return false;

    const allTriggers = await getTriggers(context);
    const commentBody = event.comment.body ?? "";
    const modCommand = await modCommandValue(context);

    const triggerUsed = allTriggers.find((t) => commentBody.includes(t));
    if (!triggerUsed) return false;
    const usedCommand = triggerUsed.toLowerCase();

    const isModCommand = usedCommand === modCommand;

    logger.info("🛡️ Mod command probe", {
        usedCommand,
        modCommand,
        isModCommand,
    });

    return isModCommand;
}

export async function handleIgnoredContextIfNeeded(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
    trigger: string
): Promise<boolean> {
    if (!event.comment || !event.author || !event.subreddit) return false;

    const body = (event.comment.body ?? "").toLowerCase();
    const ignoredType = getIgnoredContextType(body, trigger);
    if (!ignoredType) return false;

    const ignoreKey = `ignoreDM:${event.author.name.toLowerCase()}:${ignoredType}`;
    const confirmed = await context.redis.exists(ignoreKey);

    if (confirmed) return true;

    const contextLabel =
        ignoredType === "quote"
            ? "a quote block (`> text`)"
            : ignoredType === "alt"
            ? "alt text (``text``)"
            : "a spoiler block (`>!text!<`)";

    const dmText = `Hey u/${event.author.name}, I noticed you used the command **${trigger}** inside ${contextLabel}.

Reply with **CONFIRM** on [this comment](${event.comment.permalink}) to suppress this warning in the future.

---
^(I am a bot — contact the mods of ${event.subreddit.name})`;

    await context.reddit.sendPrivateMessage({
        to: event.author.name,
        subject: `Your ${trigger} command was ignored`,
        text: dmText,
    });

    await context.redis.set(
        `pendingConfirm:${event.author.name.toLowerCase()}`,
        ignoredType
    );

    logger.info("⚠️ Mod command ignored due to context", {
        user: event.author.name,
        trigger,
        ignoredType,
    });

    return true;
}

export async function isSelfAwardModCommand(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext
): Promise<boolean> {
    if (!event.author) return true;

    const parent = await getParentComment(event, context);
    if (!parent) return true;

    return parent.authorName === event.author.name;
}

async function handleSelfAwardModCommand(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext
) {
    const parentComment = await getParentComment(event, context);
    if (!event.author || !event.comment || !parentComment) return;
    const settings = await context.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";

    const selfMsgTemplate =
        (settings[AppSetting.SelfAwardMessage] as string) ??
        TemplateDefaults.NotifyOnSelfAwardTemplate;
    const notifySelf = ((settings[
        AppSetting.NotifyOnSelfAward
    ] as string[]) ?? [NotifyOnSelfAwardReplyOptions.NoReply])[0];
    const awarder = event.author.name;
    const recipient = parentComment.authorName;
    if (awarder === recipient) {
        const selfText = formatMessage(selfMsgTemplate, {
            awarder,
            name: pointName,
        });
        if (notifySelf === NotifyOnSelfAwardReplyOptions.ReplyAsComment) {
            const newComment = await context.reddit.submitComment({
                id: event.comment.id,
                text: selfText,
            });
            await newComment.distinguish();
        } else if (notifySelf === NotifyOnSelfAwardReplyOptions.ReplyByPM) {
            await context.reddit.sendPrivateMessage({
                to: awarder,
                subject: `You tried to award yourself a ${pointName}`,
                text: selfText,
            });
        }
        const reply = await context.reddit.submitComment({
            id: event.comment.id,
            text: selfText,
        });
        await reply.distinguish();

        logger.debug("❌ User tried to award themselves.");
        return;
    }

    logger.warn("❌ Mod attempted self-award", { awarder });
}

export async function isDuplicateModAward(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext
): Promise<boolean> {
    const key = await getModDupKey(event, context);
    const exists = await context.redis.exists(key);
    return exists === 1;
}

export async function handleDuplicateModAward(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext
) {
    const parentComment = await getParentComment(event, context);
    if (!parentComment || !event.author || !event.comment) return;
    const settings = await context.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const awarder = event.author.name;
    const awardee = parentComment.authorName;

    const msg = formatMessage(
        (settings[AppSetting.ModAwardAlreadyGiven] as string) ??
            TemplateDefaults.ModAwardAlreadyGivenMessage,
        { awarder, awardee, name: pointName }
    );

    const notify = ((settings[AppSetting.NotifyOnModAwardFail] as string[]) ?? [
        "none",
    ])[0];

    if (notify === NotifyOnModAwardFailReplyOptions.ReplyAsComment) {
        const reply = await context.reddit.submitComment({
            id: event.comment!.id,
            text: msg,
        });
        await reply.distinguish();
    } else if (notify === NotifyOnModAwardFailReplyOptions.ReplyByPM) {
        await context.reddit.sendPrivateMessage({
            to: awarder,
            subject: "Mod award already given",
            text: msg,
        });
    }

    logger.info("❌ Duplicate mod award blocked", { awarder });
}

export async function handleUnauthorizedModCommand(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
    trigger: string
) {
    const ctx = new CommentTriggerContext();
    await ctx.init(event, context);

    if (ctx.isMod || ctx.isSuperUser) return;

    const settings = await context.settings.getAll();
    const awarder = event.author!.name;
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";

    const failMsg = formatMessage(
        (settings[AppSetting.ModAwardCommandFail] as string) ??
            TemplateDefaults.ModAwardCommandFailMessage,
        {
            command: trigger,
            name: pointName,
            awarder,
        }
    );

    const notify = ((settings[AppSetting.NotifyOnModAwardFail] as string[]) ?? [
        "none",
    ])[0];

    if (notify === NotifyOnModAwardFailReplyOptions.ReplyAsComment) {
        const reply = await context.reddit.submitComment({
            id: event.comment!.id,
            text: failMsg,
        });
        await reply.distinguish();
    } else if (notify === NotifyOnModAwardFailReplyOptions.ReplyByPM) {
        await context.reddit.sendPrivateMessage({
            to: awarder,
            subject: "Mod Award Command Not Allowed",
            text: failMsg,
        });
    }

    logger.warn("🚫 Unauthorized mod command", { awarder });
}

export async function awardPointToUserModCommand(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext
) {
    if (!event.comment || !event.subreddit || !event.author || !event.post) {
        logger.warn("❌ Missing required event data", { event });
        return;
    }
    const settings = await context.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";

    const parentComment = await getParentComment(event, context);
    if (!parentComment || !parentComment.authorId) {
        logger.warn("❌ Parent comment missing for mod award");
        return;
    }

    const awarder = event.author.name;
    const awardee = parentComment.authorName;

    let user: User | undefined;

    try {
        user = await context.reddit.getUserByUsername(awarder);
    } catch {
        user = undefined;
    }

    if (!user) return;

    // 🏆 Award point
    const newScore = await context.redis.zIncrBy(
        "thanksPointsStore",
        awardee,
        1
    );

    // 🔒 Prevent duplicates
    await setModDupKey(event, context, "1");

    // 🎨 Update flair
    await updateAwardeeFlair(
        context,
        event.subreddit.name,
        awardee,
        newScore,
        settings
    );

    // ⭐ Auto-superuser logic
    const modCommand = (settings[AppSetting.ModAwardCommand] as string) ?? "";
    await handleAutoSuperuserPromotion(
        event,
        context,
        event.comment.id,
        awardee,
        newScore,
        modCommand
    );

    // 📣 Notify on success
    const notifyMode =
        (settings[AppSetting.NotifyOnModAwardSuccess] as string[])?.[0] ??
        NotifyOnModAwardSuccessReplyOptions.NoReply;

    const leaderboard = `https://old.reddit.com/r/${
        event.subreddit.name
    }/wiki/${settings[AppSetting.LeaderboardName] ?? "leaderboard"}`;

    if (notifyMode !== NotifyOnModAwardSuccessReplyOptions.NoReply) {
        const successTemplate =
            (settings[AppSetting.ModAwardCommandSuccess] as string) ??
            TemplateDefaults.ModAwardCommandSuccessMessage;

        const awardeePage = `https://old.reddit.com/r/${event.subreddit.name}/wiki/user/${awardee}`;
        const awarderPage = `https://old.reddit.com/r/${event.subreddit.name}/wiki/user/${awarder}`;
        const message = formatMessage(successTemplate, {
            awardee,
            awarder,
            total: newScore.toString(),
            name: pointName,
            symbol: (settings[AppSetting.PointSymbol] as string) ?? "",
            leaderboard,
            awardeePage,
            awarderPage,
        });

        if (notifyMode === NotifyOnModAwardSuccessReplyOptions.ReplyAsComment) {
            const reply = await context.reddit.submitComment({
                id: event.comment.id,
                text: message,
            });
            await reply.distinguish();
        } else if (
            notifyMode === NotifyOnModAwardSuccessReplyOptions.ReplyByPM
        ) {
            await context.reddit.sendPrivateMessage({
                to: awarder,
                subject: "Mod Award Successful",
                text: message,
            });
        }
    }

    logger.info("🛡️ Mod award successful", {
        awarder,
        awardee,
        newScore,
    });
    const subredditName = event.subreddit.name;
    // User wiki handling for MOD awarder + awardee
    try {
        const safeWiki = new SafeWikiClient(context.reddit);
        const awarderPage = await safeWiki.getWikiPage(
            subredditName,
            `user/${awarder.toLowerCase()}`
        );
        const recipientPage = await safeWiki.getWikiPage(
            subredditName,
            `user/${awardee}`
        );

        if (!awarderPage) {
            logger.info("📄 Creating missing awarder wiki", {
                awarder,
            });
            await InitialUserWikiOptions(context, awarder);
        }

        if (!recipientPage) {
            logger.info("📄 Creating missing recipient wiki", {
                awardee,
            });
            await InitialUserWikiOptions(context, awardee);
        }

        const givenData = {
            postTitle: event.post.title,
            postUrl: event.post.permalink,
            awardee,
            commentUrl: event.comment.permalink,
        };

        await updateUserWiki(context, awarder, awardee, givenData);
    } catch (err) {
        logger.error("❌ Failed to update user wiki (MOD award)", {
            awarder,
            awardee,
            err,
        });
    }

    if (await restrictedKeyExists(context, awarder)) {
        await updateAuthorRedis(event, user, context);
    }
}

export async function executeModCommand(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext
) {
    if (!event.comment || !event.author || !event.post) return;
    const awarder = event.author.name;
    const settings = await context.settings.getAll();

    let user: User | undefined;
    try {
        user = await context.reddit.getUserByUsername(awarder);
    } catch {
        user = undefined;
    }
    if (!user) return;

    const body = (event.comment.body ?? "").toLowerCase();
    const triggers = await getTriggers(context);

    for (const trigger of triggers) {
        if (!new RegExp(escapeForRegex(trigger), "i").test(body)) continue;

        if (await handleIgnoredContextIfNeeded(event, context, trigger)) return;

        await handleUnauthorizedModCommand(event, context, trigger);

        if (await isSelfAwardModCommand(event, context)) {
            await handleSelfAwardModCommand(event, context);
            return;
        }

        if (await isDuplicateModAward(event, context)) {
            await handleDuplicateModAward(event, context);
            return;
        }

        await awardPointToUserModCommand(event, context);
    }
}
