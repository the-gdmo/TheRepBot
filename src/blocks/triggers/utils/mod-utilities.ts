import {
    Context,
    FormOnSubmitEvent,
    JSONObject,
    MenuItemOnPressEvent,
    TriggerContext,
    User,
} from "@devvit/public-api";
import { logger } from "../../logger";
import {
    getAwardsRequiredKey,
    requiredKeyExists,
    restrictedKeyExists,
} from "./redisKeys";
import {
    manualPostRestrictionRemovalForm,
    manualSetPointsForm,
    manualSetUserWikiTotalsForm,
} from "../../main";
import { AppSetting } from "../../settings";
import { getCurrentScore } from "./user-utilities";
import { setUserScore } from "../comment/on-comment-trigger";
import { ScoreResult } from "./common-utilities";
import {
    getUserWikiLifetimeTotalsForUser,
    setUserWikiLifetimeTotalsForUser,
} from "../../leaderboard";

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
            text: "Unable to determine target content or author",
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
                text: "Unable to determine post author",
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

async function resolveMenuTargetUsername(
    event: MenuItemOnPressEvent,
    context: Context
): Promise<string | undefined> {
    if (!event.targetId) return;

    if (event.location === "comment") {
        const comment = await context.reddit.getCommentById(event.targetId);
        return comment?.authorName;
    }

    if (event.location === "post") {
        const post = await context.reddit.getPostById(event.targetId);
        return post?.authorName;
    }
}

async function resolveFormTargetUsername(
    context: Context
): Promise<string | undefined> {
    if (context.commentId) {
        const comment = await context.reddit.getCommentById(context.commentId);
        return comment?.authorName;
    }

    if (context.postId) {
        const post = await context.reddit.getPostById(context.postId);
        return post?.authorName;
    }
}

