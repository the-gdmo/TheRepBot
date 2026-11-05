import {
    context,
    ModMailService,
    reddit,
    redis,
    settings,
} from "@devvit/web/server";

import type { Context } from "hono";

import { logger } from "../utils/logger";

import { DIGEST_PENDING_KEY, DIGEST_STATS_KEY } from "../utils/digest-stats";

const DIGEST_PREFIX = "repbot:modDigest";

const DIGEST_LOCK_KEY = `${DIGEST_PREFIX}:lock`;
const DIGEST_LOCK_SECONDS = 600;

const LAST_SENT_KEY = `${DIGEST_PREFIX}:lastSentAt`;
const CONVERSATION_KEY = `${DIGEST_PREFIX}:conversationId`;
const CONVERSATION_TYPE_KEY = `${DIGEST_PREFIX}:conversationType`;

const DESIRED_CONVERSATION_TYPE = "notification";

type DigestEntry = {
    username: string;
    count: number;
};

function getSettingValue(value: unknown): unknown {
    return Array.isArray(value) ? value[0] : value;
}

function getSettingString(value: unknown): string | undefined {
    const normalized = getSettingValue(value);

    if (typeof normalized !== "string") {
        return undefined;
    }

    return normalized.trim();
}

function getSettingBoolean(value: unknown): boolean {
    const normalized = getSettingValue(value);

    if (normalized === true || normalized === 1) {
        return true;
    }

    if (typeof normalized === "string") {
        return ["true", "1", "yes", "on"].includes(
            normalized.trim().toLowerCase()
        );
    }

    return false;
}

function formatNumber(value: number): string {
    return value.toLocaleString("en-US");
}

function sortDigestEntries(a: DigestEntry, b: DigestEntry): number {
    return b.count - a.count || a.username.localeCompare(b.username);
}

function formatTopTen(entries: DigestEntry[]): string {
    if (entries.length === 0) {
        return "_None this period._";
    }

    return entries
        .slice(0, 10)
        .map(
            (entry, index) =>
                `${index + 1}. u/${entry.username} — ${formatNumber(
                    entry.count
                )} points`
        )
        .join("\n");
}

/**
 * Moderator digest scheduled endpoint.
 *
 * Register using:
 *
 * application.post(
 *     "/internal/scheduler/mod-digest",
 *     modDigestJob
 * );
 *
 * Only the current reporting window's award and post counters
 * are rotated. Reputation balances, flair, wiki history,
 * and leaderboard data remain untouched.
 */

