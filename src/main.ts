import { Devvit, FormField } from "@devvit/public-api";
import { appSettings, validateRegexJobHandler } from "./settings.js";
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
    backupAllScores,
    restoreForm,
    restoreFormHandler,
    showRestoreForm,
} from "./triggers/backup-restore/backupAndRestore.js";

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
    label: "Set TheRepBot score manually",
    forUserType: "moderator",
    location: "comment",
    onPress: handleManualPointSetting,
});

export const restoreFormKey = Devvit.createForm(
    restoreForm,
    restoreFormHandler
);
Devvit.addCustomPostType(leaderboardCustomPost);

Devvit.addMenuItem({
    label: "Backup ReputatorBot Scores",
    forUserType: "moderator",
    location: "subreddit",
    onPress: backupAllScores,
});

Devvit.addMenuItem({
    label: "Restore TheRepBot Scores",
    forUserType: "moderator",
    location: "subreddit",
    onPress: showRestoreForm,
});

export const customPostFormKey = Devvit.createForm(
    customPostForm,
    createCustomPostFormHandler
);

Devvit.configure({
    redditAPI: true,
    redis: true,
});

export default Devvit;
