import { reddit, redis, scheduler, settings } from "@devvit/web/server";
import { CronExpressionParser } from "cron-parser";

import { CLEANUP_LOG_KEY, POINTS_STORE_KEY } from "./redisKeys";

import {
    ADHOC_CLEANUP_JOB,
    CLEANUP_JOB_CRON,
    UPDATE_LEADERBOARD_JOB,
} from "../clientCore/constants";

import { logger } from "./logger";
import { ensurePointsStoreIsSortedSet } from "../clientCore/leaderboard";

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

const DAYS_BETWEEN_CHECKS = 28;

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = DAYS_BETWEEN_CHECKS * DAY_MS;

const DEFAULT_BATCH_SIZE = 50;
const MAX_BATCH_SIZE = 100;
const REDIS_BATCH_SIZE = 500;
const REDIS_SCAN_COUNT = 500;
const USER_CHECK_CONCURRENCY = 5;

const PREVIOUS_CHECK_INTERVAL_KEY = "prevTimeBetweenChecks";

interface CleanupEntry {
    member: string;
    score: number;
}

interface UserActive {
    username: string;
    isActive: boolean;
}

// -----------------------------------------------------------------------------
// General helpers
// -----------------------------------------------------------------------------

function uniqueStrings(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}

function chunks<T>(items: T[], size: number): T[][] {
    const result: T[][] = [];

    for (let i = 0; i < items.length; i += size) {
        result.push(items.slice(i, i + size));
    }

    return result;
}

function randomCleanupTime(now: number = Date.now()): number {
    return now + Math.floor(Math.random() * CHECK_INTERVAL_MS);
}

async function mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    callback: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let cursor = 0;

    const workers = Array.from(
        { length: Math.min(concurrency, items.length) },
        async () => {
            while (true) {
                const index = cursor++;

                if (index >= items.length) {
                    return;
                }

                results[index] = await callback(items[index]!);
            }
        }
    );

    await Promise.all(workers);

    return results;
}

// -----------------------------------------------------------------------------
// Redis type protection
// -----------------------------------------------------------------------------

async function assertSortedSetOrMissing(key: string): Promise<void> {
    const actualType = await redis.type(key);

    if (actualType !== "zset" && actualType !== "none") {
        throw new Error(
            `Redis WRONGTYPE prevented: key "${key}" has type "${actualType}", expected "zset".`
        );
    }
}

/**
 * Reads a sorted set using cursor-based pagination.
 * This avoids loading a potentially large collection in one Redis response.
 */
async function readAllSortedSetEntries(key: string): Promise<CleanupEntry[]> {
    await assertSortedSetOrMissing(key);

    const entries: CleanupEntry[] = [];
    let cursor = 0;

    do {
        const response = await redis.zScan(
            key,
            cursor,
            undefined,
            REDIS_SCAN_COUNT
        );

        entries.push(...response.members);
        cursor = response.cursor;
    } while (cursor !== 0);

    return entries;
}

/**
 * Adds sorted-set entries in manageable batches.
 */
async function addSortedSetEntries(
    key: string,
    entries: CleanupEntry[]
): Promise<void> {
    if (entries.length === 0) {
        return;
    }

    for (const batch of chunks(entries, REDIS_BATCH_SIZE)) {
        await redis.zAdd(key, ...batch);
    }
}

/**
 * Removes sorted-set members in manageable batches.
 */
async function removeSortedSetMembers(
    key: string,
    members: string[]
): Promise<void> {
    const uniqueMembers = uniqueStrings(members);

    if (uniqueMembers.length === 0) {
        return;
    }

    for (const batch of chunks(uniqueMembers, REDIS_BATCH_SIZE)) {
        await redis.zRem(key, batch);
    }
}

