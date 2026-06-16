import {
    Context,
    Devvit,
    FormField,
    FormOnSubmitEvent,
    JSONObject,
    MenuItemOnPressEvent,
    User,
} from "@devvit/public-api";
import { appSettings } from "./settings";
import { onAppFirstInstall, onAppInstallOrUpgrade } from "./installEvents";
import { modLeaderboardInfoJob, updateLeaderboard } from "./leaderboard";
import { cleanupDeletedAccounts } from "./cleanupTasks";
import {
    ADHOC_CLEANUP_JOB,
    ADHOC_POST_OF_THE_MONTH_JOB,
    CLEANUP_JOB,
    UPDATE_LEADERBOARD_JOB,
    UPDATE_MODINFO_JOB,
    UPGRADE_NOTIFIER_JOB,
} from "./constants";
import { handleConfirmReply } from "./utility";
import { handleThanksEvent } from "./triggers/comment/on-comment-trigger";
import { onPostSubmit } from "./triggers/post-logic/postSubmitEvent";
import {
    handleManualPointSetting,
    handleManualPostRestrictionRemoval,
    handlePostRestrictionCheck,
    handleUserRestrictionCheck,
    manualPostRestrictionRemovalHandler,
    manualSetPointsFormHandler,
} from "./triggers/utils/mod-utilities";
import { logger } from "./logger";
import { addPostOfTheMonthFlair } from "./postOfTheMonth";
import { checkForUpdates } from "./upgradeNotify/upgradeNotifier";
import { checkForUpdatesCommentSubmit } from "./upgradeNotify/upgradeNotifierComment";

Devvit.addSettings(appSettings);

// Figure out why this doesn't work because of having "events" instead of "event"
Devvit.addTrigger({
    events: ["CommentSubmit", "CommentUpdate"],
    onEvent: handleThanksEvent,
});

Devvit.addTrigger({
    events: ["CommentSubmit", "CommentUpdate"],
    onEvent: checkForUpdatesCommentSubmit,
});

Devvit.addTrigger({
    event: "PostSubmit",
    onEvent: onPostSubmit,
});

Devvit.addTrigger({
    event: "AppInstall",
    onEvent: onAppFirstInstall,
});

Devvit.addTrigger({
    events: ["AppInstall", "AppUpgrade"],
    onEvent: onAppInstallOrUpgrade,
});

Devvit.addSchedulerJob({
    name: UPGRADE_NOTIFIER_JOB,
    onRun: checkForUpdates,
});

Devvit.addTrigger({
    event: "CommentUpdate",
    onEvent: handleConfirmReply,
});

Devvit.addSchedulerJob({
    name: UPDATE_MODINFO_JOB,
    onRun: modLeaderboardInfoJob,
});
Devvit.addSchedulerJob({
    name: UPDATE_LEADERBOARD_JOB,
    onRun: updateLeaderboard,
});

Devvit.addSchedulerJob({
    name: CLEANUP_JOB,
    onRun: cleanupDeletedAccounts,
});

Devvit.addSchedulerJob({
    name: ADHOC_POST_OF_THE_MONTH_JOB,
    onRun: addPostOfTheMonthFlair,
});

Devvit.addSchedulerJob({
    name: ADHOC_CLEANUP_JOB,
    onRun: cleanupDeletedAccounts,
});

export const manualSetPointsForm = Devvit.createForm(
    (data) => ({ fields: data.fields as FormField[] }),
    manualSetPointsFormHandler,
);

export const manualSetFlairManagementForm = Devvit.createForm(
    (data) => ({ fields: data.fields as FormField[] }),
    manualSetFlairManagementFormHandler,
);
export const manualSetFlairManagementForUserForm = Devvit.createForm(
    (data) => ({ fields: data.fields as FormField[] }),
    manualSetFlairManagementForUserFormHandler,
);

export const manualPostRestrictionRemovalForm = Devvit.createForm(
    (data) => ({ fields: data.fields as FormField[] }),
    manualPostRestrictionRemovalHandler,
);

Devvit.addMenuItem({
    label: "[RepBot] - Set Flair Management For Specified User",
    forUserType: "moderator",
    location: "subreddit",
    onPress: handleFlairToggleForUser,
});

Devvit.addMenuItem({
    label: "[RepBot] - Remove post restriction from user",
    forUserType: "moderator",
    location: "post",
    onPress: handleManualPostRestrictionRemoval,
});

Devvit.addMenuItem({
    label: "[RepBot] - Check Posting Restriction",
    location: "post",
    onPress: handlePostRestrictionCheck,
});

Devvit.addMenuItem({
    label: "[RepBot] - Check User Restriction",
    location: "comment",
    forUserType: "moderator",
    onPress: handleUserRestrictionCheck,
});

