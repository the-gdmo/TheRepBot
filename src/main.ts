import { Devvit, FormField } from "@devvit/public-api";
import {
    AppSetting,
    appSettings,
    validateRegexJobHandler,
} from "./settings.js";
import { onAppFirstInstall, onAppInstallOrUpgrade } from "./installEvents.js";
import { updateLeaderboard } from "./leaderboard.js";
import { cleanupDeletedAccounts } from "./cleanupTasks.js";
import {
    leaderboardCustomPost,
    createCustomPostMenuHandler,
    customPostForm,
    createCustomPostFormHandler,
} from "./customPost/index.js";
import {
    ADHOC_CLEANUP_JOB,
    CLEANUP_JOB,
    UPDATE_LEADERBOARD_JOB,
    VALIDATE_REGEX_JOB,
} from "./constants.js";
import { handleConfirmReply } from "./utility.js";
import { handleThanksEvent } from "./triggers/comment/on-comment-trigger.js";
import { onPostSubmit } from "./triggers/post-logic/postSubmitEvent.js";
import {
    handleManualPointSetting,
    handleManualPostRestrictionRemoval,
    manualPostRestrictionRemovalHandler,
    manualSetPointsFormHandler,
} from "./triggers/utils/mod-utilities.js";
import {
    getAwardsRequiredKey,
    getRestrictedKey,
    restrictedKeyExists,
} from "./triggers/post-logic/redisKeys.js";
import { logger } from "./logger.js";

Devvit.addSettings(appSettings);

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
    label: "Submit Leaderboard Post",
    forUserType: "moderator",
    location: "subreddit",
    onPress: createCustomPostMenuHandler,
});

Devvit.addMenuItem({
    label: "Remove post restriction from user",
    forUserType: "moderator",
    location: "post",
    onPress: handleManualPostRestrictionRemoval,
});

Devvit.addMenuItem({
    label: "Check Posting Restriction",
    location: "post",
    onPress: async (event, context) => {
        if (event.location === "post" && event.targetId) {
            const post = await context.reddit.getPostById(event.targetId);

            if (!post?.authorName) {
                context.ui.showToast({
                    text: "Unable to determine post author.",
                });
                return;
            }

            const user = await context.reddit.getUserByUsername(
                post.authorName
            );

            if (!user) return;

            const settings = await context.settings.getAll();

            const awardsRequired =
                (settings[
                    AppSetting.AwardsRequiredToCreateNewPosts
                ] as number) ?? 0;

            // 🚫 No restriction system enabled
            if (awardsRequired <= 0) {
                context.ui.showToast({
                    text: "Awarding is not required to post",
                });
                return;
            }

            const awardsRequiredKey = await getAwardsRequiredKey(user);
            const raw = await context.redis.get(awardsRequiredKey);
            const awardsRequiredKeyExists = await context.redis.exists(
                awardsRequiredKey
            );

            // 🔓 Not restricted
            if (!await restrictedKeyExists(context, user.username)) {
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
    },
});

Devvit.addMenuItem({
    label: "Set TheRepBot score manually",
    forUserType: "moderator",
    location: "comment",
    onPress: handleManualPointSetting,
});

Devvit.addCustomPostType(leaderboardCustomPost);

export const customPostFormKey = Devvit.createForm(
    customPostForm,
    createCustomPostFormHandler
);

Devvit.configure({
    redditAPI: true,
    redis: true,
});

export default Devvit;
