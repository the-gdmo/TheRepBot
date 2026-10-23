import { reddit, redis, scheduler, settings } from "@devvit/web/server";
import { addDays, addMinutes, subMinutes } from "date-fns";
import { CronExpressionParser } from "cron-parser";
import {
    ADHOC_CLEANUP_JOB,
    CLEANUP_JOB_CRON,
    UPDATE_LEADERBOARD_JOB,
} from "./constants";
import { POINTS_STORE_KEY } from "./triggers/utils/redisKeys";

const CLEANUP_LOG_KEY = "cleanupStore";
const DAYS_BETWEEN_CHECKS = 28;

interface CleanupEntry {
    member: string;
    score: number;
}

export async function setCleanupForUsers(usernames: string[]): Promise<void> {
    if (usernames.length === 0) {
        return;
    }

    await redis.zAdd(
        CLEANUP_LOG_KEY,
        ...usernames.map((username: string) => ({
            member: username,
            score: addDays(new Date(), DAYS_BETWEEN_CHECKS).getTime(),
        }))
    );
}

async function userActive(username: string): Promise<boolean> {
    try {
        const user = await reddit.getUserByUsername(username);
        return !!user;
    } catch {
        return false;
    }
}

interface UserActive {
    username: string;
    isActive: boolean;
}

export async function cleanupDeletedAccounts(
    _: unknown,
): Promise<void> {
    const now = Date.now();
    const items: CleanupEntry[] = await redis.zRange(CLEANUP_LOG_KEY, 0, now, {
        by: "score",
    });

    if (items.length === 0) {
        await scheduleAdhocCleanup();
        return;
    }

    const leaderboardSize =
        (await settings.get<number>("leaderboardSize")) ?? 50;
    await reddit.getAppUser(); // Ensure Reddit is reachable

    const itemsToCheck = leaderboardSize;
    const usersToCheck: string[] = items
        .slice(0, itemsToCheck)
        .map((item: CleanupEntry) => item.member);

    const userStatuses: UserActive[] = [];
    for (const username of usersToCheck) {
        const isActive = await userActive(username);
        userStatuses.push({ username, isActive });
    }

    const activeUsers = userStatuses
        .filter((u: UserActive) => u.isActive)
        .map((u: UserActive) => u.username);
    const deletedUsers = userStatuses
        .filter((u: UserActive) => !u.isActive)
        .map((u: UserActive) => u.username);

    if (activeUsers.length > 0) {
        await setCleanupForUsers(activeUsers);
    }

    if (deletedUsers.length > 0) {
        await redis.zRem(POINTS_STORE_KEY, deletedUsers);
        await redis.zRem(CLEANUP_LOG_KEY, deletedUsers);

        await scheduler.runJob({
            name: UPDATE_LEADERBOARD_JOB,
            runAt: new Date(),
            data: {
                reason: "One or more deleted accounts removed from database",
            },
        });
    }

    if (items.length > itemsToCheck) {
        await scheduler.runJob({
            name: "cleanupDeletedAccounts",
            runAt: new Date(),
        });
    } else {
        await scheduleAdhocCleanup();
    }
}

export async function populateCleanupLogAndScheduleCleanup(): Promise<void> {
    const scoreUsers: string[] = (
        await redis.zRange(POINTS_STORE_KEY, 0, -1)
    ).map((u: CleanupEntry) => u.member);
    const cleanupUsers: string[] = (
        await redis.zRange(CLEANUP_LOG_KEY, 0, -1)
    ).map((u: CleanupEntry) => u.member);

    const toAdd = scoreUsers.filter((u: string) => !cleanupUsers.includes(u));
    const toRemove = cleanupUsers.filter(
        (u: string) => !scoreUsers.includes(u)
    );

    if (toAdd.length > 0) {
        await redis.zAdd(
            CLEANUP_LOG_KEY,
            ...toAdd.map((username: string) => ({
                member: username,
                score: addMinutes(
                    new Date(),
                    Math.random() * 60 * 24 * DAYS_BETWEEN_CHECKS
                ).getTime(),
            }))
        );
    }

    if (toRemove.length > 0) {
        await redis.zRem(CLEANUP_LOG_KEY, toRemove);
    }

    const redisKey = "prevTimeBetweenChecks";
    const prev = await redis.get(redisKey);
    const newValue = JSON.stringify(DAYS_BETWEEN_CHECKS);

    if (newValue !== prev && cleanupUsers.length > 0) {
        await redis.zAdd(
            CLEANUP_LOG_KEY,
            ...cleanupUsers.map((username: string) => ({
                member: username,
                score: addMinutes(
                    new Date(),
                    Math.random() * 60 * 24 * DAYS_BETWEEN_CHECKS
                ).getTime(),
            }))
        );
        await redis.set(redisKey, newValue);
    }

    type ScheduledJob = { id: string; name: string };

    const jobs = await scheduler.listJobs();

    const adhocJobs = jobs.filter(
        (job: ScheduledJob) => job.name === ADHOC_CLEANUP_JOB
    );

    await Promise.all(
        adhocJobs.map((job: ScheduledJob) => scheduler.cancelJob(job.id))
    );

    await scheduleAdhocCleanup();
}

export async function scheduleAdhocCleanup(): Promise<void> {
    const nextEntries: CleanupEntry[] = await redis.zRange(
        CLEANUP_LOG_KEY,
        0,
        0,
        { by: "rank" }
    );

    if (nextEntries.length === 0) {
        return;
    }

    const nextEntry = nextEntries[0];
    if (!nextEntry) {
        return;
    }

    const nextCleanupTime = new Date(nextEntry.score);
    const nextAdhocTime = addMinutes(nextCleanupTime, 5);
    const nextScheduledTime = CronExpressionParser.parse(CLEANUP_JOB_CRON)
        .next()
        .toDate();

    if (nextAdhocTime < subMinutes(nextScheduledTime, 5)) {
        await scheduler.runJob({
            name: ADHOC_CLEANUP_JOB,
            runAt: nextAdhocTime < new Date() ? new Date() : nextAdhocTime,
        });
    }
}
