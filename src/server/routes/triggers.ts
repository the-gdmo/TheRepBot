import { Hono } from "hono";
import { createCompatContext } from "../repbot/compat";
import { handleConfirmReply } from "../repbot/utility";
import { handleThanksEvent } from "../repbot/triggers/comment/on-comment-trigger";
import { onPostSubmit } from "../repbot/triggers/post-logic/postSubmitEvent";
import { cleanupDeletedAccounts } from "../repbot/cleanupTasks";
import { modInfoJob, updateLeaderboard } from "../repbot/leaderboard";
import { modDigestJob } from "../repbot/modDigest";
import { addPostOfTheMonthFlair } from "../repbot/postOfTheMonth";
import { checkForUpdates } from "../repbot/upgradeNotify/upgradeNotifier";
import { onAppInstall, onAppUpgrade } from "../repbot/installEvents";

export const triggers = new Hono();
async function run(
    c: any,
    handler: (event: any, context: any) => Promise<any>,
    eventOverride?: any
) {
    const data = await c.req.json().catch(() => ({}));
    const ctx = createCompatContext(data);
    await handler(eventOverride ?? data, ctx);
    return c.json({ status: "ok" });
}
triggers.post("/on-app-install", async (c) => {
    const data = await c.req.json().catch(() => ({}));
    // const context = createCompatContext(data);
    await onAppInstall(data);
    await onAppUpgrade(data);
    return c.json({ status: "ok" });
});
triggers.post("/on-app-upgrade", (c) => run(c, onAppUpgrade));
triggers.post("/on-comment-submit", (c) => run(c, handleThanksEvent));
triggers.post("/on-comment-update", async (c) => {
    const data = await c.req.json().catch(() => ({}));
    const context = createCompatContext(data);
    await handleThanksEvent(data, context);
    await handleConfirmReply(data, context);
    return c.json({ status: "ok" });
});
triggers.post("/on-post-submit", (c) => run(c, onPostSubmit));

export const jobs = new Hono();
const job =
    (handler: (event: any, context: any) => Promise<any>) => async (c: any) => {
        const request = await c.req.json().catch(() => ({}));
        const ctx = createCompatContext(request);
        await handler(request.data ?? request, ctx);
        return c.json({ status: "ok" });
    };
jobs.post("/upgrade-notifier", job(checkForUpdates));
jobs.post("/mod-digest", job(modDigestJob));
jobs.post("/update-modinfo", job(modInfoJob));
jobs.post("/update-leaderboard", job(updateLeaderboard));
jobs.post("/cleanup", job(cleanupDeletedAccounts));
jobs.post("/cleanup-adhoc", job(cleanupDeletedAccounts));
jobs.post("/post-of-the-month", job(addPostOfTheMonthFlair));
jobs.post("/post-of-the-month-adhoc", job(addPostOfTheMonthFlair));
