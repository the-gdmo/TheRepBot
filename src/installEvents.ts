import { JobContext, TriggerContext, WikiPagePermissionLevel } from "@devvit/public-api";
import { AppInstall, AppUpgrade, WikiPage } from "@devvit/protos";
import { populateCleanupLogAndScheduleCleanup } from "./cleanupTasks.js";
import { CLEANUP_JOB, CLEANUP_JOB_CRON } from "./constants.js";
import { getSubredditName } from "./utility.js";
import { AppSetting } from "./settings.js";

export async function onAppFirstInstall (_: AppInstall, context: TriggerContext) {
    await context.redis.set("InstallDate", new Date().getTime().toString());
}

export async function onAppInstallOrUpgrade (_: AppInstall | AppUpgrade, context: TriggerContext) {
    const currentJobs = await context.scheduler.listJobs();
    await Promise.all(currentJobs.map(job => context.scheduler.cancelJob(job.id)));

    await context.scheduler.runJob({
        name: CLEANUP_JOB,
        cron: CLEANUP_JOB_CRON,
    });

    await populateCleanupLogAndScheduleCleanup(context);

        await context.scheduler.runJob({
            name: "updateLeaderboard",
            runAt: new Date(),
            data: { reason: "TheRepBot has been installed or upgraded." },
        });  
}

// export async function ensureLeaderboardWiki(context: JobContext) {
//     const settings = await context.settings.getAll();
//     const subredditName = await getSubredditName(context);
//     const wikiPageName = settings[AppSetting.ScoreboardName] as string | undefined;

//     if (!wikiPageName) return; // no page configured

//     const wikiPageOptions = {
//         subredditName,
//         page: wikiPageName,
//         content: "Initializing leaderboard...",
//         reason: "Initialize leaderboard wiki on install/upgrade",
//     };

//     let WikiPage: WikiPage | undefined;

//     try {
//         wikiPage = await context.reddit.getWikiPage(subredditName, wikiPageName);
//     } catch (err: any) {
//         if ((err?.details ?? "").includes("PAGE_NOT_FOUND")) {
//             // Page doesn't exist → create it
//             try {
//                 wikiPage = await context.reddit.createWikiPage(wikiPageOptions);
//                 console.log(`✅ Created wiki page "${wikiPageName}"`);
//             } catch (createErr: any) {
//                 if ((createErr?.details ?? "").includes("WIKI_DISABLED")) {
//                     console.warn(`Wiki is disabled for r/${subredditName}, cannot create page.`);
//                     return;
//                 } else {
//                     throw createErr;
//                 }
//             }
//         } else if ((err?.details ?? "").includes("WIKI_DISABLED")) {
//             console.warn(`Wiki is disabled for r/${subredditName}, cannot access page.`);
//             return;
//         } else {
//             throw err;
//         }
//     }

//     // Set permission level to MODS_ONLY
//     try {
//         if (wikiPage) {
//             await context.reddit.updateWikiPageSettings({
//                 subredditName,
//                 page: wikiPageName,
//                 listed: true,
//                 permLevel: WikiPagePermissionLevel.MODS_ONLY,
//             });
//             console.log(`✅ Set wiki page "${wikiPageName}" to MODS_ONLY`);
//         }
//     } catch (permErr: any) {
//         if ((permErr?.details ?? "").includes("WIKI_DISABLED")) {
//             console.warn(`Wiki is disabled for r/${subredditName}, cannot update permissions.`);
//         } else {
//             throw permErr;
//         }
//     }
// }
