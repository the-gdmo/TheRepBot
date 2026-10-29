import { populateCleanupLogAndScheduleCleanup } from "./cleanupTasks";
import type { Context } from "hono";
import type { TriggerResponse } from "@devvit/web/shared";
import { redis, scheduler } from "@devvit/web/server";
import { logger } from "../core/clientCore/utils/logger";
// import { createCompatContext } from "./compat";

function jsonResponse(
    body: TriggerResponse,
    status = 200
): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json",
        },
    });
}

export const onAppInstall = async (_c: Context): Promise<Response> => {
    logger.info("App install triggered");

    try {
        const existing = await redis.get("InstallDate");

        if (!existing) {
            await redis.set("InstallDate", Date.now().toString());
            logger.info("Install date saved");
        }

        return jsonResponse({ message: "app installed" }, 200);
    } catch (error) {
        logger.error("App install failed", { error });
        return jsonResponse({ message: "app install failed" }, 500);
    }
};

export const onAppUpgrade = async (_c: Context): Promise<Response> => {
    logger.info("App upgrade triggered");

    let totalJobs = 0;
    let canceledJobs = 0;
    let failedJobs = 0;

    try {
        const allJobs = await scheduler.listJobs();
        totalJobs = allJobs.length;

        logger.info("Starting app-upgrade job cleanup", { totalJobs });

        const results = await Promise.allSettled(
            allJobs.map((job) => scheduler.cancelJob(job.id))
        );

        const failures: Array<{ jobId: string; error: string }> = [];

        results.forEach((result, index) => {
            if (result.status === "fulfilled") {
                canceledJobs++;
            } else {
                failedJobs++;
                failures.push({
                    jobId: String(allJobs[index]?.id ?? "unknown"),
                    error: String(result.reason),
                });
            }
        });

        logger.info("App-upgrade job cancellation completed", {
            totalJobs,
            canceledJobs,
            failedJobs,
        });

        if (failures.length > 0) {
            logger.error("Some scheduled jobs could not be canceled", {
                failures,
            });
        }

        // IMPORTANT: supply the compatibility  which includes redis.
        // const compatContext = createCompatContext();
        await populateCleanupLogAndScheduleCleanup();

        logger.info("App-upgrade cleanup scheduling completed");

        return jsonResponse(
            { message: "app upgraded" },
            200
        );
    } catch (error) {
        logger.error("App upgrade failed", {
            error:
                error instanceof Error
                    ? { message: error.message, stack: error.stack }
                    : String(error),
            totalJobs,
            canceledJobs,
            failedJobs,
        });

        return jsonResponse(
            { message: "app upgrade failed" },
            500
        );
    }
};