function wholeNumberFormValue(value: unknown): number | undefined {
    if (typeof value !== "number" && typeof value !== "string") return;
    if (typeof value === "string" && value.trim() === "") return;

    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function handleManualUserWikiTotalsSetting(
    event: MenuItemOnPressEvent,
    context: Context
) {
    try {
        const targetAuthor = await resolveMenuTargetUsername(event, context);
        if (!targetAuthor || targetAuthor === "[deleted]") {
            context.ui.showToast("Unable to determine the target user");
            return;
        }

        let user: User | undefined;
        try {
            user = await context.reddit.getUserByUsername(targetAuthor);
        } catch {
            // Shadowbanned/deleted users cannot be safely targeted by this form.
        }

        if (!user) {
            context.ui.showToast(
                "Cannot set wiki totals. User may be deleted or shadowbanned"
            );
            return;
        }

        const settings = await context.settings.getAll();

        const blockedUsersRaw =
            (settings[AppSetting.UsersWhoCannotAwardPoints] as string) ?? "";

        const blockedUsers = blockedUsersRaw
            .split(/\r?\n/)
            .map((username) => username.trim())
            .filter(Boolean);

        for (const blockedUser of blockedUsers) {
            if (blockedUser.toLowerCase() === user.username.toLowerCase()) {
                context.ui.showToast(
                    `u/${user.username}'s user data cannot be set`
                );
                return;
            }
        }

        const currentTotals = await getUserWikiLifetimeTotalsForUser(
            context as unknown as TriggerContext,
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

        context.ui.showForm(manualSetUserWikiTotalsForm, { fields });
    } catch (err) {
        logger.error("❌ Failed to open user wiki total form", {
            targetId: event.targetId,
            location: event.location,
            error: String(err),
        });
        context.ui.showToast("Unable to load the user's wiki totals");
    }
}

export async function manualSetUserWikiTotalsFormHandler(
    event: FormOnSubmitEvent<JSONObject>,
    context: Context
) {
    const received = wholeNumberFormValue(event.values.receivedTotal);
    const given = wholeNumberFormValue(event.values.givenTotal);

    if (received === undefined || given === undefined) {
        context.ui.showToast(
            "Given and received totals must both be whole numbers of 0 or higher"
        );
        return;
    }

    try {
        const targetAuthor = await resolveFormTargetUsername(context);
        if (!targetAuthor || targetAuthor === "[deleted]") {
            context.ui.showToast("Unable to determine the target user");
            return;
        }

        let user: User | undefined;
        try {
            user = await context.reddit.getUserByUsername(targetAuthor);
        } catch {
            //
        }

        if (!user) {
            context.ui.showToast(
                "Cannot set wiki totals. User may be deleted or shadowbanned"
            );
            return;
        }

        await setUserWikiLifetimeTotalsForUser(
            context as unknown as TriggerContext,
            user.username,
            { received, given }
        );

        logger.info("🛡️ Moderator changed user wiki totals", {
            username: user.username,
            received,
            given,
        });

        context.ui.showToast(
            `u/${user.username}: received ${received}, given ${given}`
        );
    } catch (err) {
        logger.error("❌ Failed to set user wiki totals", {
            error: String(err),
            received,
            given,
        });
        context.ui.showToast("Failed to update the user's wiki totals");
    }
}

export async function handleManualPointSetting(
    event: MenuItemOnPressEvent,
    context: Context
) {
    const targetAuthor = await resolveMenuTargetUsername(event, context);

    if (!targetAuthor || targetAuthor === "[deleted]") {
        context.ui.showToast("Unable to determine the target user");
        return;
    }

    let user: User | undefined;
    try {
        user = await context.reddit.getUserByUsername(targetAuthor);
    } catch {
        //
    }

    if (!user) {
        context.ui.showToast("Cannot set points. User may be shadowbanned");
        return;
    }

    const currentScore = await getCurrentScore(user, context);

    if (!currentScore) {
        context.ui.showToast("Unable to retrieve current score for user");
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

    context.ui.showForm(manualSetPointsForm, { fields });
}

export async function manualSetPointsFormHandler(
    event: FormOnSubmitEvent<JSONObject>,
    context: Context
) {
    const targetAuthor = await resolveFormTargetUsername(context);
    if (!targetAuthor || targetAuthor === "[deleted]") {
        context.ui.showToast("An error occurred setting the user's score");
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

    let user: User | undefined;
    try {
        user = await context.reddit.getUserByUsername(targetAuthor);
    } catch {
        //
    }

    if (!user) {
        context.ui.showToast("Cannot set points. User may be shadowbanned");
        return;
    }

    let flairShouldBeManaged: boolean;

    const key = `flairToggle:${user.username}`;
    const exists = await context.redis.exists(key);

    if (exists) {
        flairShouldBeManaged = false;
    } else {
        flairShouldBeManaged = true;
    }

    // ✅ Overwrite the user's score directly
    const newScore: ScoreResult = {
        score: entry,
        userHasFlair: false,
        flairIsNumber: false,
        flairShouldBeManaged,
    };
    setUserScore(
        context,
        user.username,
        newScore,
        await context.settings.getAll()
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
        context.ui.showToast("Cannot set points. User may be shadowbanned");
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
        context.ui.showToast("❌ Unable to identify the post to update");
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
        context.ui.showToast(`⚠️ You must type "confirm" (case insensitive)`);
        logger.warn("⚠️ Moderator failed confirmation input.", { confirmText });
        return;
    }

    // 🔹 Fetch the post
    const post = await context.reddit.getPostById(context.postId);
    if (!post) {
        context.ui.showToast("❌ Could not fetch post data");
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
            "⚠️ Cannot remove restriction. User may be deleted, suspended, or shadowbanned"
        );
        return;
    }

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
            `ℹ️ u/${user.username} is not currently restricted`
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
    context.ui.showToast(`✅ Post restriction removed for u/${user.username}`);
    logger.info(
        `✅ Manual post restriction removal successful for u/${user.username}`
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
