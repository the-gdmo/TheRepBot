
import type { Context } from "hono";
import {
    TaskResponse,
    ScheduledJob,
    scheduler,
    redis,
} from "@devvit/web/server";
import { checkForUpdates } from "../../upgradeNotify/upgradeNotifier";

type ScheduleUpdateCheckRequest = {
    delayMinutes: number;
};

type ScheduleUpdateCheckResponse = {
    jobId: string;
    message: string;
};

export const handleUpdateCheckJob = async (
    c: Context
): Promise<Response> => {
    const { delayMinutes } =
        await c.req.json<ScheduleUpdateCheckRequest>();

    const runAt = new Date(
        Date.now() + delayMinutes * 60 * 1000
    );

    const scheduledJob: ScheduledJob = {
        id: `update-check-${Date.now()}`,
        name: "update-check",
        data: {},
        runAt,
    };

    const jobId = await scheduler.runJob(scheduledJob);

    await redis.set("update-check-job", jobId);

    return c.json<ScheduleUpdateCheckResponse>(
        {
            jobId,
            message: "Update check scheduled successfully",
        },
        200
    );
};

export const runUpdateCheckJob = async (
    c: Context
): Promise<Response> => {
    await checkForUpdates();

    return c.json<TaskResponse>({ success: true }, 200);
};
