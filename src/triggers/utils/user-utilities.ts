import { SettingsValues, TriggerContext, User } from "@devvit/public-api";
import {
    AppSetting,
    AutoSuperuserReplyOptions,
    TemplateDefaults,
} from "../../settings.js";
import { POINTS_STORE_KEY } from "../post-logic/redisKeys.js";
import { formatMessage, modCommandValue } from "./common-utilities.js";
import { getParentComment } from "../comment/comment-trigger-context.js";
import { CommentSubmit, CommentUpdate } from "@devvit/protos";
import { logger } from "../../logger.js";

export const isModerator = async (
    context: TriggerContext,
    subName: string,
    awarder: string
) => {
    const filteredModeratorList = await context.reddit
        .getModerators({ subredditName: subName, username: awarder })
        .all();
    return filteredModeratorList.length > 0;
};

export async function getUserCanAward(
    context: TriggerContext,
    awarder: string
) {
    // UsersWhoCannotAwardPoints
    const settings = await context.settings.getAll();

    const usersWhoCannotAwardSetting =
        (settings[AppSetting.UsersWhoCannotAwardPoints] as
            | string
            | undefined) ?? "";
    const UsersWhoCannotAwardPoints = usersWhoCannotAwardSetting
        .split(",")
        .map((user) => user.trim().toLowerCase());

    if (UsersWhoCannotAwardPoints.includes(awarder.toLowerCase())) {
        return false;
    }

    return true;
}

export async function getUserIsSuperuser(
    context: TriggerContext,
    awarder: string
) {
    const settings = await context.settings.getAll();

    const superUserSetting =
        (settings[AppSetting.SuperUsers] as string | undefined) ?? "";
    const superUsers = superUserSetting
        .split(",")
        .map((user) => user.trim().toLowerCase());

    if (superUsers.includes(awarder.toLowerCase())) {
        return true;
    }

    const autoSuperuserThreshold =
        (settings[AppSetting.AutoSuperuserThreshold] as number | undefined) ??
        0;

    if (autoSuperuserThreshold) {
        let user: User | undefined;
        try {
            user = await context.reddit.getUserByUsername(awarder);
        } catch {
            return false;
        }
        if (!user) {
            return false;
        }
        const { currentScore } = await getCurrentScore(user, context, settings);
        return currentScore >= autoSuperuserThreshold;
    } else {
        return false;
    }
}

export async function handleAutoSuperuserPromotion(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
    newScore: number,
    commandUsed: string
) {
    const parentComment = await getParentComment(event, context);
    if (!event.author || !parentComment || !event.subreddit) return;
    const settings = await context.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const awarder = event.author.name;
    const awardee = parentComment.authorName;
    const threshold =
        (settings[AppSetting.AutoSuperuserThreshold] as number) ?? 0;

    if (threshold <= 0 || newScore < threshold) return;

    if (await context.redis.exists(`superUserHandled:${awardee}`)) {
        logger.info(`User has already been notified they are a superuser`, {
            awardee,
            threshold,
        });
        return;
    }

    await context.redis.set(`superUserHandled:${awardee}`, "1");

    const notifyMode =
        (settings[AppSetting.NotifyOnAutoSuperuser] as string[])?.[0] ??
        AutoSuperuserReplyOptions.NoReply;

    if (notifyMode === AutoSuperuserReplyOptions.NoReply) return;

    const superUserNotification = formatMessage(
        (settings[AppSetting.NotifyOnAutoSuperuserTemplate] as string) ??
            TemplateDefaults.NotifyOnSuperuserTemplate,
        {
            awardee,
            awarder,
            name: pointName,
            threshold: threshold.toString(),
            command: await modCommandValue(context),
        }
    );

    try {
        // if (notifyMode === AutoSuperuserReplyOptions.ReplyByPM) {
        await context.reddit.sendPrivateMessage({
            to: awardee,
            subject: `You are now a trusted user in r/${event.subreddit.name}`,
            text: superUserNotification,
        });
        // } else if (notifyMode === AutoSuperuserReplyOptions.ReplyAsComment) {
        //     const superUserNotificationMessage = await context.reddit.submitComment({
        //         id: commentId,
        //         text: superUserNotification,
        //     });
        //     await superUserNotificationMessage.distinguish();
        // }

        logger.info("⭐ Auto-superuser notification sent", {
            awardee,
            newScore,
        });
    } catch (err) {
        logger.error("❌ Failed auto-superuser notification", {
            awardee,
            err,
        });
    }
}

export async function getCurrentScore(
    user: User,
    context: TriggerContext,
    settings: SettingsValues
): Promise<{
    currentScore: number;
    flairText: string;
    flairSymbol: string;
}> {
    const subredditName = (await context.reddit.getCurrentSubreddit()).name;
    const userFlair = await user.getUserFlairBySubreddit(subredditName);

    let scoreFromRedis: number | undefined;
    try {
        scoreFromRedis =
            (await context.redis.zScore(
                `${POINTS_STORE_KEY}`,
                user.username
            )) ?? 0;
    } catch {
        scoreFromRedis = 0;
    }

    const flairTextRaw = userFlair?.flairText ?? "";
    let scoreFromFlair: number;
    const numberRegex = /^\d+$/;

    if (!flairTextRaw || flairTextRaw === "-") {
        scoreFromFlair = 0;
    } else {
        // Extract numeric part from start of flair text (e.g. "17⭐" -> "17")
        const numericMatch = flairTextRaw.match(/^\d+/);
        if (numericMatch && numberRegex.test(numericMatch[0])) {
            scoreFromFlair = parseInt(numericMatch[0], 10);
        } else {
            scoreFromFlair = NaN;
        }
    }

    const flairScoreIsNaN = isNaN(scoreFromFlair);

    // Extract symbol by removing the numeric part from flair text, trim whitespace
    const flairSymbol = flairTextRaw.replace(/^\d+/, "").trim();

    if (settings[AppSetting.PrioritiseScoreFromFlair] && !flairScoreIsNaN) {
        return {
            currentScore: scoreFromFlair,
            flairText: flairTextRaw,
            flairSymbol,
        };
    }

    return {
        currentScore:
            !flairScoreIsNaN && scoreFromFlair > scoreFromRedis
                ? scoreFromFlair
                : scoreFromRedis,
        flairText: flairTextRaw,
        flairSymbol,
    };
}

export async function getUserIsAltUser(
    context: TriggerContext,
    awarder: string
) {
    const settings = await context.settings.getAll();

    const altUserSetting =
        (settings[AppSetting.AlternatePointCommandUsers] as
            | string
            | undefined) ?? "";
    const altUsers = altUserSetting
        .split(",")
        .map((user) => user.trim().toLowerCase());

    if (altUsers.includes(awarder.toLowerCase())) {
        return true;
    } else {
        return false;
    }
}
