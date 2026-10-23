import { reddit, redis, settings } from "@devvit/web/server";
import type { JobContext, WikiPage } from "../compat";
import { lt } from "semver";
import json2md from "json2md";
import { logger } from "../logger";

interface AppUpdate {
    appname: string;
    version: string;
    whatsNewBullets: string[];
}

const UPDATE_SUBREDDIT = "TheRepBot";
const UPDATE_WIKI_PAGE = "upgrade-notifier";

//todo: Figure out how to run this to test if it works correctly
export async function getNewVersionInfo(
    context: JobContext
): Promise<AppUpdate | undefined> {
    let wikiPage: WikiPage;
    try {
        wikiPage = await reddit.getWikiPage(UPDATE_SUBREDDIT, UPDATE_WIKI_PAGE);
        if (!wikiPage) {
            const wikiPageOptions = {
                subredditName: UPDATE_SUBREDDIT,
                page: UPDATE_WIKI_PAGE,
                content: JSON.stringify([
                    {
                        appname: context.appSlug,
                        version: context.appVersion,
                        whatsNewBullets: [],
                    },
                ]),
                reason: "Create update notifier wiki page",
            };
            await reddit.createWikiPage(wikiPageOptions);
        }
    } catch (err) {
        logger.error("Update Checker: Error getting wiki page", {
            subreddit: UPDATE_SUBREDDIT,
            wikiPage: UPDATE_WIKI_PAGE,
            error: String(err),
        });
        return;
    }

    const updates = JSON.parse(wikiPage.content) as AppUpdate[];

    const updatesForThisApp = updates.filter(
        (update) => update.appname === context.appSlug
    );

    if (updatesForThisApp.length === 0) {
        logger.info("Update Checker: No updates found for app", {
            appSlug: context.appSlug,
        });
        return;
    }

    if (updatesForThisApp.length > 1) {
        logger.error("Update Checker: Multiple updates found for app", {
            appSlug: context.appSlug,
            matches: updatesForThisApp.length,
            updatesForThisApp,
        });
        return;
    }

    const update = updatesForThisApp[0];

    if (!update) {
        logger.error("Update Checker: Failed to find update after filtering", {
            appSlug: context.appSlug,
        });
        return;
    }

    if (!lt(context.appVersion, update.version)) {
        logger.info("Update Checker: Current version is up to date", {
            currentVersion: context.appVersion,
            latestVersion: update.version,
        });
        return;
    }

    return update;
}

export async function checkForUpdates(_: unknown, context: JobContext) {
    try {
        const notificationsEnabled = await settings.get("upgradeNotifier");

        if (!notificationsEnabled) {
            logger.info("Update Checker: Notifications are disabled");
            return;
        }

        const subredditName = (await reddit.getCurrentSubreddit()).name;

        const update = await getNewVersionInfo(context);

        if (!update) {
            logger.info("Update Checker: Update doesn't exist");
            return;
        }

        if (!update.version) {
            logger.error("Update Checker: Update has no version", {
                update,
            });
            return;
        }
        if (!update.whatsNewBullets) {
            logger.error(
                "Update Checker: Update has no whats new bullets option",
                {
                    update,
                }
            );
            return;
        }

        const redisKey = "update-notification-sent";

        const notificationSent = await redis.get(redisKey);

        if (notificationSent === update.version) {
            logger.info("Update Checker: Notification already sent", {
                version: update.version,
            });
            return;
        }

        const message: any[] = [
            { p: `A new version of RepBot is available to install.` },
        ];

        if (update.whatsNewBullets.length > 0) {
            message.push({ p: "Here's what's new:" });
            message.push({ ul: update.whatsNewBullets });
        }

        message.push({
            p: `To install this update, or to disable these notifications, visit the [**RepBot Configuration Page**](https://developers.reddit.com/r/${subredditName}/apps/${context.appSlug}) for /r/${subredditName}.`,
        });

        await reddit.modMail.createModNotification({
            subredditId: context.subredditId as `t5_${string}`,
            subject: `New RepBot Update Available: v${update.version}`,
            bodyMarkdown: json2md(message),
        });

        await redis.set(redisKey, update.version);
    } catch (error) {
        if (
            error instanceof TypeError &&
            error.message.includes("Invalid Version")
        ) {
            logger.info(
                "Invalid Version TypeError occurred while checking for updates, returning"
            );
            return;
        }
        await reddit.modMail.createModNotification({
            subredditId: context.subredditId as `t5_${string}`,
            subject: `RepBot Update Error`,
            bodyMarkdown: `An error occurred while checking for RepBot updates: ${error}`,
        });
    }
}