/**
 * The cleanup log is a rebuildable index of POINTS_STORE_KEY.
 *
 * If it has an unexpected Redis type:
 * 1. Preserve the old value under a backup key.
 * 2. Reconstruct the sorted set from the reputation database.
 * 3. Assign fresh cleanup timestamps.
 *
 * POINTS_STORE_KEY is never automatically deleted or overwritten.
 */
async function ensureCleanupLogKey(): Promise<void> {
    // The points database is the source of truth. Repair a legacy non-ZSET
    // before using it to rebuild the cleanup index.
    await ensurePointsStoreIsSortedSet();
    await assertSortedSetOrMissing(POINTS_STORE_KEY);

    const cleanupType = await redis.type(CLEANUP_LOG_KEY);

    if (cleanupType === "zset" || cleanupType === "none") {
        return;
    }

    // Preserve unexpected data rather than deleting it.
    const backupPrefix = `${CLEANUP_LOG_KEY}:wrongtype-backup:${Date.now()}`;

    let backupKey = backupPrefix;
    let suffix = 0;

    while (await redis.exists(backupKey)) {
        backupKey = `${backupPrefix}:${++suffix}`;
    }

    try {
        await redis.rename(CLEANUP_LOG_KEY, backupKey);
    } catch (error) {
        // Another concurrent invocation may have repaired the key.
        const currentType = await redis.type(CLEANUP_LOG_KEY);

        if (currentType === "zset" || currentType === "none") {
            return;
        }

        throw new Error(
            `Unable to preserve incorrectly typed cleanup key "${CLEANUP_LOG_KEY}". ` +
                `Existing type: ${currentType}. ` +
                `Cause: ${
                    error instanceof Error ? error.message : String(error)
                }`
        );
    }

    logger.info("Incorrectly typed cleanup key archived", {
        key: CLEANUP_LOG_KEY,
        previousType: cleanupType,
        backupKey,
    });

    // Rebuild the cleanup index from the authoritative points database.
    const scoreEntries = await readAllSortedSetEntries(POINTS_STORE_KEY);
    const now = Date.now();

    const rebuiltEntries: CleanupEntry[] = scoreEntries.map(({ member }) => ({
        member,
        score: randomCleanupTime(now),
    }));

    await addSortedSetEntries(CLEANUP_LOG_KEY, rebuiltEntries);

    logger.info("Cleanup log rebuilt successfully", {
        restoredEntries: rebuiltEntries.length,
    });
}

// -----------------------------------------------------------------------------
// Cleanup scheduling helpers
// -----------------------------------------------------------------------------

async function scheduleNextAdhocCleanup(): Promise<void> {
    const nextEntries: CleanupEntry[] = await redis.zRange(
        CLEANUP_LOG_KEY,
        0,
        0,
        { by: "rank" }
    );

    const nextEntry = nextEntries[0];

    if (!nextEntry) {
        logger.info("No cleanup entries to schedule");
        return;
    }

    const now = Date.now();

    const nextCleanupTime = nextEntry.score;
    const nextAdhocTime = nextCleanupTime + 5 * 60 * 1000;

    const nextScheduledTime = CronExpressionParser.parse(CLEANUP_JOB_CRON)
        .next()
        .toDate()
        .getTime();

    // Do not schedule an ad-hoc job unnecessarily close to
    // the next regular cleanup execution.
    const shouldScheduleAdhoc =
        nextAdhocTime < nextScheduledTime - 5 * 60 * 1000;

    if (!shouldScheduleAdhoc) {
        logger.info("Regular cleanup is scheduled soon enough");
        return;
    }

    const runAt = new Date(Math.max(nextAdhocTime, now));

    await scheduler.runJob({
        name: ADHOC_CLEANUP_JOB,
        runAt,
    });

    logger.info("Ad-hoc cleanup scheduled", {
        runAt: runAt.toISOString(),
        nextCleanupTime: new Date(nextCleanupTime).toISOString(),
    });
}

export async function scheduleAdhocCleanup(): Promise<void> {
    await ensureCleanupLogKey();
    await scheduleNextAdhocCleanup();
}

