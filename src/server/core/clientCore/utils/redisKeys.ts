import type { CommentCreate, CommentUpdate } from "@devvit/protos";
import { getTriggers } from "./common-utilities";
import { reddit, redis, User } from "@devvit/web/server";
export { POINTS_STORE_KEY } from "../../../../shared/constants";

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
    event: CommentCreate | CommentUpdate,
     
    value: string
): Promise<string> {
    const altDupKey = await getAltDupKey(event );

    return await redis.set(altDupKey, value);
}

export async function deleteAltDupKey(
    event: CommentCreate | CommentUpdate,
     
) {
    const altDupKey = await getAltDupKey(event );

    return await redis.del(altDupKey);
}

export async function getAltDupKey(
    event: CommentCreate | CommentUpdate,
     
): Promise<string> {
    if (!event.post || !event.comment || !event.subreddit) return "";
    const commentBodyRaw = event.comment.body ?? "";
    const commentBody = commentBodyRaw.toLowerCase();
    const allTriggers = await getTriggers(context);
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
    event: CommentCreate | CommentUpdate,
): Promise<number> {
    const modDupKey = await getModDupKey(event);

    return await redis.exists(modDupKey);
}

export async function deleteModDupKey(
    event: CommentCreate | CommentUpdate,
) {
    const modDupKey = await getModDupKey(event);

    return await redis.del(modDupKey);
}

export async function setModDupKey(
    event: CommentCreate | CommentUpdate,
    value: string
): Promise<string> {
    const modDupKey = await getModDupKey(event);

    return await redis.set(modDupKey, value);
}

export async function getModDupKey(
    event: CommentCreate | CommentUpdate,
): Promise<string> {
    if (!event.comment || !event.post || !event.subreddit) return "";
    let parentComment: Comment | undefined;
    try {
        parentComment = await reddit.getCommentById(
            event.comment.parentId as `t1_${string}`
        );
    } catch {
        parentComment = undefined;
        return "";
    }
    if (!parentComment) {
        return "";
    }
    return `modAward:${parentComment.id}:${event.post.id}:${event.subreddit.name}`;
}
