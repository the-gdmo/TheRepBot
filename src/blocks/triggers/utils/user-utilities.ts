import { TriggerContext, User } from "@devvit/public-api";
import {
    AppSetting,
    AutoSuperuserReplyOptions,
    TemplateDefaults,
} from "../../settings";
import { POINTS_STORE_KEY } from "./redisKeys";
import {
    formatMessage,
    modCommandValue,
    ScoreResult,
} from "./common-utilities";
import { getParentComment } from "../comment/comment-trigger-context";
import { CommentSubmit, CommentUpdate } from "@devvit/protos";
import { logger } from "../../logger";

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
        const currentScore = await getCurrentScore(user, context);
        if (!currentScore) {
            return false;
        }
        return currentScore.score >= autoSuperuserThreshold;
    } else {
        return false;
    }
}

export async function handleAutoSuperuserPromotion(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
    newScore: number,
    _commandUsed: string
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
        event,
        (settings[AppSetting.AutoSuperuserTemplate] as string) ??
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
    context: TriggerContext
): Promise<ScoreResult | undefined> {
    if (!context.subredditName) {
        logger.error("❌ Subreddit name is not available in context.");
        return;
    }

    const userFlair = await user.getUserFlairBySubreddit(context.subredditName);

    const scoreFromRedis = await context.redis.zScore(
        POINTS_STORE_KEY,
        user.username
    );

    const rank = await context.redis.zRank(POINTS_STORE_KEY, user.username);

    const place = rank !== undefined && rank !== null ? rank + 1 : undefined;

    logger.info("🔢 Values", {
        place,
        rank,
        scoreFromRedis,
        userHasFlair: userFlair?.flairText !== undefined,
    });

    let scoreFromFlair: number | undefined;
    let flairIsNumber = false;

    if (userFlair?.flairText) {
        const flairTextTemplate =
            ((await context.settings.get(AppSetting.FlairFormatting)) as
                | string
                | undefined) ?? TemplateDefaults.FlairFormatting;

        const escapeRegex = (text: string): string =>
            text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        // Escape the template first.
        let pattern = escapeRegex(flairTextTemplate);

        // Replace placeholders with regex.
        pattern = pattern.replace(escapeRegex("{{total}}"), "(\\d+)");

        pattern = pattern.replace(escapeRegex("{{symbol}}"), ".*?");

        pattern = pattern.replace(escapeRegex("{{place}}"), "\\d+");

        const regex = new RegExp(`^${pattern}$`);

        const matches = regex.exec(userFlair.flairText);

        const matchedPoints = matches?.[1];

        scoreFromFlair = matchedPoints
            ? parseInt(matchedPoints, 10)
            : undefined;

        logger.debug("Checking flair values", {
            place,
            flairText: userFlair.flairText,
            flairTemplate: flairTextTemplate,
            regex: regex.toString(),
            matches,
            matchedPoints,
            scoreFromFlair,
        });

        // Fallback: extract the first number found anywhere.
        if (scoreFromFlair === undefined) {
            const fallbackRegex = /(\d+)/;
            const fallbackMatches = fallbackRegex.exec(userFlair.flairText);

            scoreFromFlair = fallbackMatches?.[1]
                ? parseInt(fallbackMatches[1], 10)
                : undefined;

            logger.debug("Fallback flair parsing", {
                fallbackMatches,
                scoreFromFlair,
            });
        }

        // We successfully parsed a score.
        flairIsNumber = scoreFromFlair !== undefined;
    }

    const finalScore = scoreFromFlair ?? scoreFromRedis ?? 0;

    await context.redis.zAdd(POINTS_STORE_KEY, {
        member: user.username,
        score: finalScore,
    });

    logger.info("🔢 Values", {
        place,
        score: finalScore,
        scoreFromRedis,
        scoreFromFlair,
        userHasFlair: userFlair?.flairText !== undefined,
        flairIsNumber,
    });

    return {
        score: finalScore,
        userHasFlair: userFlair?.flairText !== undefined,
        flairIsNumber,
    };
}