// -----------------------------------------------------------------------------
// Set cleanup dates
// -----------------------------------------------------------------------------

async function addCleanupUsers(usernames: string[]): Promise<void> {
    const users = uniqueStrings(usernames);

    if (users.length === 0) {
        return;
    }

    const nextCheckTime = Date.now() + CHECK_INTERVAL_MS;

    const entries: CleanupEntry[] = users.map((username) => ({
        member: username,
        score: nextCheckTime,
    }));

    await addSortedSetEntries(CLEANUP_LOG_KEY, entries);
}

export async function setCleanupForUsers(usernames: string[]): Promise<void> {
    if (usernames.length === 0) {
        return;
    }

    await ensureCleanupLogKey();
    await addCleanupUsers(usernames);
}

// -----------------------------------------------------------------------------
// Reddit user verification
// -----------------------------------------------------------------------------

async function userActive(username: string): Promise<boolean> {
    // Devvit returns undefined for a user that does not exist
    // or is suspended.
    //
    // IMPORTANT:
    // Do not catch API failures and interpret them as deleted users.
    const user = await reddit.getUserByUsername(username);

    return user !== undefined;
}

// -----------------------------------------------------------------------------
// Cleanup deleted accounts
// -----------------------------------------------------------------------------

export async function cleanupDeletedAccounts(_: unknown): Promise<void> {
    const now = Date.now();

    await ensureCleanupLogKey();

    // Read one more entry than the batch size to determine
    // whether another execution is required.
    const configuredSize = await settings.get<number>("leaderboardSize");

    const batchSize =
        typeof configuredSize === "number" &&
        Number.isFinite(configuredSize) &&
        configuredSize > 0
            ? Math.min(Math.floor(configuredSize), MAX_BATCH_SIZE)
            : DEFAULT_BATCH_SIZE;

    const dueEntries: CleanupEntry[] = await redis.zRange(
        CLEANUP_LOG_KEY,
        0,
        now,
        {
            by: "score",
            limit: {
                offset: 0,
                count: batchSize + 1,
            },
        }
    );

    if (dueEntries.length === 0) {
        await scheduleNextAdhocCleanup();
        return;
    }

    const hasMoreDueEntries = dueEntries.length > batchSize;
    const entriesToCheck = dueEntries.slice(0, batchSize);

    const usernames = uniqueStrings(
        entriesToCheck.map((entry) => entry.member)
    );

    logger.info("Starting deleted-account verification", {
        entriesToCheck: usernames.length,
        hasMoreDueEntries,
    });

    // Check users concurrently, but keep concurrency bounded
    // to avoid unnecessarily stressing the Reddit API.
    const userStatuses: UserActive[] = await mapWithConcurrency(
        usernames,
        USER_CHECK_CONCURRENCY,
        async (username) => ({
            username,
            isActive: await userActive(username),
        })
    );

    const activeUsers = userStatuses
        .filter((user) => user.isActive)
        .map((user) => user.username);

    const deletedUsers = userStatuses
        .filter((user) => !user.isActive)
        .map((user) => user.username);

    // Active users receive a fresh cleanup date.
    if (activeUsers.length > 0) {
        await addCleanupUsers(activeUsers);
    }

    // Remove deleted users from both sorted sets.
    if (deletedUsers.length > 0) {
        await removeSortedSetMembers(POINTS_STORE_KEY, deletedUsers);

        await removeSortedSetMembers(CLEANUP_LOG_KEY, deletedUsers);

        logger.info("Deleted accounts removed", {
            count: deletedUsers.length,
        });

        await scheduler.runJob({
            name: UPDATE_LEADERBOARD_JOB,
            runAt: new Date(),
            data: {
                reason: "One or more deleted accounts removed from database",
            },
        });
    }

    logger.info("Deleted-account verification completed", {
        checked: usernames.length,
        active: activeUsers.length,
        deleted: deletedUsers.length,
    });

    // Continue processing immediately if more users are due.
    if (hasMoreDueEntries) {
        await scheduler.runJob({
            name: "cleanupDeletedAccounts",
            runAt: new Date(),
        });

        logger.info("Another cleanup batch scheduled");
        return;
    }

    await scheduleNextAdhocCleanup();
}

