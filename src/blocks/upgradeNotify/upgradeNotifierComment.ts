import json2md from "json2md";
import { logger } from "../logger";
import { AppSetting } from "../settings";
import { TriggerContext } from "@devvit/public-api";
import { getNewVersionInfo } from "./upgradeNotifier";
import { CommentSubmit, CommentUpdate } from "@devvit/protos";

export async function checkForUpdatesCommentSubmit(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
) {
    try {
        if (!event.comment) return;

        logger.info("Update Checker: Comment check started", {
            appSlug: context.appSlug,
            appVersion: context.appVersion,
            subredditId: context.subredditId,
            subredditName: context.subredditName,
        });

        const notificationsEnabled = await context.settings.get<boolean>(
            AppSetting.UpgradeNotifier,
        );

        logger.info(
            "Update Checker: Comment check - Upgrade notifier setting",
            {
                enabled: notificationsEnabled,
            },
        );

        if (!notificationsEnabled) {
            logger.info(
                "Update Checker: Comment check - Notifications are disabled",
            );
            return;
        }

        const subredditName =
            context.subredditName ??
            (await context.reddit.getCurrentSubredditName());

        logger.info("Update Checker: Comment check - Resolved subreddit", {
            subredditName,
        });

        const update = await getNewVersionInfo(context);

        logger.info(
            "Update Checker: Comment check - getNewVersionInfo return value",
            {
                update,
                version: update?.version,
            },
        );

        if (!update || !update.whatsNewBullets || !update.version) {
            logger.info(
                "Update Checker: Comment check - Update doesn't exist",
                {
                    update,
                    version: update?.version,
                    whatsNewBullets: update?.whatsNewBullets,
                },
            );
            return;
        }

        const redisKey = "update-notification-sent";

        const notificationSent = await context.redis.get(redisKey);

        logger.info(
            "Update Checker: Comment check - Redis notification status",
            {
                redisKey,
                notificationSent,
                updateVersion: update.version,
            },
        );

        if (notificationSent === update.version) {
            logger.info(
                "Update Checker: Comment check - Notification already sent",
                {
                    version: update.version,
                },
            );
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

        logger.info(
            "Update Checker: Comment check - Sending mod notification",
            {
                subredditId: context.subredditId,
                version: update.version,
                subject: `New RepBot Update Available: v${update.version}`,
                body: json2md(message),
            },
        );

        await context.reddit.submitComment({
            id: event.comment.id,
            text: json2md(message),
        });
        await context.reddit.modMail.createModNotification({
            subredditId: context.subredditId,
            subject: `New RepBot Update Available: v${update.version}`,
            bodyMarkdown: json2md(message),
        });

        logger.info("Update Checker: Comment check - Notification sent", {
            version: update.version,
        });

        await context.redis.set(redisKey, update.version);

        logger.info("Update Checker: Comment check - Redis updated", {
            redisKey,
            version: update.version,
        });
    } catch (err) {
        if (!event.comment) return;

        await context.reddit.submitComment({
            id: event.comment.id,
            text: `An error occurred while checking for updates: ${err}`,
        });
        logger.error("Update Checker: Comment check - Error occurred", {
            error: err,
        });
    }
}
