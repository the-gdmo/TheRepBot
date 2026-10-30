import { formatMessage, getTriggers } from "./common-utilities";
import { Comment, reddit, redis, settings, User } from "@devvit/web/server";
import { logger } from "./logger";
import { OnCommentCreateRequest, OnCommentUpdateRequest, T1 } from "@devvit/web/shared";
import { getUserCanAward, getUserIsSuperuser, isModerator } from "./user-utilities";
export { POINTS_STORE_KEY } from "../../../shared/constants";

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

    let parentComment: Comment | undefined;
    try {
        parentComment = await reddit.getCommentById(event.comment.parentId as T1);
    } catch (err) {
        logger.debug("Could not retrieve parent comment", {
            commentId: event.comment.id,
            parentId: event.comment.parentId,
            err,
        });
        parentComment = undefined;
        return parentComment;
    }
}


//------------------------
// LastValidPostTitle
//------------------------
export async function getLastValidPostTitleKey(
    userObj: User | undefined
): Promise<string> {
    if (!userObj) return "";
    return `lastValidPostTitle:${userObj.username}`;
}
export async function deleteLastValidPostTitle(
    userObj: User | undefined,
) {
    const lastValidPostTitle = await getLastValidPostTitleKey(userObj);
    await redis.del(lastValidPostTitle);
}
export async function setLastValidPostTitle(
    userObj: User | undefined,
    value: string
) {
    const lastValidPostTitle = await getLastValidPostTitleKey(userObj);
    await redis.set(lastValidPostTitle, value);
}

//------------------------
// Restricted User
//------------------------
export async function restrictedKeyExists(
    userToCheck: string
): Promise<number> {
    const restrictedKey = `restrictedUser:${userToCheck}`;

    // 0 if it doesn't exist
    // 1 if it does exist
    return await redis.exists(restrictedKey);
}
export async function getRestrictedKey(
    userObj: User | undefined
): Promise<string> {
    if (!userObj) return "";
    return `restrictedUser:${userObj.username}`;
}
export async function deleteRestrictedKey(
    userObj: User | undefined,
) {
    const restrictedKey = await getRestrictedKey(userObj);
    await redis.del(restrictedKey);
}
export async function setRestrictedKey(
    userObj: User | undefined,
    value: string
) {
    const restrictedKey = await getRestrictedKey(userObj);
    await redis.set(restrictedKey, value);
}

//------------------------
// Awards Required
//------------------------
export async function requiredKeyExists(
    userToCheck: string
): Promise<number> {
    const requiredKey = `awardsRequired:${userToCheck}`;
    return await redis.exists(requiredKey);
}

export async function getAwardsRequiredKey(
    userObj: User | undefined
): Promise<string> {
    if (!userObj) return "";
    return `awardsRequired:${userObj.username}`;
}
export async function deleteAwardsRequiredKey(
    userObj: User | undefined,
) {
    const lastValidPostTitle = await getAwardsRequiredKey(userObj);
    await redis.del(lastValidPostTitle);
}

export async function setAwardsRequiredKey(
    userObj: User | undefined,
    value: string
) {
    const awardsRequired = await getAwardsRequiredKey(userObj);
    await redis.set(awardsRequired, value);
}

//------------------------
// Last Valid Post
//------------------------
export async function getLastValidPostKey(
    userObj: User | undefined
): Promise<string> {
    if (!userObj) return "";
    return `lastValidPost:${userObj.username}`;
}
export async function deleteLastValidPost(
    userObj: User | undefined,
) {
    const lastValidPost = await getLastValidPostKey(userObj);
    await redis.del(lastValidPost);
}
export async function setLastValidPost(
    userObj: User | undefined,
    value: string
) {
    const lastValidPost = await getLastValidPostKey(userObj);
    await redis.set(lastValidPost, value);
}

//------------------------
// Flair Setting Toggle
//------------------------
export async function flairToggleKeyExists(
    userObj: User | undefined
): Promise<number | undefined> {
    if (!userObj) return;
    const flairToggleKey = `flairToggle:${userObj.username}`;
    return await redis.exists(flairToggleKey);
}
export async function getFlairToggleKey(
    userObj: User | undefined
): Promise<string> {
    if (!userObj) return "";
    return `flairToggle:${userObj.username}`;
}
export async function deleteFlairToggleKey(
    userObj: User | undefined,
) {
    const flairToggleKey = await getFlairToggleKey(userObj);
    await redis.del(flairToggleKey);
}
export async function setFlairToggleKey(
    userObj: User | undefined,
    value: string
) {
    const flairToggleKey = await getFlairToggleKey(userObj);
    await redis.set(flairToggleKey, value);
}

//------------------------
// Alt Duplicate
//------------------------
export async function setAltDupKey(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    value: string
): Promise<string> {
    const altDupKey = await getAltDupKey(event);

    return await redis.set(altDupKey, value);
}

export async function deleteAltDupKey(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
) {
    const altDupKey = await getAltDupKey(event);

    return await redis.del(altDupKey);
}

export async function getAltDupKey(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
): Promise<string> {
    if (!event.post || !event.comment || !event.subreddit) return "";
    const commentBodyRaw = event.comment.body ?? "";
    const commentBody = commentBodyRaw.toLowerCase();
    const allTriggers = await getTriggers();
    let mentionedUsername: string | undefined;
    // Regex: match valid ALT username with space + u/
    const triggerUsed = allTriggers.find((t) => commentBody.includes(t));
    if (!triggerUsed) return "";
    const validMatch = commentBody.match(
        new RegExp(`${triggerUsed}\su/([a-z0-9_-]{3,21})`, "g")
    );
    if (validMatch) {
        mentionedUsername = validMatch[1];
    }
    return `customAward:${event.post.id}:${event.subreddit.name}:${mentionedUsername}`;
}

//------------------------
// Mod Duplicate
//------------------------
export async function modDupKeyExists(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
): Promise<number> {
    const modDupKey = await getModDupKey(event);

    return await redis.exists(modDupKey);
}

export async function deleteModDupKey(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
) {
    const modDupKey = await getModDupKey(event);

    return await redis.del(modDupKey);
}

export async function setModDupKey(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    value: string
): Promise<string> {
    const modDupKey = await getModDupKey(event);

    return await redis.set(modDupKey, value);
}

export async function getModDupKey(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
): Promise<string> {
    if (!event.comment || !event.post || !event.subreddit) return "";

    const parentComment = await getParentComment(event);
    if (!parentComment) return "";
    return `modAward:${parentComment.id}:${event.post.id}:${event.subreddit.name}`;
}
