import { Hono } from "hono";
import { checkForUpdates } from "./core/upgradeNotify/upgradeNotifier";
import { onAppInstall, onAppUpgrade } from "./core/installEvents";
import { onCommentCreate } from "./core/clientCore/triggers/onCommentCreate";
import { onCommentUpdate } from "./core/clientCore/triggers/onCommentUpdate";
import { modInfoJob, updateLeaderboard } from "./core/clientCore/leaderboard";
import { cleanupDeletedAccounts } from "./core/utils/cleanupTasks";
import { onPostCreate } from "./core/clientCore/triggers/onPostCreate";
import { modDigestJob } from "./core/modCore/modDigest";
import { addPostOfTheMonthFlair } from "./core/modCore/postOfTheMonth";
import { menu } from "./routes/menu";
import { forms } from "./routes/forms";
import { getRequestListener } from "@hono/node-server";
import { api } from "./routes/api";
import { createServer, getServerPort } from "@devvit/web/server";
import { handleNumberFieldHasValidOption, handleSelectFieldHasOptionChosen, handleStringOrParagraphFieldContainsText, handleValidateFlairTemplateId, handleValidateLeaderboardName, handleValidateLeaderboardSize, handleValidateModTriggerCommand, handleValidateTriggerWords } from "./routes/validators";

const application = new Hono();

application.route("/menu", menu);
application.route("/form", forms);
application.route("/triggers", application);
application.route("/scheduler", application);
application.route("/api", api);

// Triggers
application.post("/internal/triggers/on-app-install", onAppInstall);
application.post("/internal/triggers/on-app-upgrade", onAppUpgrade);
application.post("/internal/triggers/on-comment-create", onCommentCreate);
application.post("/internal/triggers/on-comment-update", onCommentUpdate);
application.post("/internal/triggers/on-post-create", onPostCreate);

//jobs
application.post("/internal/scheduler/upgrade-notifier", checkForUpdates);
application.post("/internal/scheduler/mod-digest", modDigestJob);
application.post("/internal/scheduler/update-modinfo", modInfoJob);
application.post("/internal/scheduler/update-leaderboard", updateLeaderboard);
application.post("/internal/scheduler/cleanup", cleanupDeletedAccounts);
application.post("/internal/scheduler/cleanup-adhoc", cleanupDeletedAccounts);
application.post("/internal/scheduler/post-of-the-month", addPostOfTheMonthFlair);

application.post("/internal/validators/select-field-has-option-chosen", handleSelectFieldHasOptionChosen);
application.post("/internal/validators/number-field-has-valid-option", handleNumberFieldHasValidOption);
application.post("/internal/validators/string-or-paragraph-field-contains-text", handleStringOrParagraphFieldContainsText);
application.post("/internal/validators/validate-trigger-words", handleValidateTriggerWords);
application.post("/internal/validators/validate-mod-trigger-command", handleValidateModTriggerCommand);
application.post("/internal/validators/validate-flair-template-id", handleValidateFlairTemplateId);
application.post("/internal/validators/validate-leaderboard-size", handleValidateLeaderboardSize);
application.post("/internal/validators/validate-leaderboard-name", handleValidateLeaderboardName);

const server = createServer(getRequestListener(application.fetch));
server.on("error", (err) => {
    console.error(`server error; ${err.stack}`);
});

const port = getServerPort();
server.listen(port);