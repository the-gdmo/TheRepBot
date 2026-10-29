import { Hono } from "hono";
import { handleConfirmReply } from "../core/clientCore/utils/utility";
import { onPostSubmit } from "../repbot/triggers/post-logic/postSubmitEvent";
import { cleanupDeletedAccounts } from "../repbot/cleanupTasks";
import { modInfoJob, updateLeaderboard } from "../repbot/leaderboard";
import { modDigestJob } from "../repbot/modDigest";
import { addPostOfTheMonthFlair } from "../repbot/postOfTheMonth";
import { checkForUpdates } from "../repbot/upgradeNotify/upgradeNotifier";
import { onAppInstall, onAppUpgrade } from "../repbot/installEvents";
import { onCommentCreate } from "../core/triggers/onCommentCreate";
import { onCommentUpdate } from "../core/triggers/onCommentUpdate";

export const triggers = new Hono();
async function run(
    c: any,
    handler: (event: any) => Promise<any>,
    eventOverride?: any
) {
    const data = await c.req.json().catch(() => ({}));
    await handler(eventOverride ?? data);
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
triggers.post("/on-comment-update", async (c) => {
    const data = await c.req.json().catch(() => ({}));
    await onCommentCreate(data);
    return c.json({ status: "ok" });
});
triggers.post("/on-comment-update", async (c) => {
    const data = await c.req.json().catch(() => ({}));
    await onCommentUpdate(data);
    await handleConfirmReply(data);
    return c.json({ status: "ok" });
});
triggers.post("/on-comment-update", async (c) => {
    const data = await c.req.json().catch(() => ({}));
    await onPostSubmit(data);
    await handleConfirmReply(data);
    return c.json({ status: "ok" });
});

export const jobs = new Hono();
const job =
    (handler: (event: any) => Promise<any>) => async (c: any) => {
        const request = await c.req.json().catch(() => ({}));
        await handler(request.data ?? request);
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
