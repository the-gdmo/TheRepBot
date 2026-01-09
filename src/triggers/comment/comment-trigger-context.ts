import { CommentSubmit, CommentUpdate } from "@devvit/protos";
import {
    Comment,
    SettingsValues,
    TriggerContext,
    User,
} from "@devvit/public-api";
import {
    getUserCanAward,
    getUserIsAltUser,
    getUserIsSuperuser,
    isModerator,
} from "../utils/user-utilities.js";
import { logger } from "../../logger.js";
import {
    AppSetting,
    AutoSuperuserReplyOptions,
    TemplateDefaults,
} from "../../settings.js";
import { formatMessage } from "../utils/common-utilities.js";
import { POINTS_STORE_KEY } from "../post-logic/redisKeys.js";

// src/triggers/comment/comment-trigger-context.ts
export class CommentTriggerContext {
    private _event: CommentSubmit | CommentUpdate | undefined = undefined;
    private _context: TriggerContext | undefined = undefined;
    private _awarder: string | undefined = undefined;
    private _subredditName: string | undefined = undefined;
    private _isMod: boolean = false;
    private _isAltUser: boolean = false;
    private _isSuperUser: boolean = false;
    private _userCanAward: boolean = false;
    // More properties...

    get userCanAward() {
        return this._userCanAward;
    }
    get awarder() {
        return this._awarder;
    }
    get isMod() {
        return this._isMod;
    }
    get isSuperUser() {
        return this._isSuperUser;
    }
    get isAltUser() {
        return this._isAltUser;
    }
    // More getters where needed...

    public async init(
        event: CommentSubmit | CommentUpdate,
        context: TriggerContext
    ) {
        if (!event.author) return;
        if (!event.subreddit) return;
        this._event = event;
        this._context = context;
        this._awarder = event.author.name;
        this._subredditName = event.subreddit.name;
        this._isMod = await isModerator(
            context,
            this._subredditName,
            this._awarder
        );
        this._isAltUser = await getUserIsAltUser(context, this._awarder);
        this._isSuperUser = await getUserIsSuperuser(context, this._awarder);
        this._userCanAward = await getUserCanAward(context, this._awarder);
        // More context setup
    }
}

interface ScoreResult {
    score: number;
    userHasFlair: boolean;
    flairIsPointsFlair: boolean;
    flairIsNumber: boolean;
}

export async function getCurrentScore(
    user: User,
    context: TriggerContext,
    settings: SettingsValues
): Promise<{
    currentScore: number;
    flairText: string;
    flairSymbol: string;
}> {
    const subredditName = (await context.reddit.getCurrentSubreddit()).name;
    const userFlair = await user.getUserFlairBySubreddit(subredditName);

    let scoreFromRedis: number | undefined;
    try {
        scoreFromRedis =
            (await context.redis.zScore(
                `${POINTS_STORE_KEY}`,
                user.username
            )) ?? 0;
    } catch {
        scoreFromRedis = 0;
    }

    const flairTextRaw = userFlair?.flairText ?? "";
    let scoreFromFlair: number;
    const numberRegex = /^\d+$/;

    if (!flairTextRaw || flairTextRaw === "-") {
        scoreFromFlair = 0;
    } else {
        // Extract numeric part from start of flair text (e.g. "17⭐" -> "17")
        const numericMatch = flairTextRaw.match(/^\d+/);
        if (numericMatch && numberRegex.test(numericMatch[0])) {
            scoreFromFlair = parseInt(numericMatch[0], 10);
        } else {
            scoreFromFlair = NaN;
        }
    }

    const flairScoreIsNaN = isNaN(scoreFromFlair);

    // Extract symbol by removing the numeric part from flair text, trim whitespace
    const flairSymbol = flairTextRaw.replace(/^\d+/, "").trim();

    if (settings[AppSetting.PrioritiseScoreFromFlair] && !flairScoreIsNaN) {
        return {
            currentScore: scoreFromFlair,
            flairText: flairTextRaw,
            flairSymbol,
        };
    }

    return {
        currentScore:
            !flairScoreIsNaN && scoreFromFlair > scoreFromRedis
                ? scoreFromFlair
                : scoreFromRedis,
        flairText: flairTextRaw,
        flairSymbol,
    };
}

export async function userBecomesSuperUser(
    event: CommentSubmit | CommentUpdate,
    userScore: number,
    context: TriggerContext
) {
    if (!event.comment) return;
    if (!event.author) return;

    const parentComment = await getParentComment(event, context);
    if (!parentComment) return;

    const recipient = parentComment.authorName;
    const recipientUser = await context.reddit.getUserByUsername(recipient);
    if (!recipientUser) return;

    const settings = await context.settings.getAll();

    const autoSuperuserThreshold =
        (settings[AppSetting.AutoSuperuserThreshold] as number | undefined) ??
        0;
    const superUserCommand = settings[AppSetting.ModAwardCommand] as string ?? "";
    const notifyOnAutoSuperuser = ((settings[
        AppSetting.NotifyOnAutoSuperuser
    ] as string[] | undefined) ?? [
        AutoSuperuserReplyOptions.NoReply,
    ])[0] as AutoSuperuserReplyOptions;
    if (
        autoSuperuserThreshold &&
        userScore === autoSuperuserThreshold &&
        notifyOnAutoSuperuser !== AutoSuperuserReplyOptions.NoReply
    ) {
        console.log(
            `${event.comment.id}: ${recipientUser.username} has reached the auto superuser threshold. Notifying.`
        );
        (settings[AppSetting.NotifyOnAutoSuperuserTemplate] as
            | string
            | undefined) ?? TemplateDefaults.NotifyOnSuperuserTemplate;
        const message = formatMessage(
            (settings[AppSetting.NotifyOnAutoSuperuserTemplate] as string) ??
                TemplateDefaults.NotifyOnSuperuserTemplate,
            {
                awarder: event.author.name,
                awardee: recipient,
                threshold: autoSuperuserThreshold.toString(),
                command: superUserCommand,

            }
        );

        await _replyToUser(
            context,
            recipient,
            message,
            parentComment.id,
            notifyOnAutoSuperuser
        );
    }
}

export async function _replyToUser(
    context: TriggerContext,
    toUserName: string,
    messageBody: string,
    commentId: string,
    replyMode: string
) {
    if (replyMode === "none") return;

    if (replyMode === "replybypm") {
        const subredditName =
            context.subredditName ??
            (await context.reddit.getCurrentSubredditName());
        try {
            await context.reddit.sendPrivateMessage({
                subject: `Message from TheRepBot on ${subredditName}`,
                text: messageBody,
                to: toUserName,
            });
            console.log(`${commentId}: PM sent to ${toUserName}.`);
        } catch {
            console.log(
                `${commentId}: Error sending PM to ${toUserName}. User may only allow PMs from whitelisted users.`
            );
        }
    } else if (replyMode === "replybycomment") {
        const newComment = await context.reddit.submitComment({
            id: commentId,
            text: messageBody,
        });
        await Promise.all([newComment.distinguish(), newComment.lock()]);
        console.log(
            `${commentId}: Public comment reply left for ${toUserName}`
        );
    } else {
        console.warn(`${commentId}: Unknown replyMode "${replyMode}"`);
    }
}

export async function getParentComment(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext
): Promise<Comment | undefined> {
    let parentComment: Comment | undefined;
    if (!event.comment) return undefined;
    try {
        parentComment = await context.reddit.getCommentById(
            event.comment.parentId
        );
        return parentComment;
    } catch {
        parentComment = undefined;
    }
    if (!parentComment) {
        logger.warn("❌ Parent comment not found.");
        return undefined;
    }
}
