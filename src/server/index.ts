import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createServer, getServerPort } from "@devvit/web/server";
import { api } from "./routes/api";
import { forms } from "./routes/forms";
import { menu } from "./routes/menu";
import { triggers, jobs } from "./routes/triggers";
import {
    handleSelectFieldHasOptionChosen,
    handleNumberFieldHasValidOption,
    handleStringOrParagraphFieldContainsText,
    handleValidateTriggerWords,
    handleValidateModTriggerCommand,
    handleValidateFlairTemplateId,
    handleValidateLeaderboardSize,
    handleValidateLeaderboardName,
} from "./routes/validators";
import { onCommentCreate } from "./core/triggers/onCommentCreate";
import { onCommentUpdate } from "./core/triggers/onCommentUpdate";

const app = new Hono();
const internal = new Hono();
internal.route("/menu", menu);
internal.route("/form", forms);
internal.route("/triggers", triggers);
internal.route("/scheduler", jobs);
app.post("/internal/triggers/on-comment-create", onCommentCreate);
app.post("/internal/triggers/on-comment-update", onCommentUpdate);
app.post("/internal/validators/select-field-has-option-chosen", handleSelectFieldHasOptionChosen);
app.post("/internal/validators/number-field-has-valid-option", handleNumberFieldHasValidOption);
app.post("/internal/validators/string-or-paragraph-field-contains-text", handleStringOrParagraphFieldContainsText);
app.post("/internal/validators/validate-trigger-words", handleValidateTriggerWords);
app.post("/internal/validators/validate-mod-trigger-command", handleValidateModTriggerCommand);
app.post("/internal/validators/validate-flair-template-id", handleValidateFlairTemplateId);
app.post("/internal/validators/validate-leaderboard-size", handleValidateLeaderboardSize);
app.post("/internal/validators/validate-leaderboard-name", handleValidateLeaderboardName);
app.route("/api", api);
app.route("/internal", internal);

serve({ fetch: app.fetch, createServer, port: getServerPort() });
