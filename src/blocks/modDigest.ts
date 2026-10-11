import {
    JobContext,
    JSONObject,
    ScheduledJobEvent,
    TriggerContext,
} from "@devvit/public-api";
import { logger } from "./logger";
import { AppSetting } from "./settings";
import {
    DIGEST_PENDING_KEY,
    DIGEST_STATS_KEY,
} from "./triggers/utils/digest-stats";
/**
 * The only digest values are the current reporting window's award and post
 * counters. Reputation balances, flair, wiki history and leaderboard stay put.
 */
export async function modDigestJob(
    _: ScheduledJobEvent<JSONObject | undefined>,
    context: JobContext
) {
    const subredditName = context.subredditName;
    if (!subredditName) {
        logger.warn("Mod digest: no subredditName; aborting");
        return;
    }

    const prefix = "repbot:modDigest"; // preserve existing delivery settings/state
    const lastSentKey = `${prefix}:lastSentAt`;
    const conversationKey = `${prefix}:conversationId`;
    const conversationTypeKey = `${prefix}:conversationType`;
    const lockKey = "repbot:modDigest:lock";
    const now = Date.now();
    let ownsLock = false;

    try {
        const settings = await context.settings.getAll();
        const configuredFrequency = settings[AppSetting.DigestFrequency] as
            | string[]
            | string
            | undefined;
        const rawFrequency = Array.isArray(configuredFrequency)
            ? configuredFrequency[0]
            : configuredFrequency;
        const frequency = rawFrequency;

        const intervalMs: Record<string, number> = {
            Daily: 24 * 60 * 60 * 1000,
            Weekly: 7 * 24 * 60 * 60 * 1000,
            Monthly: 30 * 24 * 60 * 60 * 1000,
        };
        if (frequency === "Never") return;
        if (
            !frequency ||
            !(frequency in intervalMs) ||
            !intervalMs[frequency]
        ) {
            logger.warn("Mod digest: invalid frequency", { frequency });
            return;
        }

        const lastSentRaw = await context.redis.get(lastSentKey);
        const parsed = lastSentRaw === null ? NaN : Number(lastSentRaw);
        const lastSentAt = Number.isFinite(parsed) ? parsed : undefined;
        if (
            lastSentAt !== undefined &&
            now - lastSentAt < intervalMs[frequency]
        ) {
            return;
        }

        // Ensure only one scheduled invocation rotates/sends these counters.
        // The lease expires if a job crashes. Devvit SET NX returns "OK" on success.
        const lockResult = await context.redis.set(lockKey, `${now}`, {
            nx: true,
        });
        if (lockResult !== "OK") {
            logger.info("Mod digest: another send is already in progress");
            return;
        }
        ownsLock = true;

        // Recheck after getting the lease, since another job may have sent.
        const lastSentAfterLock = await context.redis.get(lastSentKey);
        const lastSentNum =
            lastSentAfterLock === null ? NaN : Number(lastSentAfterLock);
        if (
            Number.isFinite(lastSentNum) &&
            now - lastSentNum < intervalMs[frequency]
        ) {
            return;
        }

        const rawNewConversation = settings[AppSetting.DigestNewMessageEachDay];
        const newConversation =
            rawNewConversation === true ||
            rawNewConversation === 1 ||
            (typeof rawNewConversation === "string" &&
                rawNewConversation.trim().toLowerCase() === "true");

        // A failed send leaves :pending for the next attempt. Never overwrite it.
        // RENAME is atomic: subsequent awards/posts start a fresh active hash.
        const hasPending = await context.redis.exists(DIGEST_PENDING_KEY);
        if (!hasPending && (await context.redis.exists(DIGEST_STATS_KEY))) {
            await context.redis.rename(DIGEST_STATS_KEY, DIGEST_PENDING_KEY);
        }

        const values = await context.redis.hGetAll(DIGEST_PENDING_KEY);
        const moderators: Array<{ username: string; count: number }> = [];
        const users: Array<{ username: string; count: number }> = [];
        let postsCreated = 0;

        for (const [field, rawValue] of Object.entries(values)) {
            const count = Number(rawValue);
            if (!Number.isFinite(count) || count <= 0) continue;
            if (field === "posts") {
                postsCreated = count;
            } else if (field.startsWith("mod:")) {
                moderators.push({ username: field.slice(4), count });
            } else if (field.startsWith("user:")) {
                users.push({ username: field.slice(5), count });
            }
        }

        const sortByPoints = (
            a: { username: string; count: number },
            b: { username: string; count: number }
        ) => b.count - a.count || a.username.localeCompare(b.username);
        moderators.sort(sortByPoints);
        users.sort(sortByPoints);

        const totalPoints = [...moderators, ...users].reduce(
            (sum, entry) => sum + entry.count,
            0
        );
        const fmt = (value: number) => value.toLocaleString("en-US");
        const topTen = (entries: Array<{ username: string; count: number }>) =>
            entries.length
                ? entries
                      .slice(0, 10)
                      .map(
                          (entry, index) =>
                              `${index + 1}. u/${entry.username} — ${fmt(
                                  entry.count
                              )} points`
                      )
                      .join("\n")
                : "_None this period._";

        // The body intentionally contains ONLY the six requested statistics.
        const subject = `RepBot ${frequency} Digest — r/${subredditName}`;
        const body = [
            `**Total points awarded:** ${fmt(totalPoints)}`,
            `**Moderators who awarded points:** ${fmt(moderators.length)}`,
            `**Users who awarded points:** ${fmt(users.length)}`,
            `**Posts created:** ${fmt(postsCreated)}`,
            `## Users who awarded the most points\n${topTen(users)}`,
            `## Moderators who awarded the most points\n${topTen(moderators)}`,
        ].join("\n\n");

        const desiredConversationType = "notification";
        const [previousConversationId, previousConversationType] =
            await Promise.all([
                context.redis.get(conversationKey),
                context.redis.get(conversationTypeKey),
            ]);
        const modMail = context.reddit.modMail as any;
        let conversationId: string | undefined;

        if (
            !newConversation &&
            previousConversationId &&
            previousConversationType === desiredConversationType
        ) {
            try {
                await modMail.reply({
                    conversationId: previousConversationId,
                    body,
                    isInternal: true,
                });
                conversationId = previousConversationId;
            } catch (error) {
                logger.warn("Mod digest reply failed; creating discussion", {
                    error,
                    previousConversationId,
                });
            }
        }

        if (!conversationId) {
            conversationId = await modMail.createModDiscussionConversation({
                subredditId: context.subredditId,
                subject,
                bodyMarkdown: body,
            });
        }

        // The message has succeeded. Keep active (new) counters untouched and
        // remove ONLY the frozen batch that was just reported.
        await context.redis.set(lastSentKey, now.toString());
        if (conversationId) {
            await Promise.all([
                context.redis.set(conversationKey, conversationId),
                context.redis.set(conversationTypeKey, desiredConversationType),
            ]);
        }
        await context.redis.del(DIGEST_PENDING_KEY);

        logger.info("Reputation Bot mod digest sent; reported stats reset", {
            subreddit: subredditName,
            frequency,
            totalPoints,
            moderators: moderators.length,
            users: users.length,
            postsCreated,
        });
    } catch (error) {
        await logger.error(
            "Reputation Bot mod digest failed; unsent counters retained",
            {
                subreddit: subredditName,
                error: error instanceof Error ? error.message : String(error),
            },
            context as TriggerContext
        );
    } finally {
        if (ownsLock) {
            await context.redis.del(lockKey);
        }
    }
}