// -----------------------------------------------------------------------------
// Populate cleanup log during installation or upgrade
// -----------------------------------------------------------------------------

export async function populateCleanupLogAndScheduleCleanup(): Promise<void> {
    logger.info("Starting cleanup log synchronization");

    await ensureCleanupLogKey();

    // Read both sorted sets using paginated scans.
    const [scoreEntries, cleanupEntries] = await Promise.all([
        readAllSortedSetEntries(POINTS_STORE_KEY),
        readAllSortedSetEntries(CLEANUP_LOG_KEY),
    ]);

    const scoreUsers = uniqueStrings(scoreEntries.map((entry) => entry.member));

    const cleanupUsers = uniqueStrings(
        cleanupEntries.map((entry) => entry.member)
    );

    const scoreUserSet = new Set(scoreUsers);
    const cleanupUserSet = new Set(cleanupUsers);

    const toAdd = scoreUsers.filter(
        (username) => !cleanupUserSet.has(username)
    );

    const toRemove = cleanupUsers.filter(
        (username) => !scoreUserSet.has(username)
    );

    await ensureStringOrMissing(PREVIOUS_CHECK_INTERVAL_KEY);

    const previousInterval = await redis.get(PREVIOUS_CHECK_INTERVAL_KEY);

    const currentInterval = String(DAYS_BETWEEN_CHECKS);

    const intervalChanged = previousInterval !== currentInterval;

    const now = Date.now();

    // If the interval changed, recalculate all cleanup timestamps.
    // Otherwise, add only missing users.
    const usersToSchedule = intervalChanged ? scoreUsers : toAdd;

    if (usersToSchedule.length > 0) {
        const entries: CleanupEntry[] = usersToSchedule.map((username) => ({
            member: username,
            score: randomCleanupTime(now),
        }));

        await addSortedSetEntries(CLEANUP_LOG_KEY, entries);
    }

    if (toRemove.length > 0) {
        await removeSortedSetMembers(CLEANUP_LOG_KEY, toRemove);
    }

    // Save the interval only after the synchronization succeeds.
    if (intervalChanged) {
        await redis.set(PREVIOUS_CHECK_INTERVAL_KEY, currentInterval);
    }

    logger.info("Cleanup log synchronization completed", {
        reputationUsers: scoreUsers.length,
        previousCleanupUsers: cleanupUsers.length,
        added: toAdd.length,
        removed: toRemove.length,
        intervalChanged,
    });

    // Remove previously scheduled ad-hoc cleanup jobs.
    const jobs = await scheduler.listJobs();

    const adhocJobs = jobs.filter((job) => job.name === ADHOC_CLEANUP_JOB);

    const cancellationResults = await Promise.allSettled(
        adhocJobs.map((job) => scheduler.cancelJob(job.id))
    );

    const cancellationFailures = cancellationResults.filter(
        (result) => result.status === "rejected"
    );

    if (cancellationFailures.length > 0) {
        logger.info("Some previous ad-hoc jobs could not be canceled", {
            failures: cancellationFailures.length,
        });
    }

    await scheduleNextAdhocCleanup();

    logger.info("Cleanup initialization completed");
}

async function ensureStringOrMissing(key: string): Promise<void> {
    const actualType = await redis.type(key);

    if (actualType === "string" || actualType === "none") {
        return;
    }

    const backupKey = `${key}:wrongtype-backup:${Date.now()}`;

    await redis.rename(key, backupKey);

    logger.info("Incorrectly typed string key archived", {
        key,
        previousType: actualType,
        backupKey,
    });
}
