import {
    Context,
    Devvit,
    FormField,
    MenuItemOnPressEvent,
} from "@devvit/public-api";
import {
    appSettings,
    validateRegexJobHandler,
} from "./settings";
import { onAppFirstInstall, onAppInstallOrUpgrade } from "./installEvents";
import { updateLeaderboard } from "./leaderboard";
import { cleanupDeletedAccounts } from "./cleanupTasks";
import {
    ADHOC_CLEANUP_JOB,
    ADHOC_POST_OF_THE_MONTH_JOB,
    CLEANUP_JOB,
    UPDATE_LEADERBOARD_JOB,
    VALIDATE_REGEX_JOB,
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

Devvit.addSettings(appSettings);

// Figure out why this doesn't work because of having "events" instead of "event"
Devvit.addTrigger({
    events: ["CommentSubmit", "CommentUpdate"],
    onEvent: handleThanksEvent,
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

Devvit.addTrigger({
    event: "CommentUpdate",
    onEvent: handleConfirmReply,
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

Devvit.addSchedulerJob({
    name: VALIDATE_REGEX_JOB,
    onRun: validateRegexJobHandler,
});

export const manualSetPointsForm = Devvit.createForm(
    (data) => ({ fields: data.fields as FormField[] }),
    manualSetPointsFormHandler
);

export const manualPostRestrictionRemovalForm = Devvit.createForm(
    (data) => ({ fields: data.fields as FormField[] }),
    manualPostRestrictionRemovalHandler
);

Devvit.addMenuItem({
    label: "Remove post restriction from user",
    forUserType: "moderator",
    location: "post",
    onPress: handleManualPostRestrictionRemoval,
});

Devvit.addMenuItem({
    label: "Check Posting Restriction",
    location: "post",
    onPress: handlePostRestrictionCheck,
});

Devvit.addMenuItem({
    label: "Check User Restriction",
    location: "comment",
    forUserType: "moderator",
    onPress: handleUserRestrictionCheck,
});

Devvit.addMenuItem({
    label: "Check User Restriction",
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
    label: "Set TheRepBot score manually",
    forUserType: "moderator",
    location: "comment",
    onPress: handleManualPointSetting,
});

export async function handleCommentPin(
    event: MenuItemOnPressEvent,
    context: Context
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
            await logger.error(`❌ Attempted to pin comment that isn't top-level`);
            return;
        }

        if (comment.isStickied()) {
context.ui.showToast({
                text: "This comment is already pinned.",
            });
            await logger.error(`❌ Attempted to pin comment that is already stickied`);
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

Devvit.configure({
    redditAPI: true,
    redis: true,
});

export default Devvit;
