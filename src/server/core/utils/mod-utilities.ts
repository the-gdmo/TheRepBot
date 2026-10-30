import { reddit, redis, scheduler, settings } from "@devvit/web/server";
import type { Context, User } from "@devvit/web/server";
import type { MenuItemRequest } from "@devvit/web/shared";

import { showToast, showForm } from "../request-context";
import { logger } from "./logger";
import {
    getAwardsRequiredKey,
    requiredKeyExists,
    restrictedKeyExists,
} from "./redisKeys";
import {
    manualPostRestrictionRemovalForm,
    manualSetPointsForm,
    manualSetUserWikiTotalsForm,
} from "../moderation";
import { getCurrentScore } from "./user-utilities";
import type { ScoreResult } from "./common-utilities";
import { getUserWikiLifetimeTotalsForUser, setUserWikiLifetimeTotalsForUser } from "../clientCore/leaderboard";
import { setUserScore } from "../clientCore/triggers/handlePostOrComment";
import { UPDATE_LEADERBOARD_JOB } from "../clientCore/constants";

type JSONObject = Record<string, any>;

type FormOnSubmitEvent<T extends Record<string, any> = Record<string, any>> = {
    values: T;
    data?: Record<string, unknown>;
};

export async function handleUserRestrictionCheck(
    event: MenuItemRequest,
    context: Context
): Promise<void> {
    let contentType: "post" | "comment" | undefined;
    let targetId: string | undefined;
    let targetAuthor: string | undefined;

    if (event.location === "post" && event.targetId) {
        contentType = "post";
        targetId = event.targetId;

        const post = await reddit.getPostById(targetId as `t3_${string}`);

        targetAuthor = post?.authorName;
    }

    if (event.location === "comment" && event.targetId) {
        contentType = "comment";
        targetId = event.targetId;

        const comment = await reddit.getCommentById(targetId as `t1_${string}`);

        targetAuthor = comment?.authorName;
    }

    if (!contentType || !targetId || !targetAuthor) {
        showToast(context, "Unable to determine target content or author");
        return;
    }

    const user = await reddit.getUserByUsername(targetAuthor);

    if (!user) {
        showToast(context, "Unable to resolve the target user");
        return;
    }

    const settingAwardsRequiredToCreateNewPosts = await settings.get(
        "awardsRequiredToCreateNewPosts"
    );

    const settingModeratorsExempt = await settings.get("moderatorsExempt");

    const awardsRequired =
        (settingAwardsRequiredToCreateNewPosts as number) ?? 0;

    if (awardsRequired <= 0) {
        showToast(context, "Awarding is not required to post");
        return;
    }

    const awardsRequiredKey = await getAwardsRequiredKey(user);
    const raw = await redis.get(awardsRequiredKey);

    const restrictedFlagExists = await restrictedKeyExists(
        targetAuthor
    );

    const subreddit = await reddit.getCurrentSubreddit();
    const subredditName = subreddit.name;
    const modsExempt = (settingModeratorsExempt as boolean) ?? true;

    const filteredModeratorList = await reddit
        .getModerators({
            subredditName,
            username: targetAuthor,
        })
        .all();

    const isMod = filteredModeratorList.length > 0;

    if (modsExempt && isMod) {
        showToast(context, "Mods are exempt from restriction");
        return;
    }

    if (!restrictedFlagExists) {
        showToast(context, `${targetAuthor} is not restricted`);
        return;
    }

    const currentCount = Number(raw) || 0;

    showToast(
        context,
        `${currentCount}/${awardsRequired} awards given by ${targetAuthor}`
    );
}

export async function handlePostRestrictionCheck(
    event: MenuItemRequest,
    context: Context
): Promise<void> {
    if (event.location !== "post" || !event.targetId) {
        showToast(context, "Select a post to check its restriction");
        return;
    }

    const post = await reddit.getPostById(event.targetId as `t3_${string}`);

    if (!post?.authorName) {
        showToast(context, "Unable to determine post author");
        return;
    }

    const user = await reddit.getUserByUsername(post.authorName);

    if (!user) {
        showToast(context, "Unable to resolve the post author");
        return;
    }

    const settingAwardsRequiredToCreateNewPosts = await settings.get(
        "awardsRequiredToCreateNewPosts"
    );

    const settingModeratorsExempt = await settings.get("moderatorsExempt");

    const awardsRequired =
        (settingAwardsRequiredToCreateNewPosts as number) ?? 0;

    if (awardsRequired <= 0) {
        showToast(context, "Awarding is not required to post");
        return;
    }

    const awardsRequiredKey = await getAwardsRequiredKey(user);
    const raw = await redis.get(awardsRequiredKey);

    const restrictedFlagExists = await restrictedKeyExists(
        user.username
    );

    const subreddit = await reddit.getCurrentSubreddit();
    const subredditName = subreddit.name;

    const modsExempt = (settingModeratorsExempt as boolean) ?? true;

    const filteredModeratorList = await reddit
        .getModerators({
            subredditName,
            username: user.username,
        })
        .all();

    const isMod = filteredModeratorList.length > 0;

    logger.info("Post restriction check", {
        username: user.username,
        modListLength: filteredModeratorList.length,
        isMod,
    });

    if (modsExempt && isMod) {
        showToast(context, "Mods are exempt from restriction");
        return;
    }

    if (!restrictedFlagExists) {
        showToast(context, `${user.username} is not restricted`);
        return;
    }

    const currentCount = Number(raw) || 0;

    showToast(
        context,
        `${currentCount}/${awardsRequired} awards given by ${user.username}`
    );
}