Devvit.addMenuItem({
    label: "[RepBot] - Check User Restriction",
    location: "post",
    forUserType: "moderator",
    onPress: handleUserRestrictionCheck,
});

Devvit.addMenuItem({
    label: "[RepBot] - Pin Comment",
    location: "comment",
    forUserType: "moderator",
    onPress: handleCommentPin,
});

Devvit.addMenuItem({
    label: "[RepBot] - Check Flair Management For User",
    forUserType: "moderator",
    location: "comment",
    onPress: checkFlairToggle,
});

Devvit.addMenuItem({
    label: "[RepBot] - Check Flair Management For User",
    forUserType: "moderator",
    location: "post",
    onPress: checkFlairToggle,
});

Devvit.addMenuItem({
    label: "[RepBot] - Toggle Flair Management For User",
    forUserType: "moderator",
    location: "comment",
    onPress: handleFlairToggle,
});

Devvit.addMenuItem({
    label: "[RepBot] - Toggle Flair Management For User",
    forUserType: "moderator",
    location: "post",
    onPress: handleFlairToggle,
});

Devvit.addMenuItem({
    label: "[RepBot] - Set Score Manually",
    forUserType: "moderator",
    location: "comment",
    onPress: handleManualPointSetting,
});

export async function handleCommentPin(
    event: MenuItemOnPressEvent,
    context: Context,
): Promise<void> {
    if (event.location !== "comment" || !event.targetId) {
        context.ui.showToast({
            text: "Invalid comment target.",
        });
        return;
    }

    try {
        const comment = await context.reddit.getCommentById(event.targetId);
        if (!comment) {
            context.ui.showToast({
                text: "Comment not found.",
            });
            return;
        }

        const appUser = await context.reddit.getAppUser();

        if (comment.authorName !== appUser.username) {
            context.ui.showToast({
                text: "Only comments created by u/therepbot can be pinned.",
            });
            logger.warn("❌ Attempted to pin non-bot comment", {
                commentAuthor: comment.authorName,
                botUsername: appUser.username,
            });
            return;
        }

        // 🔒 Must be a top-level comment (parent is the post)
        if (!comment.parentId?.startsWith("t3_")) {
            context.ui.showToast({
                text: "Only top-level comments can be pinned.",
            });
            await logger.error(
                `❌ Attempted to pin comment that isn't top-level`,
            );
            return;
        }

        if (comment.isStickied()) {
            context.ui.showToast({
                text: "This comment is already pinned.",
            });
            await logger.error(
                `❌ Attempted to pin comment that is already stickied`,
            );
            return;
        }
        await comment.distinguish(true);

        context.ui.showToast({
            text: "Comment pinned successfully",
        });

        logger.info("📌 Comment pinned", {
            commentId: comment.id,
        });
    } catch (err) {
        await logger.error("❌ Failed to pin comment", {
            commentId: event.targetId,
            error: String(err),
        });

        context.ui.showToast({
            text: "Failed to pin comment.",
        });
    }
}

export async function handleFlairToggle(
    event: MenuItemOnPressEvent,
    context: Context,
) {
    try {
        if (!event.targetId || !event.location) {
            context.ui.showToast("Invalid target.");
            return;
        }

        let username: string | null = null;

        if (event.location === "comment") {
            const comment = await context.reddit.getCommentById(event.targetId);
            username = comment?.authorName ?? null;
        } else if (event.location === "post") {
            const post = await context.reddit.getPostById(event.targetId);
            username = post?.authorName ?? null;
        }

        if (!username) {
            context.ui.showToast(
                "Cannot toggle flair. User may be shadowbanned.",
            );
            return;
        }

        let currentValue = "";

        const key = `flairToggle:${username}`;
        const exists = await context.redis.exists(key);

        if (exists) {
            currentValue = "disabled";
        } else {
            currentValue = "enabled";
        }

        const fields = [
            {
                name: "isEnabled",
                type: "string",
                label: `Flair management for u/${username}`,
                defaultValue: currentValue,
                helpText:
                    "Case insensitive. 'enabled' = bot manages flair, 'disabled' = bot will not manage flair",
                required: true,
            },
        ];

        context.ui.showForm(manualSetFlairManagementForm, { fields });
    } catch (err) {
        logger.error("❌ Failed to toggle flair management", {
            error: String(err),
        });

        context.ui.showToast(
            "An error occurred while toggling flair management.",
        );
    }
}

