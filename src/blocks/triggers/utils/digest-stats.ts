import { TriggerContext } from "@devvit/public-api";

/**
 * The hash contains ALL digest metrics for the current reporting window:
 *   mod:<lowercase-username>  -> number of points awarded by this moderator
 *   user:<lowercase-username> -> number of points awarded by this non-mod
 *   posts                     -> number of submitted posts
 *
 * The permanent reputation scores in POINTS_STORE_KEY are deliberately separate.
 */
export const DIGEST_STATS_KEY = "repbot:modDigest:stats";

/** The digest job atomically moves the last window here before delivery. */
export const DIGEST_PENDING_KEY = `${DIGEST_STATS_KEY}:pending`;

export async function recordDigestPointAward(
    context: TriggerContext,
    awarder: string,
    awarderIsModerator: boolean
): Promise<void> {
    const normalized = awarder.trim().toLowerCase();
    if (!normalized) return;
    const field = `${awarderIsModerator ? "mod" : "user"}:${normalized}`;
    // Atomic increment; one point per successfully applied award.
    await context.redis.hIncrBy(DIGEST_STATS_KEY, field, 1);
}

export async function recordDigestPost(context: TriggerContext): Promise<void> {
    await context.redis.hIncrBy(DIGEST_STATS_KEY, "posts", 1);
}