export async function resolveMenuTargetUsername(
    event: MenuItemRequest,
    _context: Context
): Promise<string | undefined> {
    if (!event.targetId) {
        return undefined;
    }

    if (event.location === "comment") {
        const comment = await reddit.getCommentById(
            event.targetId as `t1_${string}`
        );

        return comment?.authorName;
    }

    if (event.location === "post") {
        const post = await reddit.getPostById(event.targetId as `t3_${string}`);

        return post?.authorName;
    }

    return undefined;
}

export async function resolveFormTargetUsername(
    context: Context
): Promise<string | undefined> {
    if (context.commentId) {
        const comment = await reddit.getCommentById(
            context.commentId as `t1_${string}`
        );

        return comment?.authorName;
    }

    if (context.postId) {
        const post = await reddit.getPostById(context.postId as `t3_${string}`);

        return post?.authorName;
    }

    return undefined;
}

export function wholeNumberFormValue(value: unknown): number | undefined {
    if (typeof value !== "number" && typeof value !== "string") {
        return undefined;
    }

    if (typeof value === "string" && value.trim() === "") {
        return undefined;
    }

    const parsed = Number(value);

    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function handleManualUserWikiTotalsSetting(
    event: MenuItemRequest,
    context: Context
): Promise<void> {
    try {
        const targetAuthor = await resolveMenuTargetUsername(event, context);

        if (!targetAuthor || targetAuthor === "[deleted]") {
            showToast(context, "Unable to determine the target user");
            return;
        }

        let user: User | undefined;

        try {
            user = await reddit.getUserByUsername(targetAuthor);
        } catch {
            // Deleted or unavailable users cannot be targeted.
        }

        if (!user) {
            showToast(
                context,
                "Cannot set wiki totals. User may be deleted or shadowbanned"
            );
            return;
        }

        const settingUsersWhoCannotAwardPoints = await settings.get(
            "usersWhoCantAwardPoints"
        );

        const blockedUsersRaw =
            (settingUsersWhoCannotAwardPoints as string) ?? "";

        const blockedUsers = blockedUsersRaw
            .split(/\r?\n/)
            .map((username) => username.trim())
            .filter(Boolean);

        for (const blockedUser of blockedUsers) {
            if (blockedUser.toLowerCase() === user.username.toLowerCase()) {
                showToast(
                    context,
                    `u/${user.username}'s user data cannot be set`
                );
                return;
            }
        }

        const currentTotals = await getUserWikiLifetimeTotalsForUser(
            user.username
        );

        const fields = [
            {
                name: "receivedTotal",
                type: "number",
                defaultValue: currentTotals.received,
                label: `Lifetime received total for u/${user.username}`,
                helpText:
                    "Whole number, 0 or higher. This changes the lifetime wiki total without deleting history rows",
                required: true,
            },
            {
                name: "givenTotal",
                type: "number",
                defaultValue: currentTotals.given,
                label: `Lifetime given total for u/${user.username}`,
                helpText:
                    "Whole number, 0 or higher. Future awards will increment from this corrected total",
                required: true,
            },
        ];

        showForm(context, manualSetUserWikiTotalsForm, { fields });
    } catch (error) {
        logger.error("Failed to open user wiki total form", {
            targetId: event.targetId,
            location: event.location,
            error: String(error),
        });

        showToast(context, "Unable to load the user's wiki totals");
    }
}

export async function manualSetUserWikiTotalsFormHandler(
    event: FormOnSubmitEvent<JSONObject>,
    context: Context
): Promise<void> {
    const received = wholeNumberFormValue(event.values.receivedTotal);
    const given = wholeNumberFormValue(event.values.givenTotal);

    if (received === undefined || given === undefined) {
        showToast(
            context,
            "Given and received totals must both be whole numbers of 0 or higher"
        );
        return;
    }

    try {
        const targetAuthor = await resolveFormTargetUsername(context);

        if (!targetAuthor || targetAuthor === "[deleted]") {
            showToast(context, "Unable to determine the target user");
            return;
        }

        let user: User | undefined;

        try {
            user = await reddit.getUserByUsername(targetAuthor);
        } catch {
            // The user may no longer be available.
        }

        if (!user) {
            showToast(
                context,
                "Cannot set wiki totals. User may be deleted or shadowbanned"
            );
            return;
        }

        await setUserWikiLifetimeTotalsForUser(
            user.username,
            { received, given }
        );

        logger.info("Moderator changed user wiki totals", {
            username: user.username,
            received,
            given,
        });

        showToast(
            context,
            `u/${user.username}: received ${received}, given ${given}`
        );
    } catch (error) {
        logger.error("Failed to set user wiki totals", {
            error: String(error),
            received,
            given,
        });

        showToast(context, "Failed to update the user's wiki totals");
    }
}

export async function handleManualPointSetting(
    event: MenuItemRequest,
    context: Context
): Promise<void> {
    const targetAuthor = await resolveMenuTargetUsername(event, context);

    if (!targetAuthor || targetAuthor === "[deleted]") {
        showToast(context, "Unable to determine the target user");
        return;
    }

    let user: User | undefined;

    try {
        user = await reddit.getUserByUsername(targetAuthor);
    } catch {
        // The user may not be available.
    }

    if (!user) {
        showToast(context, "Cannot set points. User may be shadowbanned");
        return;
    }

    const currentScore = await getCurrentScore(user);

    if (!currentScore) {
        showToast(context, "Unable to retrieve current score for user");
        return;
    }

    const fields = [
        {
            name: "newScore",
            type: "number",
            defaultValue: currentScore.score,
            label: `Enter a new score for ${targetAuthor}`,
            helpText:
                "Warning: This will overwrite the score that currently exists",
            multiSelect: false,
            required: true,
        },
    ];

    showForm(context, manualSetPointsForm, { fields });
}

export async function manualSetPointsFormHandler(
    event: FormOnSubmitEvent<JSONObject>,
    context: Context
): Promise<void> {
    const targetAuthor = await resolveFormTargetUsername(context);

    if (!targetAuthor || targetAuthor === "[deleted]") {
        showToast(context, "An error occurred setting the user's score");
        return;
    }

    const entry = event.values.newScore as number | undefined;

    if (
        typeof entry !== "number" ||
        !Number.isFinite(entry) ||
        !Number.isInteger(entry) ||
        entry < 0
    ) {
        showToast(context, "You must enter a whole-number score (0 or higher)");
        return;
    }

    let awardee: User | undefined;

    try {
        awardee = await reddit.getUserByUsername(targetAuthor);
    } catch {
        // The target user may no longer be available.
    }

    if (!awardee) {
        showToast(context, "Cannot set points. User may be shadowbanned");
        return;
    }

    let awarder: User | undefined;

    try {
        if (!context.username) {
            logger.error(
                "Could not find username in manualSetPointsFormHandler"
            );
            showToast(context, "Could not identify the moderator");
            return;
        }

        awarder = await reddit.getUserByUsername(context.username);
    } catch {
        // The current user could not be resolved.
    }

    if (!awarder) {
        showToast(
            context,
            "Cannot set score manually because the awarder could not be identified."
        );
        return;
    }

    const recipientKey = `flairToggle:${awardee.username}`;
    const recipientKeyExists = await redis.exists(recipientKey);

    const newScore: ScoreResult = {
        score: entry,
        userHasFlair: false,
        flairIsNumber: false,
        flairShouldBeManaged: !recipientKeyExists,
    };

    await setUserScore(awardee.username, awarder.username, newScore);

    await scheduler.runJob({
        name: UPDATE_LEADERBOARD_JOB,
        runAt: new Date(),
        data: {
            reason: `Updated score for ${awardee.username}. New score: ${entry}`,
        },
    });

    showToast(context, `Score for ${awardee.username} is now ${entry}`);
}

export async function handleManualPostRestrictionRemoval(
    event: MenuItemRequest,
    context: Context
): Promise<void> {
    if (event.location !== "post" || !event.targetId) {
        showToast(context, "Select a post to remove its restriction");
        return;
    }

    const post = await reddit.getPostById(event.targetId as `t3_${string}`);

    if (!post?.authorName) {
        showToast(context, "Unable to determine post author");
        return;
    }

    let user: User | undefined;

    try {
        user = await reddit.getUserByUsername(post.authorName);
    } catch {
        // The author may no longer be available.
    }

    if (!user) {
        showToast(
            context,
            "Cannot remove the restriction. User may be deleted or shadowbanned"
        );
        return;
    }

    const fields = [
        {
            name: "restrictionRemovalConfirmation",
            type: "string",
            defaultValue: "",
            label: `Confirm you wish to remove ${post.authorName}'s post restriction`,
            helpText: 'Type "confirm" (case insensitive) to confirm this',
            multiSelect: false,
            required: true,
        },
    ];

    showForm(context, manualPostRestrictionRemovalForm, { fields });
}

export async function manualPostRestrictionRemovalHandler(
    event: FormOnSubmitEvent<JSONObject>,
    context: Context
): Promise<void> {
    logger.debug("manualPostRestrictionRemovalHandler triggered", {
        event,
    });

    if (!context.postId) {
        showToast(context, "Unable to identify the post to update");
        logger.error("No postId in context for restriction removal.");
        return;
    }

    const confirmText = (
        event.values.restrictionRemovalConfirmation as string | undefined
    )?.trim();

    if (!confirmText) {
        showToast(context, 'You must type "confirm" to continue');
        return;
    }

    if (!/^confirm$/i.test(confirmText)) {
        showToast(context, 'You must type "confirm" (case insensitive)');

        logger.warn("Moderator failed confirmation input", {
            confirmText,
        });

        return;
    }

    const post = await reddit.getPostById(context.postId as `t3_${string}`);

    if (!post) {
        showToast(context, "Could not fetch post data");

        logger.error("Post not found for manualPostRestrictionRemovalHandler", {
            postId: context.postId,
        });

        return;
    }

    let user: User | undefined;

    try {
        user = await reddit.getUserByUsername(post.authorName);
    } catch (error) {
        logger.error("Failed to fetch post author", {
            authorName: post.authorName,
            error: String(error),
        });
    }

    if (!user) {
        showToast(
            context,
            "Cannot remove restriction. User may be deleted, suspended, or shadowbanned"
        );
        return;
    }

    const username = user.username;

    const restrictionKey = `restrictedUser:${username}`;
    const requiredKey = `awardsRequired:${username}`;
    const lastValidPostKey = `lastValidPost:${username}`;
    const lastValidTitleKey = `lastValidPostTitle:${username}`;
    const awaitingPostKey = `awaitingPost:${username}`;

    const restrictedFlagExists = await restrictedKeyExists(username);

    const requiredFlagExists = await requiredKeyExists(username);

    const isRestricted =
        Boolean(restrictedFlagExists) || Boolean(requiredFlagExists);

    if (!isRestricted) {
        showToast(context, `u/${username} is not currently restricted`);

        logger.info("No restriction found for user", { username });
        return;
    }

    if (restrictedFlagExists) {
        await updateAuthorRedisManualRestrictionRemoval(username);
    }

    if (requiredFlagExists) {
        await updateAuthorRedisManualRequirementRemoval(username);
    }

    await Promise.all([
        redis.del(lastValidPostKey),
        redis.del(lastValidTitleKey),
        redis.del(requiredKey),
        redis.del(restrictionKey),
        redis.del(awaitingPostKey),
    ]);

    logger.info("Restriction data removed from Redis", {
        username,
        removedKeys: [
            restrictionKey,
            requiredKey,
            lastValidPostKey,
            lastValidTitleKey,
            awaitingPostKey,
        ],
    });

    showToast(context, `Post restriction removed for u/${username}`);

    logger.info(`Manual post restriction removal successful for u/${username}`);
}

export async function updateAuthorRedisManualRestrictionRemoval(
    username: string
): Promise<void> {
    const restrictedKey = `restrictedUser:${username}`;
    const lastValidPostKey = `lastValidPost:${username}`;

    try {
        const deleted = await Promise.all([
            redis.del(restrictedKey),
            redis.del(lastValidPostKey),
        ]);

        logger.info("Manual restriction removal complete", {
            username,
            removedKeys: [restrictedKey, lastValidPostKey],
            results: deleted,
        });
    } catch (error) {
        logger.error("Error during manual restriction removal", {
            username,
            error: String(error),
        });
    }
}

export async function updateAuthorRedisManualRequirementRemoval(
    username: string
): Promise<void> {
    const requiredKey = `awardsRequired:${username}`;
    const lastValidPostKey = `lastValidPost:${username}`;

    try {
        const deleted = await Promise.all([
            redis.del(requiredKey),
            redis.del(lastValidPostKey),
        ]);

        logger.info("Manual requirement removal complete", {
            username,
            removedKeys: [requiredKey, lastValidPostKey],
            results: deleted,
        });
    } catch (error) {
        logger.error("Error during manual requirement removal", {
            username,
            error: String(error),
        });
    }
}
