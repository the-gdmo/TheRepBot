import {
    Context,
    FormOnSubmitEvent,
    JSONObject,
    MenuItemOnPressEvent,
    SettingsValues,
    TriggerContext,
    User,
} from "@devvit/public-api";
import { logger } from "../../logger.js";
import {
    getAwardsRequiredKey,
    getRestrictedKey,
    POINTS_STORE_KEY,
    requiredKeyExists,
    restrictedKeyExists,
} from "../post-logic/redisKeys.js";
import {
    manualPostRestrictionRemovalForm,
    manualSetPointsForm,
} from "../../main.js";
import { AppSetting, ExistingFlairOverwriteHandling } from "../../settings.js";
import { getCurrentScore } from "../comment/comment-trigger-context.js";

export async function handleUserRestrictionCheck(
    event: MenuItemOnPressEvent,
    context: Context
) {
    let contentType: "post" | "comment" | undefined;
    let targetId: string | undefined;
    let targetAuthor: string | undefined;

    // ─────────────────────────────────────────────
    // Resolve content type + author
    // ─────────────────────────────────────────────
    if (event.location === "post" && event.targetId) {
        contentType = "post";
        targetId = event.targetId;

        const post = await context.reddit.getPostById(targetId);
        targetAuthor = post?.authorName;
    }

    if (event.location === "comment" && event.targetId) {
        contentType = "comment";
        targetId = event.targetId;

        const comment = await context.reddit.getCommentById(targetId);
        targetAuthor = comment?.authorName;
    }

    if (!contentType || !targetId || !targetAuthor) {
        context.ui.showToast({
            text: "Unable to determine target content or author.",
        });
        return;
    }

    // ─────────────────────────────────────────────
    // Fetch user being checked
    // ─────────────────────────────────────────────
    const user = await context.reddit.getUserByUsername(targetAuthor);
    if (!user) return;

    const settings = await context.settings.getAll();

    const awardsRequired =
        (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) ?? 0;

    // 🚫 No restriction system enabled
    if (awardsRequired <= 0) {
        context.ui.showToast({
            text: "Awarding is not required to post",
        });
        return;
    }

    const awardsRequiredKey = await getAwardsRequiredKey(user);
    const raw = await context.redis.get(awardsRequiredKey);

    const restrictedFlagExists = await restrictedKeyExists(
        context,
        targetAuthor
    );

    // ─────────────────────────────────────────────
    // Moderator exemption check
    // ─────────────────────────────────────────────
    const subreddit = await context.reddit.getCurrentSubreddit();
    const subredditName = subreddit.name;

    const modsExempt =
        (settings[AppSetting.ModeratorsExempt] as boolean) ?? true;

    const filteredModeratorList = await context.reddit
        .getModerators({
            subredditName,
            username: targetAuthor,
        })
        .all();

    const isMod = filteredModeratorList.length > 0;

    if (modsExempt && isMod) {
        context.ui.showToast({
            text: "Mods are exempt from restriction",
        });
        return;
    }

    // ─────────────────────────────────────────────
    // Restriction result
    // ─────────────────────────────────────────────
    if (!restrictedFlagExists) {
        context.ui.showToast({
            text: `${targetAuthor} is not restricted`,
        });
        return;
    }

    const currentCount = Number(raw) || 0;

    context.ui.showToast({
        text: `${currentCount}/${awardsRequired} awards given by ${targetAuthor}`,
    });
}

export async function handlePostRestrictionCheck(
    event: MenuItemOnPressEvent,
    context: Context
) {
    if (event.location === "post" && event.targetId) {
        const post = await context.reddit.getPostById(event.targetId);

        if (!post?.authorName) {
            context.ui.showToast({
                text: "Unable to determine post author.",
            });
            return;
        }

        const user = await context.reddit.getUserByUsername(post.authorName);

        if (!user) return;

        const settings = await context.settings.getAll();

        const awardsRequired =
            (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) ??
            0;

        // 🚫 No restriction system enabled
        if (awardsRequired <= 0) {
            context.ui.showToast({
                text: "Awarding is not required to post",
            });
            return;
        }

        const awardsRequiredKey = await getAwardsRequiredKey(user);
        const raw = await context.redis.get(awardsRequiredKey);
        const restrictedFlagExists = await restrictedKeyExists(
            context,
            user.username
        );

        const subreddit = await context.reddit.getCurrentSubreddit();
        const subredditName = subreddit.name;
        const username = await context.reddit.getCurrentUser();
        if (!username) return;

        logger.info(`Testing Vals:`, {
            username: username.username,
        });

        if (!username) {
            logger.warn("❌ No username found on menu event");
            return;
        }

        const modsExempt =
            (settings[AppSetting.ModeratorsExempt] as boolean) ?? true;

        const filteredModeratorList = await context.reddit
            .getModerators({ subredditName, username: username.username })
            .all();

        const isMod = filteredModeratorList.length > 0;

        logger.info("filteredModList/isMod:", {
            filteredModeratorList,
            modListLength: filteredModeratorList.length,
            isMod,
        });

        if (modsExempt && isMod) {
            context.ui.showToast({
                text: "Mods are exempt from restriction",
            });
            return;
        }

        // 🔓 Not restricted
        if (!restrictedFlagExists) {
            context.ui.showToast({
                text: "You are not restricted",
            });
            return;
        }

        const currentCount = Number(raw) || 0;

        // 🔒 Restricted
        context.ui.showToast({
            text: `${currentCount}/${awardsRequired} awards given`,
        });
    }
}

