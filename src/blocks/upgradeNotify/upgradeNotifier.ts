// import { JobContext, WikiPage } from "@devvit/public-api";
// import { AppSetting } from "../settings.js";
// import { lt } from "semver";
// import json2md from "json2md";
// import { logger } from "../logger.js";
// import { SafeWikiClient } from "../utility.js";

// interface AppUpdate {
//     appname: string;
//     version: string;
//     whatsNewBullets: string[];
// }

// const UPDATE_WIKI_PAGE = "upgrade-notifier";

// export async function getNewVersionInfo(
//     context: JobContext,
// ): Promise<AppUpdate | undefined> {
//     const safeWiki = new SafeWikiClient(context.reddit);

//     const wikiPath = `${context.appSlug}/${UPDATE_WIKI_PAGE}`;

//     if (!context.subredditName) {
//         logger.error("Update Checker: No subreddit found.");
//         return;
//     }

//     let existingPage = undefined;
//     try {
//         existingPage = await safeWiki.getWikiPage(
//             context.subredditName,
//             wikiPath,
//         );

//         if (existingPage) {
//             logger.info("ℹ️ Existing upgrade notifier wiki page found", {
//                 wikiPath,
//             });
//         } else {
//             const botCreator = "ryry50583583";
//             const subject = `Upgrade%20Notifier%20Page%20Not%20Found`;
//             const message =
//                 `Hello!%20It%20seems%20that%20[the%20wiki%20page%20used%20for%20upgrade%20notifications](https://www.reddit.com/r/TheRepBot/wiki/${wikiPath})%20is%20missing%20from%20your%20subreddit. ` +
//                 `%0A` +
//                 `%20`;
//             logger.error(
//                 `If you see this error, please [contact my developer](https://www.reddit.com/message/compose?to=${botCreator}&message=${message}&subject=${subject}). ` +
//                     `Please send the message as-is.`,
//                 {},
//                 context,
//             );
//             return;
//         }
//     } catch (err) {
//         const botCreator = "ryry50583583";
//         logger.error(`If you see this error, please [contact my developer](https://www.reddit.com/message/compose?to=${botCreator} and send this message as-is. `, {
//             error: String(err),
//         });
//     }

//     if (!existingPage) return;

//     const updates = JSON.parse(existingPage.contentMd) as AppUpdate[];
//     const updatesForThisApp = updates.filter(
//         (update) => update.appname === context.appSlug,
//     );
//     if (updatesForThisApp.length === 0) {
//         console.log(
//             `Update Checker: No updates found for app ${context.appSlug}`,
//         );
//         return;
//     }

//     if (updatesForThisApp.length > 1) {
//         console.error(
//             `Update Checker: Multiple updates found for app ${context.appSlug}`,
//         );
//         return;
//     }

//     const update = updatesForThisApp[0];

//     if (!update) {
//         logger.error(
//             `Update Checker: No version found for update for app ${context.appSlug}`,
//         );
//         return;
//     }

//     if (!lt(context.appVersion, update.version)) {
//         logger.info("Update Checker: No updates found");
//         return;
//     }
// }

// export async function checkForUpdates(_: unknown, context: JobContext) {
//     const notificationsEnabled = await context.settings.get<boolean>(
//         AppSetting.UpgradeNotifier,
//     );
//     if (!notificationsEnabled) {
//         logger.info("Update Checker: Notifications are disabled");
//         return;
//     }

//     const subredditName =
//         context.subredditName ??
//         (await context.reddit.getCurrentSubredditName());

//     const update = await getNewVersionInfo(context);
//     if (!update || update.version === context.appVersion) {
//         logger.info("Update Checker: No new version available");
//         return;
//     }

//     const redisKey = "update-notification-sent";
//     const notificationSent = await context.redis.get(redisKey);
//     if (notificationSent === update.version) {
//         return;
//     }

//     const message: json2md.DataObject[] = [
//         { p: `A new version of RepBot is available to install.` },
//     ];
//     if (update.whatsNewBullets.length > 0) {
//         message.push({ p: "Here's what's new:" });
//         message.push({ ul: update.whatsNewBullets });
//     }

//     message.push({
//         p: `To install this update, or to disable these notifications, visit the [**RepBot Configuration Page**](https://developers.reddit.com/r/${subredditName}/apps/${context.appSlug}) for /r/${subredditName}.`,
//     });

//     await context.reddit.modMail.createModNotification({
//         subredditId: context.subredditId,
//         subject: `New RepBot Update Available: v${update.version}`,
//         bodyMarkdown: json2md(message),
//     });

//     logger.info(
//         `Update Checker: Notification sent for version ${update.version}`,
//     );

//     await context.redis.set(redisKey, update.version);
// }
