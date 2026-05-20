import { CommentCreate, CommentUpdate } from "@devvit/protos";
import { Comment, TriggerContext, User } from "@devvit/public-api";
import { logger } from "../../logger";
import { escapeForRegex, getTriggers } from "./common-utilities";

export const POINTS_STORE_KEY = `thanksPointsStore`;

//------------------------
// LastValidPostTitle
//------------------------
export async function getLastValidPostTitleKey(
    userObj: User | undefined,
): Promise<string> {
    if (!userObj) return "";
    return `lastValidPostTitle:${userObj.username}`;
}
export async function deleteLastValidPostTitle(
    userObj: User | undefined,
    context: TriggerContext,
) {
    const lastValidPostTitle = await getLastValidPostTitleKey(userObj);
    await context.redis.del(lastValidPostTitle);
}
export async function setLastValidPostTitle(
    userObj: User | undefined,
    context: TriggerContext,
    value: string,
) {
    const lastValidPostTitle = await getLastValidPostTitleKey(userObj);
    await context.redis.set(lastValidPostTitle, value);
}

//------------------------
// Restricted User
//------------------------
export async function restrictedKeyExists(
    context: TriggerContext,
    userToCheck: string,
): Promise<number> {
    const restrictedKey = `restrictedUser:${userToCheck}`;

    // 0 if it doesn't exist
    // 1 if it does exist
    return await context.redis.exists(restrictedKey);
}
export async function getRestrictedKey(
    userObj: User | undefined,
): Promise<string> {
    if (!userObj) return "";
    return `restrictedUser:${userObj.username}`;
}
export async function deleteRestrictedKey(
    userObj: User | undefined,
    context: TriggerContext,
) {
    const restrictedKey = await getRestrictedKey(userObj);
    await context.redis.del(restrictedKey);
}
export async function setRestrictedKey(
    userObj: User | undefined,
    context: TriggerContext,
    value: string,
) {
    const restrictedKey = await getRestrictedKey(userObj);
    await context.redis.set(restrictedKey, value);
}

//------------------------
// Awards Required
//------------------------
export async function requiredKeyExists(
    context: TriggerContext,
    userToCheck: string,
): Promise<number> {
    const requiredKey = `awardsRequired:${userToCheck}`;
    return await context.redis.exists(requiredKey);
}

export async function getAwardsRequiredKey(
    userObj: User | undefined,
): Promise<string> {
    if (!userObj) return "";
    return `awardsRequired:${userObj.username}`;
}
export async function deleteAwardsRequiredKey(
    userObj: User | undefined,
    context: TriggerContext,
) {
    const lastValidPostTitle = await getAwardsRequiredKey(userObj);
    await context.redis.del(lastValidPostTitle);
}

export async function setAwardsRequiredKey(
    userObj: User | undefined,
    context: TriggerContext,
    value: string,
) {
    const awardsRequired = await getAwardsRequiredKey(userObj);
    await context.redis.set(awardsRequired, value);
}

//------------------------
// Last Valid Post
//------------------------
export async function getLastValidPostKey(
    userObj: User | undefined,
): Promise<string> {
    if (!userObj) return "";
    return `lastValidPost:${userObj.username}`;
}
export async function deleteLastValidPost(
    userObj: User | undefined,
    context: TriggerContext,
) {
    const lastValidPost = await getLastValidPostKey(userObj);
    await context.redis.del(lastValidPost);
}
export async function setLastValidPost(
    userObj: User | undefined,
    context: TriggerContext,
    value: string,
) {
    const lastValidPost = await getLastValidPostKey(userObj);
    await context.redis.set(lastValidPost, value);
}

//------------------------
// Flair Setting Toggle
//------------------------
export async function flairToggleKeyExists(
    context: TriggerContext,
    userObj: User | undefined,
): Promise<number | undefined> {
    if (!userObj) return;
    const flairToggleKey = `flairToggle:${userObj.username}`;
    return await context.redis.exists(flairToggleKey);
}
export async function getFlairToggleKey(
    userObj: User | undefined,
): Promise<string> {
    if (!userObj) return "";
    return `flairToggle:${userObj.username}`;
}
export async function deleteFlairToggleKey(
    userObj: User | undefined,
    context: TriggerContext,
) {
    const flairToggleKey = await getFlairToggleKey(userObj);
    await context.redis.del(flairToggleKey);
}
export async function setFlairToggleKey(
    userObj: User | undefined,
    context: TriggerContext,
    value: string,
) {
    const flairToggleKey = await getFlairToggleKey(userObj);
    await context.redis.set(flairToggleKey, value);
}

//------------------------
// Alt Duplicate
//------------------------
export async function setAltDupKey(
    event: CommentCreate | CommentUpdate,
    context: TriggerContext,
    value: string,
): Promise<string> {
    const altDupKey = await getAltDupKey(event, context);

    return await context.redis.set(altDupKey, value);
}

export async function deleteAltDupKey(
    event: CommentCreate | CommentUpdate,
    context: TriggerContext,
) {
    const altDupKey = await getAltDupKey(event, context);

    return await context.redis.del(altDupKey);
}

export async function getAltDupKey(
    event: CommentCreate | CommentUpdate,
    context: TriggerContext,
): Promise<string> {
    if (!event.post) return "";
    if (!event.comment) return "";
    const commentBodyRaw = event.comment.body ?? "";
    const commentBody = commentBodyRaw.toLowerCase();
    const allTriggers = await getTriggers(context);
    let mentionedUsername: string | undefined;
    // Regex: match valid ALT username with space + u/
    const triggerUsed = allTriggers.find((t) => commentBody.includes(t));
    if (!triggerUsed) return "";
    const validMatch = commentBody.match(
        new RegExp(
            `${escapeForRegex(triggerUsed)}\\s+u/([a-z0-9_-]{3,21})`,
            "i",
        ),
    );
    if (validMatch) {
        mentionedUsername = validMatch[1];
    }
    return `customAward-${event.post.id}-${mentionedUsername}`;
}

//------------------------
// Mod Duplicate
//------------------------
export async function modDupKeyExists(
    event: CommentCreate | CommentUpdate,
    context: TriggerContext,
): Promise<number> {
    const modDupKey = await getModDupKey(event, context);

    return await context.redis.exists(modDupKey);
}

export async function deleteModDupKey(
    event: CommentCreate | CommentUpdate,
    context: TriggerContext,
) {
    const modDupKey = await getModDupKey(event, context);

    return await context.redis.del(modDupKey);
}

export async function setModDupKey(
    event: CommentCreate | CommentUpdate,
    context: TriggerContext,
    value: string,
): Promise<string> {
    const modDupKey = await getModDupKey(event, context);

    return await context.redis.set(modDupKey, value);
}

export async function getModDupKey(
    event: CommentCreate | CommentUpdate,
    context: TriggerContext,
): Promise<string> {
    if (!event.comment) return "";
    let parentComment: Comment | undefined;
    try {
        parentComment = await context.reddit.getCommentById(
            event.comment.parentId,
        );
    } catch {
        parentComment = undefined;
        return "";
    }
    if (!parentComment) {
        logger.warn("❌ Parent comment not found.");
        return "";
    }
    return `modAward-${parentComment.id}`;
}