export async function handleManualPointSetting(
    event: MenuItemOnPressEvent,
    context: Context
) {
    const comment = await context.reddit.getCommentById(event.targetId);
    let user: User | undefined;
    try {
        user = await context.reddit.getUserByUsername(comment.authorName);
    } catch {
        //
    }

    if (!user) {
        context.ui.showToast("Cannot set points. User may be shadowbanned.");
        return;
    }

    const settings = await context.settings.getAll();
    const { currentScore } = await getCurrentScore(user, context, settings);

    const fields = [
        {
            name: "newScore",
            type: "number",
            defaultValue: currentScore,
            label: `Enter a new score for ${comment.authorName}`,
            helpText:
                "Warning: This will overwrite the score that currently exists",
            multiSelect: false,
            required: true,
        },
    ];

    context.ui.showForm(manualSetPointsForm, { fields });
}

async function updateAwardeeFlair(
    context: TriggerContext,
    subredditName: string,
    commentAuthor: string,
    newScore: number,
    settings: SettingsValues
) {
    const pointSymbol = (settings[AppSetting.PointSymbol] as string) ?? "";
    const flairSetting = ((settings[AppSetting.ExistingFlairHandling] as
        | string[]
        | undefined) ?? [
        ExistingFlairOverwriteHandling.OverwriteNumeric,
    ])[0] as ExistingFlairOverwriteHandling;

    // Make sure newScore is a safe primitive
    const scoreValue =
        newScore !== undefined && newScore !== null ? Number(newScore) : 0;

    let flairText = "";
    switch (flairSetting) {
        case ExistingFlairOverwriteHandling.OverwriteNumericSymbol:
            flairText = `${scoreValue}${pointSymbol}`;
            break;
        case ExistingFlairOverwriteHandling.OverwriteNumeric:
        default:
            flairText = `${scoreValue}`;
            break;
    }

    // CSS class + template logic
    let cssClass = settings[AppSetting.CSSClass] as string | undefined;
    let flairTemplate = settings[AppSetting.FlairTemplate] as
        | string
        | undefined;

    // If using a flair template, CSS class cannot be used
    if (flairTemplate) cssClass = undefined;

    try {
        await context.reddit.setUserFlair({
            subredditName,
            username: commentAuthor,
            cssClass,
            flairTemplateId: flairTemplate,
            text: flairText,
        });

        logger.info(
            `🧑‍🎨 Awardee flair updated: u/${commentAuthor} → (“${flairText}”)`
        );
    } catch (err) {
        logger.error("❌ Failed to update awardee flair", {
            user: commentAuthor,
            err,
        });
    }
}

export async function manualSetPointsFormHandler(
    event: FormOnSubmitEvent<JSONObject>,
    context: Context
) {
    if (!context.commentId) {
        context.ui.showToast("An error occurred setting the user's score.");
        return;
    }

    const entry = event.values.newScore as number | undefined;
    if (
        typeof entry !== "number" ||
        isNaN(entry) ||
        parseInt(entry.toString(), 10) < 0
    ) {
        context.ui.showToast("You must enter a new score (0 or higher)");
        return;
    }

    const comment = await context.reddit.getCommentById(context.commentId);

    let user: User | undefined;
    try {
        user = await context.reddit.getUserByUsername(comment.authorName);
    } catch {
        //
    }

    if (!user) {
        context.ui.showToast("Cannot set points. User may be shadowbanned.");
        return;
    }

    const settings = await context.settings.getAll();
    const subreddit = await context.reddit.getCurrentSubredditName();

    const redisKey = POINTS_STORE_KEY;

    // ✅ Overwrite the user's score directly
    await context.redis.zAdd(redisKey, {
        member: user.username,
        score: entry,
    });

    // Update flair based on new score
    await updateAwardeeFlair(
        context,
        subreddit,
        user.username,
        entry,
        settings
    );

    // Trigger leaderboard update
    await context.scheduler.runJob({
        name: "updateLeaderboard",
        runAt: new Date(),
        data: {
            reason: `Updated score for ${user.username}. New score: ${entry}`,
        },
    });

    context.ui.showToast(`Score for ${user.username} is now ${entry}`);
}

