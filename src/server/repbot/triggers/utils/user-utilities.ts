import { settings } from "@devvit/web/server";
import type { TriggerContext, User } from "../../compat";
import { formatMessage, ScoreResult } from "./common-utilities";
import { getParentComment } from "../comment/comment-trigger-context";
import { CommentSubmit, CommentUpdate } from "@devvit/protos";
import { logger } from "../../logger";
import { POINTS_STORE_KEY } from "./redisKeys";

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
    _context: TriggerContext,
    awarder: string
) {
    // UsersWhoCannotAwardPoints
    const settingUsersWhoCannotAwardPoints = await settings.get<string>(
        "usersWhoCantAwardPoints"
    );

    const usersWhoCannotAwardSetting = settingUsersWhoCannotAwardPoints ?? "";
    const usersWhoCannotAwardPoints = usersWhoCannotAwardSetting
        .split(/[\r\n,]+/)
        .map((user) => user.trim().toLowerCase())
        .filter(Boolean);

    if (usersWhoCannotAwardPoints.includes(awarder.toLowerCase())) {
        return false;
    }

    return true;
}

export async function getUserIsSuperuser(
    context: TriggerContext,
    awarder: string
) {
    const settingSuperUsers = await settings.get<string>("superUsers");
    const settingAutoSuperuserThreshold = await settings.get<number>(
        "autoSuperuserThreshold"
    );

    const superUserSetting = settingSuperUsers ?? "";
    const superUsers = superUserSetting
        .split(/[\r\n,]+/)
        .map((user) => user.trim().toLowerCase())
        .filter(Boolean);

    if (superUsers.includes(awarder.toLowerCase())) {
        return true;
    }

    const autoSuperuserThreshold = settingAutoSuperuserThreshold ?? 0;

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
    const settingAutoSuperuserThreshold = await settings.get<number>(
        "autoSuperuserThreshold"
    );
    const settingPointName = await settings.get<string>("pointName");
    const settingNotifyOnAutoSuperuser = await settings.get<string>(
        "notifyOnAutoSuperuser"
    );
    const settingAutoSuperuserTemplate = await settings.get<string>(
        "AutoSuperuserTemplate"
    );
    const settingModAwardCommand = await settings.get<string>(
        "modAwardCommand"
    );
    const pointName = settingPointName ?? "point";
    const awarder = event.author.name;
    const awardee = parentComment.authorName;
    const threshold = settingAutoSuperuserThreshold ?? 0;

    if (threshold <= 0 || newScore < threshold) return;

    if (await context.redis.exists(`superUserHandled:${awardee}`)) {
        logger.info(`User has already been notified they are a superuser`, {
            awardee,
            threshold,
        });
        return;
    }

    await context.redis.set(`superUserHandled:${awardee}`, "1");

    const notifyMode = settingNotifyOnAutoSuperuser ?? ["none"];

    if (notifyMode === "none") return;

    const superUserNotification = formatMessage(
        event,
        settingAutoSuperuserTemplate ?? "",
        {
            awardee,
            awarder,
            name: pointName,
            threshold: threshold.toString(),
            command: settingModAwardCommand ?? "",
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

    const username = user.username;

    /**
     * Get the user's existing Reddit flair.
     */
    const userFlair = await user.getUserFlairBySubreddit(context.subredditName);

    /**
     * POINTS_STORE_KEY is the canonical score store.
     *
     * This MUST match the key used by setUserScore().
     */
    const scoreFromRedis = await context.redis.zScore(
        POINTS_STORE_KEY,
        username
    );

    logger.debug("Retrieved stored score", {
        username,
        scoreFromRedis,
        flairText: userFlair?.flairText,
    });

    let scoreFromFlair: number | undefined;
    let flairIsNumber = false;

    const flairText = userFlair?.flairText;

    /**
     * Only attempt to recover a score from flair when Redis
     * doesn't already contain one.
     *
     * Redis is authoritative once the user has been stored.
     */
    if (scoreFromRedis === undefined && flairText) {
        const flairFormattingSetting = await settings.get<string>(
            "flairFormatting"
        );
        const flairTextTemplate = flairFormattingSetting ?? "";

        const pointSymbolSetting = await settings.get<string>("pointSymbol");
        const pointSymbol = pointSymbolSetting ?? "";

        /**
         * Escape characters that have special meaning inside regex.
         */
        const escapeRegex = (text: string): string =>
            text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        /**
         * Escape the normal text first.
         *
         * Example:
         *
         *   "#{place} | {total} {symbol}"
         *
         * becomes a regex matching exactly the flair format
         * generated by this bot.
         */
        let pattern = escapeRegex(flairTextTemplate);

        /**
         * {total} is the value we actually want to capture.
         */
        pattern = pattern.replace(escapeRegex("{total}"), "(\\d+)");

        /**
         * {place} must be numeric, but we don't need to capture it.
         */
        pattern = pattern.replaceAll(escapeRegex("{place}"), "\\d+");

        /**
         * Match the configured point symbol exactly rather than
         * matching arbitrary text with .*?.
         */
        pattern = pattern.replaceAll(
            escapeRegex("{symbol}"),
            escapeRegex(pointSymbol)
        );

        const regex = new RegExp(`^${pattern}$`);

        const matches = regex.exec(flairText);
        const matchedPoints = matches?.[1];

        if (matchedPoints !== undefined) {
            const parsed = Number.parseInt(matchedPoints, 10);

            if (Number.isFinite(parsed)) {
                scoreFromFlair = parsed;
                flairIsNumber = true;
            }
        }

        logger.debug("Checking flair values", {
            username,
            flairText,
            flairTemplate: flairTextTemplate,
            pointSymbol,
            regex: regex.toString(),
            matchedPoints,
            scoreFromFlair,
            flairIsNumber,
        });
    }

    /**
     * Priority:
     *
     * 1. Redis score
     * 2. Score recovered from a bot-generated flair
     * 3. Zero for a brand-new user
     */
    const finalScore = scoreFromFlair ?? scoreFromRedis ?? 0;

    /**
     * Ensure the user now exists in the canonical sorted set.
     *
     * This also migrates users whose old score was only stored
     * in their Reddit flair.
     */
    if (scoreFromRedis === undefined) {
        await context.redis.zAdd(POINTS_STORE_KEY, {
            member: username,
            score: finalScore,
        });

        logger.info("Stored initial/migrated user score", {
            username,
            score: finalScore,
            source: scoreFromFlair !== undefined ? "flair" : "default",
        });
    }

    /**
     * Get their proper DESCENDING leaderboard position for
     * diagnostics.
     */
    const leaderboard = await context.redis.zRange(POINTS_STORE_KEY, 0, -1, {
        by: "rank",
        reverse: true,
    });

    const index = leaderboard.findIndex(
        (member: { member: string; score: number }) =>
            member.member === username
    );

    const place = index >= 0 ? index + 1 : undefined;

    const userHasFlair =
        userFlair?.flairText !== undefined && userFlair.flairText !== null;

    logger.info("🔢 User score", {
        username,
        place,
        score: finalScore,
        scoreFromRedis,
        scoreFromFlair,
        userHasFlair,
        flairIsNumber,
    });

    let flairShouldBeManaged: boolean;
    const key = `flairToggle:${username}`;
    const exists = await context.redis.exists(key);

    if (exists) {
        flairShouldBeManaged = false;
    } else {
        flairShouldBeManaged = true;
    }

    return {
        score: finalScore,
        userHasFlair,
        flairIsNumber,
        flairShouldBeManaged,
    };
}
