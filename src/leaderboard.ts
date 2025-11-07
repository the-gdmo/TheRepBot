import {
    ScheduledJobEvent,
    JobContext,
    WikiPagePermissionLevel,
    JSONObject,
    WikiPage,
} from "@devvit/public-api";
import { format,  } from "date-fns";
import { AppSetting, LeaderboardMode, TemplateDefaults } from "./settings.js";
import { getSubredditName } from "./utility.js";
import pluralize from "pluralize";
import { logger } from "./logger.js";

export const TIMEFRAMES = [
    "alltime",
] as const;

const POINTS_STORE_KEY = "thanksPointsStore";

function capitalize(word: string): string {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

function markdownEscape(input: string): string {
    return input.replace(/([\\`*_{}\[\]()#+\-.!])/g, "\\$1");
}

export async function updateLeaderboard(
    event: ScheduledJobEvent<JSONObject | undefined>,
    context: JobContext
) {
    const settings = await context.settings.getAll();

    const leaderboardMode = settings[AppSetting.LeaderboardMode] as
        | string[]
        | undefined;
    if (
        !leaderboardMode ||
        leaderboardMode.length === 0 ||
        (leaderboardMode[0] as LeaderboardMode) === LeaderboardMode.Off
    ) {
        logger.debug("🏁 Leaderboard mode off — skipping update.");
        return;
    }

    const wikiPageName =
        (settings[AppSetting.LeaderboardName] as string | undefined) ??
        "leaderboard";
    const leaderboardSize =
        (settings[AppSetting.LeaderboardSize] as number | undefined) ?? 20;

    const subredditName = await getSubredditName(context);
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const helpPage = settings[AppSetting.PointSystemHelpPage] as
        | string
        | undefined;

    // ──────────────── Fetch scores ────────────────
    const highScores = await context.redis.zRange(
        POINTS_STORE_KEY,
        0,
        leaderboardSize - 1,
        { by: "rank", reverse: true }
    );

    // ──────────────── Build markdown ────────────────
    let wikiContents = `# ${capitalize(pointName)}board for ${subredditName}\n\n`;
    if (helpPage) {
        wikiContents += `[How to award ${pointName}s on /r/${subredditName}](https://old.reddit.com/r/${subredditName}/wiki/${helpPage})\n\n`;
    }

    wikiContents += `User | ${capitalize(pointName)}s Earned\n-|-\n`;

    if (highScores.length > 0) {
        wikiContents += highScores
            .map((entry) => `${markdownEscape(entry.member)}|${entry.score}`)
            .join("\n");
    } else {
        wikiContents += "_No users have been awarded yet._";
    }

    wikiContents += `\n\nThe leaderboard shows the top ${leaderboardSize} ${pluralize(
        "user",
        leaderboardSize
    )} who ${pluralize("has", leaderboardSize)} been awarded at least one ${pointName}`;

    const installDateTimestamp = await context.redis.get("InstallDate");
    if (installDateTimestamp) {
        const installDate = new Date(parseInt(installDateTimestamp));
        wikiContents += ` since ${installDate.toUTCString()}`;
    }
    wikiContents += ".";

    // ──────────────── Safe wiki handling ────────────────
    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(subredditName, wikiPageName);
    } catch {
        //
    }

    const wikiPageOptions = {
        subredditName,
        page: wikiPageName,
        content: wikiContents,
        reason: event.data?.reason as string | undefined,
    };

    if (wikiPage) {
        if (wikiPage.content !== wikiContents) {
            await context.reddit.updateWikiPage(wikiPageOptions);
            console.log("Leaderboard: Leaderboard updated.");
        }
    } else {
        wikiPage = await context.reddit.createWikiPage(wikiPageOptions);
        console.log("Leaderboard: Leaderboard created.");
    }

    const correctPermissionLevel = leaderboardMode[0] as LeaderboardMode === LeaderboardMode.Public ? WikiPagePermissionLevel.SUBREDDIT_PERMISSIONS : WikiPagePermissionLevel.MODS_ONLY;

    const wikiPageSettings = await wikiPage.getSettings();
    if (wikiPageSettings.permLevel !== correctPermissionLevel) {
        await context.reddit.updateWikiPageSettings({
            subredditName,
            page: wikiPageName,
            listed: true,
            permLevel: correctPermissionLevel,
        });
    }
}