import { JobContext, WikiPage } from "@devvit/public-api";
import { lt } from "semver";
import json2md from "json2md";
import { AppSetting } from "../settings";
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
    context: JobContext,
): Promise<AppUpdate | undefined> {
    logger.info("Update Checker: Checking for new version", {
        appSlug: context.appSlug,
        appVersion: context.appVersion,
        updateSubreddit: UPDATE_SUBREDDIT,
        updateWikiPage: UPDATE_WIKI_PAGE,
    });

    let wikiPage: WikiPage;
    try {
        wikiPage = await context.reddit.getWikiPage(
            UPDATE_SUBREDDIT,
            UPDATE_WIKI_PAGE,
        );
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
            await context.reddit.createWikiPage(wikiPageOptions);
        } else {
            logger.info("Update Checker: Successfully retrieved wiki page", {
                page: UPDATE_WIKI_PAGE,
                content: wikiPage.content,
            });
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

    logger.info("Update Checker: Parsed wiki updates", {
        count: updates.length,
        updates,
    });

    const updatesForThisApp = updates.filter(
        (update) => update.appname === context.appSlug,
    );

    logger.info("Update Checker: Filtered updates for app", {
        appSlug: context.appSlug,
        matches: updatesForThisApp.length,
        updatesForThisApp,
    });

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

    if (update) {
        logger.info("Update Checker: Found update", {
            appSlug: context.appSlug,
            currentVersion: context.appVersion,
            latestVersion: update.version,
            whatsNewBullets: update.whatsNewBullets,
        });
    } else {
        logger.error("Update Checker: Failed to find update after filtering", {
            appSlug: context.appSlug,
        });
        return;
    }

    logger.info("Update Checker: Comparing versions", {
        currentVersion: context.appVersion,
        latestVersion: update.version,
    });

    logger.info("Update Checker: Checking update details", {
        update,
    });

    if (!lt(context.appVersion, update.version)) {
        logger.info("Update Checker: Current version is up to date", {
            currentVersion: context.appVersion,
            latestVersion: update.version,
        });
        return;
    }

    logger.info("Update Checker: New version available", {
        currentVersion: context.appVersion,
        latestVersion: update.version,
    });
    return update;
}

export async function checkForUpdates(_: unknown, context: JobContext) {
    try {
        logger.info("Update Checker: Scheduled check started", {
        appSlug: context.appSlug,
        appVersion: context.appVersion,
        subredditId: context.subredditId,
        subredditName: context.subredditName,
    });

    const notificationsEnabled = await context.settings.get<boolean>(
        AppSetting.UpgradeNotifier,
    );

    logger.info("Update Checker: Upgrade notifier setting", {
        enabled: notificationsEnabled,
    });

    if (!notificationsEnabled) {
        logger.info("Update Checker: Notifications are disabled");
        return;
    }

    const subredditName =
        context.subredditName ??
        (await context.reddit.getCurrentSubredditName());

    logger.info("Update Checker: Resolved subreddit", {
        subredditName,
    });

    const update = await getNewVersionInfo(context);

    logger.info("Update Checker: getNewVersionInfo return value", {
        update,
        version: update?.version,
    });

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
        logger.error("Update Checker: Update has no whats new bullets option", {
            update,
        });
        return;
    }

    const redisKey = "update-notification-sent";

    const notificationSent = await context.redis.get(redisKey);

    logger.info("Update Checker: Redis notification status", {
        redisKey,
        notificationSent,
        updateVersion: update.version,
    });

    if (notificationSent === update.version) {
        logger.info("Update Checker: Notification already sent", {
            version: update.version,
        });
        return;
    }

    const message: json2md.DataObject[] = [
        { p: `A new version of RepBot is available to install.` },
    ];

    if (update.whatsNewBullets.length > 0) {
        message.push({ p: "Here's what's new:" });
        message.push({ ul: update.whatsNewBullets });
    }

    message.push({
        p: `To install this update, or to disable these notifications, visit the [**RepBot Configuration Page**](https://developers.reddit.com/r/${subredditName}/apps/${context.appSlug}) for /r/${subredditName}.`,
    });

    logger.info("Update Checker: Sending mod notification", {
        subredditId: context.subredditId,
        version: update.version,
        subject: `New RepBot Update Available: v${update.version}`,
        body: json2md(message),
    });

    await context.reddit.modMail.createModNotification({
        subredditId: context.subredditId,
        subject: `New RepBot Update Available: v${update.version}`,
        bodyMarkdown: json2md(message),
    });

    logger.info("Update Checker: Notification sent", {
        version: update.version,
    });

    await context.redis.set(redisKey, update.version);

    logger.info("Update Checker: Redis updated", {
        redisKey,
        version: update.version,
    });
} catch (error) {
    await context.reddit.modMail.createModNotification({
        subredditId: context.subredditId,
        subject: `RepBot Update Error`,
        bodyMarkdown: `An error occurred while checking for RepBot updates: ${error}`,
    });
    logger.error("Update Checker: Error occurred during scheduled check", {
        error,
    });
}
}
