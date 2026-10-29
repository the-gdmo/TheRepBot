import { Comment , reddit, redis, settings } from "@devvit/web/server";
import {
    getUserCanAward,
    getUserIsSuperuser,
    isModerator,
} from "../../../core/clientCore/utils/user-utilities";
import { logger } from "../../../core/clientCore/utils/logger";
import { formatMessage } from "../../../core/clientCore/utils/common-utilities";
import { OnCommentCreateRequest, OnCommentUpdateRequest, T1 } from "@devvit/web/shared";

const AUTO_SUPERUSER_TEMPLATE_DEFAULT =
    "Hello {awardee},\n\nNow that you have reached {threshold} points you can now award points yourself, even if normal users do not have permission to. Please use the command `{command}` if you'd like to do this.";

export class CommentTriggerContext {
    private _awarder: string | undefined = undefined;
    private _subredditName: string | undefined = undefined;
    private _isMod = false;
    private _isSuperUser = false;
    private _userCanAward = false;

    get userCanAward() {
        return this._userCanAward;
    }

    get awarder() {
        return this._awarder;
    }

    get subredditName() {
        return this._subredditName;
    }

    get isMod() {
        return this._isMod;
    }

    get isSuperUser() {
        return this._isSuperUser;
    }

    public async init(
        event: OnCommentCreateRequest | OnCommentUpdateRequest,
    ) {
        if (!event.author || !event.subreddit) return;

        this._awarder = event.author.name;
        this._subredditName = event.subreddit.name;
        this._isMod = await isModerator(
            this._subredditName,
            this._awarder
        );
        this._isSuperUser = await getUserIsSuperuser(this._awarder);
        this._userCanAward = await getUserCanAward(this._awarder);
    }
}

export async function userBecomesSuperUser(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    userScore: number,
) {
    if (!event.comment || !event.author) return;

    const parentComment = await getParentComment(event);
    if (!parentComment) return;

    const recipient = parentComment.authorName;
    if (!recipient) return;

    const settingAutoSuperuserThreshold = await settings.get<number>(
        "autoSuperuserThreshold"
    );
    const settingModAwardCommand = await settings.get<string>(
        "modAwardCommand"
    );
    const settingAutoSuperuserTemplate = await settings.get<string>(
        "AutoSuperuserTemplate"
    );
    const notifyOnAutoSuperuserMode =
        (await settings.get<string>("notifyOnAutoSuperuser")) ?? "none";

    const autoSuperuserThreshold = settingAutoSuperuserThreshold ?? 0;
    const superUserCommand = settingModAwardCommand ?? "";
    const template =
        settingAutoSuperuserTemplate ?? AUTO_SUPERUSER_TEMPLATE_DEFAULT;

    if (
        autoSuperuserThreshold <= 0 ||
        userScore < autoSuperuserThreshold ||
        notifyOnAutoSuperuserMode === "none"
    ) {
        return;
    }

    // Prevent duplicate notifications if multiple events arrive after the threshold is reached.
    const notificationKey = `autoSuperuserNotified:${recipient.toLowerCase()}`;
    if (await redis.exists(notificationKey)) return;

    let recipientUser;
    try {
        recipientUser = await reddit.getUserByUsername(recipient);
    } catch (err) {
        logger.warn("Could not look up auto-superuser notification recipient", {
            recipient,
            err,
        });
        return;
    }
    if (!recipientUser) return;

    const autoSuperUserMessage = formatMessage(event, template, {
        awarder: event.author.name,
        awardee: recipient,
        threshold: autoSuperuserThreshold.toString(),
        command: superUserCommand,
    });

    try {
        await _replyToUser(
            recipientUser.username,
            autoSuperUserMessage,
            parentComment.id,
            notifyOnAutoSuperuserMode
        );
        await redis.set(notificationKey, "1");
    } catch (err) {
        logger.error("Failed to send auto-superuser notification", {
            recipient,
            mode: notifyOnAutoSuperuserMode,
            err,
        });
    }
}

export async function _replyToUser(
    toUserName: string,
    messageBody: string,
    commentId: string,
    replyMode: string
) {
    const mode = replyMode.trim().toLowerCase();
    if (mode === "none" || mode === "") return;

    if (mode === "replybypm") {
        const subredditName = (await reddit.getCurrentSubreddit()).name;

        await reddit.sendPrivateMessage({
            subject: `Message from r/${subredditName}`,
            text: messageBody,
            to: toUserName,
        });

        logger.info("Auto-superuser private message sent", {
            commentId,
            toUserName,
        });
        return;
    }

    if (mode === "replybycomment") {
        // The key is based on the comment being replied to, so retries do not
        // create duplicate public replies.
        const redisKey = `shouldComment:${commentId}`;
        if (await redis.exists(redisKey)) {
            logger.info("A reply already exists for this comment", {
                commentId,
            });
            return;
        }

        const newComment = await reddit.submitComment({
            id: commentId as `t1_${string}`,
            text: messageBody,
        });
        await newComment.distinguish();
        await redis.set(redisKey, "1");

        logger.info("Auto-superuser public comment reply sent", {
            commentId,
            toUserName,
        });
        return;
    }

    logger.warn("Unknown auto-superuser notification mode", {
        commentId,
        replyMode,
    });
}

export async function getParentComment(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
): Promise<Comment | undefined> {
    if (!event.comment) return undefined;

    try {
        return await reddit.getCommentById(event.comment.parentId as T1);
    } catch (err) {
        logger.debug("Could not retrieve parent comment", {
            commentId: event.comment.id,
            parentId: event.comment.parentId,
            err,
        });
        return undefined;
    }
}