export async function modDigestJob(c: Context): Promise<Response> {
    const subredditName = context.subredditName;
    const subredditId = context.subredditId;

    if (!subredditName || !subredditId) {
        logger.warn("Mod digest: missing subreddit context", {
            subredditName,
            subredditId,
        });

        return c.json(
            {
                message:
                    "Cannot run the moderator digest because subreddit context is missing.",
            },
            500
        );
    }

    const now = Date.now();

    let ownsLock = false;
    let lockToken: string | undefined;

    try {
        // ---------------------------------------------------------
        // 1. Read settings
        // ---------------------------------------------------------

        const [settingDigestFrequency, settingDigestNewMessageEachDay] =
            await Promise.all([
                settings.get("digestFrequency"),
                settings.get("digestNewMessageEachDay"),
            ]);

        const frequency = getSettingString(settingDigestFrequency);

        const newConversation = getSettingBoolean(
            settingDigestNewMessageEachDay
        );

        const intervalMs: Record<string, number> = {
            Testing: 5 * 60 * 1000,
            Daily: 24 * 60 * 60 * 1000,
            Weekly: 7 * 24 * 60 * 60 * 1000,
            Monthly: 30 * 24 * 60 * 60 * 1000,
        };

        if (frequency === "Never") {
            logger.info("Mod digest: disabled in settings", {
                subreddit: subredditName,
            });

            return c.json(
                {
                    message:
                        "Moderator digest skipped because digest frequency is set to Never.",
                },
                200
            );
        }

        if (
            !frequency ||
            !Object.prototype.hasOwnProperty.call(intervalMs, frequency)
        ) {
            logger.warn("Mod digest: invalid frequency setting", {
                subreddit: subredditName,
                rawSetting: settingDigestFrequency,
                frequency,
            });

            return c.json(
                {
                    message:
                        "Moderator digest skipped because the configured frequency is invalid.",
                    frequency,
                },
                400
            );
        }

        const interval = intervalMs[frequency];

        if (!interval) {
            return c.json(
                {
                    message:
                        "Moderator digest skipped because no valid interval is configured.",
                    frequency,
                },
                400
            );
        }

        // ---------------------------------------------------------
        // 2. Check whether the digest is due
        // ---------------------------------------------------------

        const lastSentRaw = await redis.get(LAST_SENT_KEY);

        const parsedLastSent = lastSentRaw === null ? NaN : Number(lastSentRaw);

        const lastSentAt = Number.isFinite(parsedLastSent)
            ? parsedLastSent
            : undefined;

        if (lastSentAt !== undefined && now - lastSentAt < interval) {
            const remainingMs = interval - (now - lastSentAt);

            const nextSendAt = lastSentAt + interval;

            logger.info("Mod digest: not due yet", {
                subreddit: subredditName,
                frequency,
                lastSentAt: new Date(lastSentAt).toLocaleString("en-US"),
                nextSendAt: new Date(nextSendAt).toLocaleString("en-US"),
                timeUntilNextSendSeconds: Math.ceil(remainingMs / 1000),
            });

            return c.json(
                {
                    message:
                        "Moderator digest skipped because it is not due yet.",
                    nextSendAt,
                },
                200
            );
        }

        // ---------------------------------------------------------
        // 3. Acquire a temporary Redis lock
        // ---------------------------------------------------------

        lockToken = `${now}:${Math.random().toString(36).slice(2)}`;

        const lockResult = await redis.set(DIGEST_LOCK_KEY, lockToken, {
            nx: true,
        });

        if (lockResult !== "OK") {
            logger.info("Mod digest: another invocation owns the lock", {
                subreddit: subredditName,
            });

            return c.json(
                {
                    message:
                        "Moderator digest skipped because another invocation is already running.",
                },
                200
            );
        }

        ownsLock = true;

        // Expire the lock if this invocation crashes.
        await redis.expire(DIGEST_LOCK_KEY, DIGEST_LOCK_SECONDS);

        logger.info("Mod digest: acquired delivery lock", {
            subreddit: subredditName,
        });

        // ---------------------------------------------------------
        // 4. Recheck schedule after acquiring lock
        // ---------------------------------------------------------

        const lastSentAfterLock = await redis.get(LAST_SENT_KEY);

        const lastSentAfterLockNumber =
            lastSentAfterLock === null ? NaN : Number(lastSentAfterLock);

        if (
            Number.isFinite(lastSentAfterLockNumber) &&
            now - lastSentAfterLockNumber < interval
        ) {
            logger.info(
                "Mod digest: another invocation already sent the digest",
                { subreddit: subredditName }
            );

            return c.json(
                {
                    message:
                        "Moderator digest skipped because another invocation already sent it.",
                },
                200
            );
        }

        // ---------------------------------------------------------
        // 5. Freeze the reporting batch
        // ---------------------------------------------------------

        const hasPending = await redis.exists(DIGEST_PENDING_KEY);

        // Never overwrite an existing pending batch.
        // If a previous send failed, retry that batch first.
        if (!hasPending && (await redis.exists(DIGEST_STATS_KEY))) {
            await redis.rename(DIGEST_STATS_KEY, DIGEST_PENDING_KEY);

            logger.info(
                "Mod digest: active statistics moved to pending batch",
                { subreddit: subredditName }
            );
        }

        const values = (await redis.hGetAll(DIGEST_PENDING_KEY)) ?? {};

        // ---------------------------------------------------------
        // 6. Build digest statistics
        // ---------------------------------------------------------

        const moderators: DigestEntry[] = [];
        const users: DigestEntry[] = [];

        let postsCreated = 0;

        for (const [field, rawValue] of Object.entries(values)) {
            const count = Number(rawValue);

            if (!Number.isFinite(count) || count <= 0) {
                continue;
            }

            if (field === "posts") {
                postsCreated += count;
            } else if (field.startsWith("mod:")) {
                const username = field.slice(4);

                if (username) {
                    moderators.push({
                        username,
                        count,
                    });
                }
            } else if (field.startsWith("user:")) {
                const username = field.slice(5);

                if (username) {
                    users.push({
                        username,
                        count,
                    });
                }
            }
        }

        moderators.sort(sortDigestEntries);
        users.sort(sortDigestEntries);

        const totalPoints = [...moderators, ...users].reduce(
            (sum, entry) => sum + entry.count,
            0
        );

        logger.info("Mod digest: reporting batch prepared", {
            subreddit: subredditName,
            frequency,
            pendingFields: Object.keys(values).length,
            totalPoints,
            moderators: moderators.length,
            users: users.length,
            postsCreated,
        });

        // ---------------------------------------------------------
        // 7. Build message
        // ---------------------------------------------------------

        const reportingPeriodStart = lastSentAt ?? now - interval;

        const subject = `RepBot ${frequency} Digest — r/${subredditName}`;

        const body = [
            `**Reporting Period:** ${new Date(
                reportingPeriodStart
            ).toUTCString()} → ${new Date(now).toUTCString()}`,

            `**Total points awarded:** ${formatNumber(totalPoints)}`,

            `**Moderators who awarded points:** ${formatNumber(
                moderators.length
            )}`,

            `**Users who awarded points:** ${formatNumber(users.length)}`,

            `**Posts created:** ${formatNumber(postsCreated)}`,

            `## Users who awarded the most points\n${formatTopTen(users)}`,

            `## Moderators who awarded the most points\n${formatTopTen(
                moderators
            )}`,
        ].join("\n\n");

        // ---------------------------------------------------------
        // 8. Send or update Mod Mail conversation
        // ---------------------------------------------------------

        const [previousConversationId, previousConversationType] =
            await Promise.all([
                redis.get(CONVERSATION_KEY),
                redis.get(CONVERSATION_TYPE_KEY),
            ]);

        const modMail = reddit.modMail as ModMailService;

        let conversationId: string | undefined;

        if (
            !newConversation &&
            previousConversationId &&
            previousConversationType === DESIRED_CONVERSATION_TYPE
        ) {
            try {
                logger.info("Mod digest: replying to existing conversation", {
                    subreddit: subredditName,
                    conversationId: previousConversationId,
                });

                await modMail.reply({
                    conversationId: previousConversationId,
                    body,
                });

                conversationId = previousConversationId;

                logger.info(
                    "Mod digest: existing conversation reply succeeded",
                    {
                        subreddit: subredditName,
                        conversationId,
                    }
                );
            } catch (replyError) {
                logger.warn(
                    "Mod digest: reply failed; creating a new notification",
                    {
                        subreddit: subredditName,
                        conversationId: previousConversationId,
                        error:
                            replyError instanceof Error
                                ? replyError.message
                                : String(replyError),
                    }
                );
            }
        }

        if (!conversationId) {
            logger.info("Mod digest: creating new Mod Mail notification", {
                subreddit: subredditName,
            });

            conversationId = await modMail.createModNotification({
                subredditId: subredditId as `t5_${string}`,
                subject,
                bodyMarkdown: body,
            });
        }

        if (
            typeof conversationId !== "string" ||
            conversationId.trim().length === 0
        ) {
            throw new Error("Mod Mail did not return a valid conversation ID.");
        }

        // ---------------------------------------------------------
        // 9. Mark successful delivery
        // ---------------------------------------------------------

        const sentAt = Date.now();

        await Promise.all([
            redis.set(LAST_SENT_KEY, sentAt.toString()),
            redis.set(CONVERSATION_KEY, conversationId),
            redis.set(CONVERSATION_TYPE_KEY, DESIRED_CONVERSATION_TYPE),
        ]);

        // Clear only the successfully reported pending batch.
        // Leave the active statistics untouched.
        await redis.del(DIGEST_PENDING_KEY);

        logger.info("RepBot moderator digest successfully sent", {
            subreddit: subredditName,
            frequency,
            conversationId,
            sentAt: new Date(sentAt).toISOString(),
            totalPoints,
            moderators: moderators.length,
            users: users.length,
            postsCreated,
        });

        return c.json(
            {
                message: `Moderator digest successfully sent to r/${subredditName}.`,
                conversationId,
                totalPoints,
                moderators: moderators.length,
                users: users.length,
                postsCreated,
            },
            200
        );
    } catch (error) {
        const errorMessage =
            error instanceof Error ? error.message : String(error);

        logger.error("RepBot mod digest failed; pending statistics retained", {
            subreddit: subredditName,
            error: errorMessage,
            stack: error instanceof Error ? error.stack : undefined,
        });

        return c.json(
            {
                message: `Moderator digest delivery failed: ${errorMessage}`,
            },
            500
        );
    } finally {
        // ---------------------------------------------------------
        // 10. Release lock
        // ---------------------------------------------------------

        if (ownsLock && lockToken) {
            try {
                const currentLock = await redis.get(DIGEST_LOCK_KEY);

                if (currentLock === lockToken) {
                    await redis.del(DIGEST_LOCK_KEY);
                }
            } catch (lockError) {
                logger.warn(
                    "Mod digest: lock release failed; lock will expire automatically",
                    {
                        subreddit: subredditName,
                        error:
                            lockError instanceof Error
                                ? lockError.message
                                : String(lockError),
                    }
                );
            }
        }
    }
}
