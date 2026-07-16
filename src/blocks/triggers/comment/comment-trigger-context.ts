import { CommentSubmit, CommentUpdate } from "@devvit/protos";
import {
    Comment,
    SettingsValues,
    TriggerContext,
    User,
} from "@devvit/public-api";
import {
    getUserCanAward,
    getUserIsSuperuser,
    isModerator,
} from "../utils/user-utilities";
import { logger } from "../../logger";
import {
    AppSetting,
    AutoSuperuserReplyOptions,
    TemplateDefaults,
} from "../../settings";
import { formatMessage } from "../utils/common-utilities";
import { POINTS_STORE_KEY } from "../utils/redisKeys";

// src/triggers/comment/comment-trigger-context.ts
export class CommentTriggerContext {
    private _awarder: string | undefined = undefined;
    private _subredditName: string | undefined = undefined;
    private _isMod: boolean = false;
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
    // More getters where needed...

    public async init(
        event: CommentSubmit | CommentUpdate,
        context: TriggerContext,
    ) {
        if (!event.author) return;
        if (!event.subreddit) return;
        this._awarder = event.author.name;
        this._subredditName = event.subreddit.name;
        this._isMod = await isModerator(
            context,
            this._subredditName,
            this._awarder,
        );
        this._isSuperUser = await getUserIsSuperuser(context, this._awarder);
        this._userCanAward = await getUserCanAward(context, this._awarder);
        // More context setup
    }
}


export async function userBecomesSuperUser(
    event: CommentSubmit | CommentUpdate,
    userScore: number,
    context: TriggerContext,
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
    const superUserCommand =
        (settings[AppSetting.ModAwardCommand] as string) ?? "";
    const notifyOnAutoSuperuserMode = ((settings[
        AppSetting.NotifyOnAutoSuperuser
    ] as string[] | undefined) ?? [
        AutoSuperuserReplyOptions.NoReply,
    ])[0] as AutoSuperuserReplyOptions;
    if (
        autoSuperuserThreshold &&
        userScore === autoSuperuserThreshold &&
        notifyOnAutoSuperuserMode !== AutoSuperuserReplyOptions.NoReply
    ) {
        console.log(
            `${event.comment.id}: ${recipientUser.username} has reached the auto superuser threshold. Notifying.`,
        );
        (settings[AppSetting.AutoSuperuserTemplate] as string | undefined) ??
            TemplateDefaults.NotifyOnSuperuserTemplate;
        const message = formatMessage(event,
            (settings[AppSetting.AutoSuperuserTemplate] as string) ??
                TemplateDefaults.NotifyOnSuperuserTemplate,
            {
                awarder: event.author.name,
                awardee: recipient,
                threshold: autoSuperuserThreshold.toString(),
                command: superUserCommand,
            },
        );

        await _replyToUser(
            context,
            recipient,
            message,
            parentComment.id,
            notifyOnAutoSuperuserMode,
        );
    }
}

export async function _replyToUser(
    context: TriggerContext,
    toUserName: string,
    messageBody: string,
    commentId: string,
    replyMode: string,
) {
    if (replyMode === "none") return;

    if (replyMode === "replybypm") {
        const subredditName =
            context.subredditName ??
            (await context.reddit.getCurrentSubredditName());
        try {
            await context.reddit.sendPrivateMessage({
                subject: `Message from r/${subredditName}`,
                text: messageBody,
                to: toUserName,
            });
            console.log(`${commentId}: PM sent to ${toUserName}.`);
        } catch {
            console.log(
                `${commentId}: Error sending PM to ${toUserName}. User may only allow PMs from whitelisted users.`,
            );
        }
    } else if (replyMode === "replybycomment") {
        const redisKey = `shouldComment:${commentId}`;
        const parentCommentRespondedTo = await context.redis.exists(redisKey);

        if (parentCommentRespondedTo) {
            logger.info(`Response sent, returning.`);
            return;
        }

        await context.redis.set(redisKey, "1");

        const newComment = await context.reddit.submitComment({
            id: commentId,
            text: messageBody,
        });
        await Promise.all([newComment.distinguish()]);
        console.log(
            `${commentId}: Public comment reply left for ${toUserName}`,
        );
    } else {
        console.warn(`${commentId}: Unknown replyMode "${replyMode}"`);
    }
}

export async function getParentComment(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
): Promise<Comment | undefined> {
    let parentComment: Comment | undefined;
    if (!event.comment) return undefined;
    try {
        parentComment = await context.reddit.getCommentById(
            event.comment.parentId,
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