export async function handleManualPostRestrictionRemoval(
    event: MenuItemOnPressEvent,
    context: Context
) {
    const post = await context.reddit.getPostById(event.targetId);
    let user: User | undefined;
    try {
        user = await context.reddit.getUserByUsername(post.authorName);
    } catch {
        //
    }

    if (!user) {
        context.ui.showToast("Cannot set points. User may be shadowbanned.");
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

    context.ui.showForm(manualPostRestrictionRemovalForm, { fields });
}

// 🔹 This handler runs when a moderator uses the "Remove post restriction from user" menu item
export async function manualPostRestrictionRemovalHandler(
    event: FormOnSubmitEvent<JSONObject>,
    context: Context
) {
    logger.debug("🧩 manualPostRestrictionRemovalHandler triggered", { event });

    // 🔹 Validate that we're working with a post
    if (!context.postId) {
        context.ui.showToast("❌ Unable to identify the post to update.");
        logger.error("❌ No postId in context for restriction removal.");
        return;
    }

    // 🔹 Confirm moderator input
    const confirmText = (
        event.values.restrictionRemovalConfirmation as string | undefined
    )?.trim();
    if (!confirmText) return;

    const confirm = /^confirm$/i;
    if (!confirm.test(confirmText)) {
        context.ui.showToast(`⚠️ You must type "confirm" (case insensitive).`);
        logger.warn("⚠️ Moderator failed confirmation input.", { confirmText });
        return;
    }

    // 🔹 Fetch the post
    const post = await context.reddit.getPostById(context.postId);
    if (!post) {
        context.ui.showToast("❌ Could not fetch post data.");
        logger.error(
            "❌ Post not found for manualPostRestrictionRemovalHandler",
            {
                postId: context.postId,
            }
        );
        return;
    }

    // 🔹 Fetch post author
    let user: User | undefined;
    try {
        user = await context.reddit.getUserByUsername(post.authorName);
    } catch (err) {
        logger.error("❌ Failed to fetch post author", {
            authorName: post.authorName,
            err,
        });
    }

    if (!user) {
        context.ui.showToast(
            "⚠️ Cannot remove restriction. User may be deleted, suspended, or shadowbanned."
        );
        return;
    }

    const settings = await context.settings.getAll();
    const subreddit = await context.reddit.getCurrentSubredditName();

    // ──────────────── Redis Keys ────────────────
    const restrictionKey = `restrictedUser:${user.username}`;
    const requiredKey = `awardsRequired:${user.username}`;
    const lastValidPostKey = `lastValidPost:${user.username}`;
    const lastValidTitleKey = `lastValidPostTitle:${user.username}`;
    const awaitingPostKey = `awaitingPost:${user.username}`;

    // ──────────────── Check Restriction State ────────────────
    const authorName = user.username;
    const restrictedFlagExists = await restrictedKeyExists(context, authorName);
    const requiredFlagExists = await requiredKeyExists(context, authorName);

    const isRestricted = restrictedFlagExists || requiredFlagExists;
    if (!isRestricted) {
        context.ui.showToast(
            `ℹ️ u/${user.username} is not currently restricted.`
        );
        logger.info("ℹ️ No restriction found for user", {
            username: user.username,
        });
        return;
    }

    if (restrictedFlagExists > 0) {
        await updateAuthorRedisManualRestrictionRemoval(context, authorName);
    }
    if (requiredFlagExists) {
        await updateAuthorRedisManualRequirementRemoval(context, authorName);
    }
    // ──────────────── Remove All Restriction Data ────────────────
    await Promise.all([
        context.redis.del(lastValidPostKey),
        context.redis.del(lastValidTitleKey),
        context.redis.del(requiredKey),
        context.redis.del(restrictionKey),
        context.redis.del(awaitingPostKey),
    ]);

    logger.info("✅ Restriction fully removed from Redis", {
        username: user.username,
        removedKeys: [
            restrictionKey,
            requiredKey,
            lastValidPostKey,
            lastValidTitleKey,
            awaitingPostKey,
        ],
    });

    // ──────────────── Notify Moderator ────────────────
    context.ui.showToast(`✅ Post restriction removed for u/${user.username}.`);
    logger.info(
        `✅ Manual post restriction removal successful for u/${user.username}.`
    );
}

export async function updateAuthorRedisManualRestrictionRemoval(
    context: TriggerContext,
    username: string
) {
    const restrictedKey = `restrictedUser:${username}`;
    const lastValidPostKey = `lastValidPost:${username}`;

    try {
        const deleted = await Promise.all([
            context.redis.del(restrictedKey),
            context.redis.del(lastValidPostKey),
        ]);

        logger.info("🧹 Manual restriction removal complete", {
            username,
            removedKeys: [restrictedKey, lastValidPostKey],
            results: deleted,
        });
    } catch (err) {
        logger.error("❌ Error during manual restriction removal", {
            username,
            err,
        });
    }
}

export async function updateAuthorRedisManualRequirementRemoval(
    context: TriggerContext,
    username: string
) {
    const requiredKey = `awardsRequired:${username}`;
    const lastValidPostKey = `lastValidPost:${username}`;

    try {
        const deleted = await Promise.all([
            context.redis.del(requiredKey),
            context.redis.del(lastValidPostKey),
        ]);

        logger.info("🧹 Manual requirement removal complete", {
            username,
            removedKeys: [requiredKey, lastValidPostKey],
            results: deleted,
        });
    } catch (err) {
        logger.error("❌ Error during manual requirement removal", {
            username,
            err,
        });
    }
}
