import {
    JobContext,
    JSONObject,
    ScheduledJobEvent,
    WikiPage,
    WikiPagePermissionLevel,
} from "@devvit/public-api";
import { LeaderboardMode, AppSetting } from "./settings.js";
import { POINTS_STORE_KEY } from "./thanksPoints.js";
import markdownEscape from "markdown-escape";
import pluralize from "pluralize";

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
        return;
    }

    const wikiPageName = settings[AppSetting.ScoreboardName] as
        | string
        | undefined;
    if (!wikiPageName) {
        return;
    }

    const leaderboardSize =
        (settings[AppSetting.LeaderboardSize] as number | undefined) ?? 20;

    const highScores = await context.redis.zRange(
        POINTS_STORE_KEY,
        0,
        leaderboardSize - 1,
        { by: "rank", reverse: true }
    );

    const subredditName =
        context.subredditName ??
        (await context.reddit.getCurrentSubredditName());

    const pointName = (settings[AppSetting.PointName] as string) ?? "point";

    let wikiContents = `# ${pointName}board for ${subredditName}\n\nUser | Points Total\n-|-\n\n`;
    const helpPage = settings[AppSetting.PointSystemHelpPage] as
        | string
        | undefined;
    if (helpPage) {
        wikiContents += `[How to award points on /r/${subredditName}](${helpPage})`;
    }
    wikiContents += highScores
        .map((score) => `${markdownEscape(score.member)}|${score.score}`)
        .join("\n");

    wikiContents += `\n\nThe ${pointName}board shows the top ${leaderboardSize} ${pluralize(
        "user",
        leaderboardSize
    )} who ${pluralize(
        "has",
        leaderboardSize
    )} been awarded at least one point`;

    const installDateTimestamp = await context.redis.get("InstallDate");
    if (installDateTimestamp) {
        const installDate = new Date(parseInt(installDateTimestamp));
        wikiContents += ` since ${installDate.toUTCString()}`;
    }

    wikiContents += ".";

    let wikiPage: WikiPage | undefined;
    try {
        wikiPage = await context.reddit.getWikiPage(
            subredditName,
            wikiPageName
        );
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

    const correctPermissionLevel =
        (leaderboardMode[0] as LeaderboardMode) === LeaderboardMode.Public
            ? WikiPagePermissionLevel.SUBREDDIT_PERMISSIONS
            : WikiPagePermissionLevel.MODS_ONLY;

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
