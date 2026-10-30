import {
    context,
    ModMailService,
    reddit,
    redis,
    settings,
} from "@devvit/web/server";
import { logger } from "../utils/logger";
import { DIGEST_PENDING_KEY, DIGEST_STATS_KEY } from "../utils/digest-stats";
/**
 * The only digest values are the current reporting window's award and post
 * counters. Reputation balances, flair, wiki history and leaderboard stay put.
 */
export async function modDigestJob(_: unknown) {
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
        const settingDigestFrequency = await settings.get("digestFrequency");
        const settingDigestNewMessageEachDay = await settings.get(
            "digestNewMessageEachDay"
        );
        const configuredFrequency = settingDigestFrequency as
            | string[]
            | string
            | undefined;
        const rawFrequency = Array.isArray(configuredFrequency)
            ? configuredFrequency[0]
            : configuredFrequency;
        const frequency = rawFrequency;

        const intervalMs: Record<string, number> = {
            Testing: 5 * 60 * 1000,
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

        const lastSentRaw = await redis.get(lastSentKey);
        const parsed = lastSentRaw === null ? NaN : Number(lastSentRaw);
        const lastSentAt = Number.isFinite(parsed) ? parsed : undefined;

        if (
            lastSentAt !== undefined &&
            now - lastSentAt < intervalMs[frequency]
        ) {
            logger.info(
                "Mod digest: not enough time has passed since last send",
                {
                    frequency,
                    lastSentAt: lastSentAt.toLocaleString("en-US"),
                    nextSendAt: (
                        lastSentAt + intervalMs[frequency]
                    ).toLocaleString("en-US"),
                    timeUntilNextSendSeconds:
                        (
                            (intervalMs[frequency] - (now - lastSentAt)) /
                            1_000
                        ).toLocaleString("en-US") + " seconds",
                    timeUntilNextSendHours:
                        (
                            (intervalMs[frequency] - (now - lastSentAt)) /
                            3_600_000
                        ).toLocaleString("en-US") + " hours",
                    timeUntilNextSendDays:
                        (
                            (intervalMs[frequency] - (now - lastSentAt)) /
                            86_400_000
                        ).toLocaleString("en-US") + " days",
                }
            );
            return;
        }

        // Ensure only one scheduled invocation rotates/sends these counters.
        // The lease expires if a job crashes. Devvit SET NX returns "OK" on success.
        const lockResult = await redis.set(lockKey, `${now}`, {
            nx: true,
        });

        if (lockResult !== "OK") {
            logger.info("Mod digest: another send is already in progress");
            return;
        }

        ownsLock = true;

        // Recheck after getting the lease, since another job may have sent.
        const lastSentAfterLock = await redis.get(lastSentKey);
        const lastSentNum =
            lastSentAfterLock === null ? NaN : Number(lastSentAfterLock);

        if (
            Number.isFinite(lastSentNum) &&
            now - lastSentNum < intervalMs[frequency]
        ) {
            return;
        }

        const rawNewConversation = settingDigestNewMessageEachDay;
        const newConversation =
            rawNewConversation === true ||
            rawNewConversation === 1 ||
            (typeof rawNewConversation === "string" &&
                rawNewConversation.trim().toLowerCase() === "true");

        // A failed send leaves :pending for the next attempt. Never overwrite it.
        // RENAME is atomic: subsequent awards/posts start a fresh active hash.
        const hasPending = await redis.exists(DIGEST_PENDING_KEY);

        if (!hasPending && (await redis.exists(DIGEST_STATS_KEY))) {
            await redis.rename(DIGEST_STATS_KEY, DIGEST_PENDING_KEY);
        }

        const values = await redis.hGetAll(DIGEST_PENDING_KEY);
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
            `**Reporting Period:** ${new Date(
                lastSentAt ?? 0
            ).toUTCString()} → ${new Date(now).toUTCString()}`,
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
                redis.get(conversationKey),
                redis.get(conversationTypeKey),
            ]);

        const modMail = reddit.modMail as ModMailService;
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
            conversationId = await modMail.createModNotification({
                subredditId: context.subredditId as `t5_${string}`,
                subject,
                bodyMarkdown: body,
            });
        }

        // The message has succeeded. Keep active (new) counters untouched and
        // remove ONLY the frozen batch that was just reported.
        await redis.set(lastSentKey, now.toString());

        if (conversationId) {
            await Promise.all([
                redis.set(conversationKey, conversationId),
                redis.set(conversationTypeKey, desiredConversationType),
            ]);
        }

        await redis.del(DIGEST_PENDING_KEY);

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
            "RepBot mod digest failed; unsent counters retained",
            {
                subreddit: subredditName,
                error: error instanceof Error ? error.message : String(error),
            },
            context
        );
    } finally {
        if (ownsLock) {
            await redis.del(lockKey);
        }
    }
}