export async function checkFlairToggle(
    event: MenuItemOnPressEvent,
    context: Context,
): Promise<void> {
    if (!event.targetId) {
        context.ui.showToast("Invalid target.");
        return;
    }

    const username = await getAuthorFromTarget(context, event.targetId);

    if (!username) {
        context.ui.showToast("Could not resolve user.");
        return;
    }

    const key = `flairToggle:${username}`;
    const exists = await context.redis.exists(key);

    if (exists) {
        context.ui.showToast(
            `Flair management is currently disabled for u/${username}`,
        );
    } else {
        context.ui.showToast(
            `Flair management is currently enabled for u/${username}`,
        );
    }
}

export async function getAuthorFromTarget(
    context: Context,
    targetId: string,
): Promise<string | null> {
    try {
        // Try comment first
        const comment = await context.reddit.getCommentById(targetId);
        return comment?.authorName ?? null;
    } catch {}

    try {
        // Try post fallback
        const post = await context.reddit.getPostById(targetId);
        return post?.authorName ?? null;
    } catch {}

    return null;
}

export async function manualSetFlairManagementFormHandler(
    event: FormOnSubmitEvent<JSONObject>,
    context: Context,
) {
    const value = event.values.isEnabled as string | undefined;
    if (!value) {
        context.ui.showToast("Your entry must contain a value.");
        return;
    }
    const enabled = /^enabled$/i;
    const disabled = /^disabled$/i;
    if (disabled.test(value) && !enabled.test(value)) {
        context.ui.showToast(`You must enter "enabled" or "disabled"`);
        return;
    }

    // 🔍 Resolve user from target
    let username: string | null = null;

    try {
        if (context.commentId) {
            const comment = await context.reddit.getCommentById(
                context.commentId,
            );
            username = comment?.authorName ?? null;
        } else if (context.postId) {
            const post = await context.reddit.getPostById(context.postId);
            username = post?.authorName ?? null;
        }
    } catch {}

    if (!username) {
        context.ui.showToast("Could not resolve user.");
        return;
    }

    let user: User | undefined;
    try {
        user = await context.reddit.getUserByUsername(username);
    } catch {}

    if (!user) {
        context.ui.showToast("User may be shadowbanned.");
        return;
    }

    const key = `flairToggle:${user.username}`;

    // enabled = no key
    if (enabled.test(value)) {
        await context.redis.del(key);
    } else {
        await context.redis.set(key, "disabled");
    }

    context.ui.showToast(
        `Flair management for u/${user.username} is now ${value}`,
    );
}

export async function handleFlairToggleForUser(
    _: MenuItemOnPressEvent,
    context: Context,
) {
    try {
        const fields = [
            {
                name: "target",
                type: "string",
                label: "Target Username (no u/)",
                defaultValue: "",
                helpText:
                    "Case insensitive. The username of the user you want to toggle flair management for",
                required: true,
            },
            {
                name: "isEnabled",
                type: "string",
                label: `Set Flair Management Status`,
                defaultValue: "",
                helpText:
                    "Case insensitive. 'enabled' = bot manages flair, 'disabled' = bot will not manage flair",
                required: true,
            },
        ];

        context.ui.showForm(manualSetFlairManagementForUserForm, { fields });
    } catch (err) {
        logger.error("❌ Failed to toggle flair management", {
            error: String(err),
        });

        context.ui.showToast(
            "An error occurred while toggling flair management.",
        );
    }
}

export async function manualSetFlairManagementForUserFormHandler(
    event: FormOnSubmitEvent<JSONObject>,
    context: Context,
) {
    const isEnabled = event.values.isEnabled as string | undefined;
    const target = event.values.target as string | undefined;

    if (!isEnabled) {
        context.ui.showToast("Enablement status is required.");
        return;
    }

    if (!target) {
        context.ui.showToast("Target user is required.");
        return;
    }

    const enabled = /^enabled$/i;
    const disabled = /^disabled$/i;

    if (!disabled.test(isEnabled) && !enabled.test(isEnabled)) {
        context.ui.showToast(`You must enter "enabled" or "disabled"`);
        return;
    }

    const userRegex = /^[a-z0-9\_\-]{3,21}$/i;

    if (!userRegex.test(target)) {
        context.ui.showToast(
            "Username must be between 3 and 21 characters long and contain only letters, numbers, underscores, or hyphens.",
        );
        return;
    }

    // 🔍 Resolve user from target
    const key = `flairToggle:${target}`;

    // enabled = no key
    if (enabled.test(isEnabled)) {
        await context.redis.del(key);
    } else {
        await context.redis.set(key, "disabled");
    }

    context.ui.showToast(
        `Flair management for u/${target} is now ${isEnabled}`,
    );
}

Devvit.configure({
    redditAPI: true,
    redis: true,
});

export default Devvit;
