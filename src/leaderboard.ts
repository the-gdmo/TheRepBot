import {
    ScheduledJobEvent,
    JobContext,
    WikiPagePermissionLevel,
    JSONObject,
    WikiPage,
    TriggerContext,
} from "@devvit/public-api";
import { format } from "date-fns";
import { AppSetting, LeaderboardMode, TemplateDefaults } from "./settings.js";
import { getSubredditName, SafeWikiClient } from "./utility.js";
import pluralize from "pluralize";
import { logger } from "./logger.js";
import { contextTypeToJSON } from "@devvit/protos/types/devvit/actor/reddit/context_type.js";

export const TIMEFRAMES = ["alltime"] as const;

const POINTS_STORE_KEY = "thanksPointsStore";

function capitalize(word: string): string {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

function markdownEscape(input: string): string {
    return input.replace(/([\\`*_{}\[\]()#+\-.!])/g, "\\$1");
}

function formatDate(dateString: number): string {
    const d = new Date(dateString);
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function escapeTitle(title: string): string {
    return title
        .replace(/\|/g, "\\|")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]");
}

export async function updateUserWiki(
    context: TriggerContext,
    awarder: string,
    recipient: string,
    data: {
        postTitle: string;
        postUrl: string;
        commentUrl: string;
    }
) {
    awarder = awarder.toLowerCase();
    recipient = recipient.toLowerCase();

    const settings = await context.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const subredditName =
        context.subredditName ??
        (await context.reddit.getCurrentSubreddit()).name;

    const capPoint = capitalize(pointName);
    const plural = pluralize(pointName);
    const capPlural = capitalize(plural);

    //
    // ──────────────────────────────────────────────────────────────
    // UPDATE DATABASE ENTRIES
    // ──────────────────────────────────────────────────────────────
    //

    // Awarder → GIVEN
    await context.redis.zAdd(`userHistory:given:${awarder}`, {
        member: JSON.stringify({
            date: new Date().toISOString(),
            postTitle: data.postTitle,
            postUrl: data.postUrl,
            recipient,
            commentUrl: data.commentUrl,
        }),
        score: Date.now(),
    });

    // Recipient → RECEIVED
    await context.redis.zAdd(`userHistory:received:${recipient}`, {
        member: JSON.stringify({
            date: new Date().toISOString(),
            postTitle: data.postTitle,
            postUrl: data.postUrl,
            awarder,
            commentUrl: data.commentUrl,
        }),
        score: Date.now(),
    });

    //
    // ──────────────────────────────────────────────────────────────
    // REBUILD BOTH TABLES FROM REDIS
    // ──────────────────────────────────────────────────────────────
    //

    async function loadHistory(key: string) {
        const raw = await context.redis.zRange(key, 0, -1, { by: "rank" });
        return raw.map((r) => JSON.parse(r.member));
    }

    const awarderGiven = await loadHistory(`userHistory:given:${awarder}`);
    const awarderReceived = await loadHistory(
        `userHistory:received:${awarder}`
    );

    const recipientGiven = await loadHistory(`userHistory:given:${recipient}`);
    const recipientReceived = await loadHistory(
        `userHistory:received:${recipient}`
    );

    //
    // ──────────────────────────────────────────────────────────────
    // BUILD TABLES
    // ──────────────────────────────────────────────────────────────
    //

    function buildReceivedTable(list: any[]): string {
        if (list.length === 0) return "No history yet.";

        return `
| Date | Submission |
| :-: | :-- |
${list
    .map(
        (e) =>
            `| ${formatDate(e.date)} | [${escapeTitle(e.postTitle)}](${
                e.postUrl
            })`
    )
    .join("\n")}
`.trim();
    }

    function buildGivenTable(list: any[]): string {
        if (list.length === 0) return "No history yet.";

        return `
| Date | Submission | ${capPoint} Comment | Awarded To |
| :-: | :-- | :-: | :-: |
${list
    .map(
        (e) =>
            `| ${formatDate(e.date)} | [${escapeTitle(
                e.postTitle
            )}](${e.postUrl}) | [Link](${e.commentUrl}) | /u/${e.recipient}`
    )
    .join("\n")}
`.trim();
    }

    const awarderReceivedTable = buildReceivedTable(awarderReceived);
    const awarderGivenTable = buildGivenTable(awarderGiven);

    const recipientReceivedTable = buildReceivedTable(recipientReceived);
    const recipientGivenTable = buildGivenTable(recipientGiven);

    //
    // ──────────────────────────────────────────────────────────────
    // WRITE BOTH TABLES TO BOTH WIKI PAGES
    // ──────────────────────────────────────────────────────────────
    //

    async function writePage(
        user: string,
        receivedTable: string,
        givenTable: string
    ) {
        const content = `
# ${capPoint} History for u/${user}

## ${capPlural} Received  
u/${user} has received ${
            receivedTable.includes("|")
                ? receivedTable.split("\n").length - 2
                : 0
        } ${plural}.

${receivedTable}

---

## ${capPlural} Given  
u/${user} has given ${
            givenTable.includes("|") ? givenTable.split("\n").length - 2 : 0
        } ${plural}.

${givenTable}
        `.trim();

        await context.reddit.updateWikiPage({
            subredditName,
            page: `user/${user}`,
            content,
            reason: `Updated wiki history for ${user}`,
        });
    }

    await writePage(awarder, awarderReceivedTable, awarderGivenTable);
    await writePage(recipient, recipientReceivedTable, recipientGivenTable);

    logger.info("📄 User wiki updated for both awarder & recipient", {
        awarder,
        recipient,
    });
}

export async function buildInitialUserWiki(
    context: TriggerContext,
    username: string
) {
    logger.info("📄 Building initial user wiki page…", { username });

    let pointName = "point";
    try {
        const settings = await context.settings.getAll();
        pointName = (settings[AppSetting.PointName] as string) ?? "point";

        logger.debug(`🧩 Loaded ${pointName} for initial wiki`, {
            username,
            pointName,
        });
    } catch (err) {
        logger.error("❌ Failed to load settings for initial wiki", {
            username,
            error: String(err),
        });
    }

    const plural = pluralize(pointName);
    const capPoint = capitalize(pointName);
    const capPlural = capitalize(plural);

    logger.debug("📝 Computed wiki title parts", {
        username,
        capPoint,
        capPlural,
        plural,
    });

    const page = `
# ${capPoint} History for u/${username}

---

## ${capPlural} Received  
u/${username} has received 0 ${plural}

| Date | Submission | ${capPoint} Comment | Awarded To |

---

## ${capPlural} Given  
u/${username} has given 0 ${plural}

| Date | Submission | ${capPoint} Comment | Awarded To |
`.trim();

    logger.info("✅ Initial user wiki page built", { username });

    return page;
}

export async function InitialUserWikiOptions(
    context: TriggerContext,
    username: string
) {
    logger.info("📂 InitialUserWikiOptions invoked", { username });

    const subredditName =
        context.subredditName ??
        (await context.reddit.getCurrentSubreddit()).name;

    const safeWiki = new SafeWikiClient(context.reddit);
    const wikiPath = `user/${username}`;

    logger.debug("📄 Checking existing user wiki page", {
        subredditName,
        wikiPath,
    });

    let existingPage = undefined;
    try {
        existingPage = await safeWiki.getWikiPage(subredditName, wikiPath);

        if (existingPage) {
            logger.info("ℹ️ Existing user wiki page found", { username });
        } else {
            logger.info("📘 No existing wiki page found — creating fresh", {
                username,
            });
        }
    } catch (err) {
        logger.error("❌ Error retrieving user wiki page", {
            username,
            error: String(err),
        });
    }

    // Build the initial page markdown
    const initialContent = await buildInitialUserWiki(context, username);

    logger.debug("📝 Built initial user wiki content", {
        username,
        length: initialContent.length,
    });

    // If exists, update; otherwise create
    try {
        if (!existingPage) {
            logger.info("📘 Creating new user wiki page", {
                username,
            });

            await safeWiki.createWikiPage({
                subredditName,
                page: wikiPath,
                content: initialContent,
                reason: "Initial user wiki page setup via menu option",
            });

            logger.info("✅ Successfully created user wiki page", {
                username,
            });
        } else {
            logger.info("✏️ Updating existing user wiki page", {
                username,
            });

            await context.reddit.updateWikiPage({
                subredditName,
                page: wikiPath,
                content: initialContent,
                reason: "Reset user wiki page to initial state",
            });

            logger.info("✅ User wiki page updated successfully", {
                username,
            });
        }
    } catch (err) {
        logger.error("❌ Failed to create/update user wiki page", {
            username,
            error: String(err),
        });
    }
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
    let wikiContents = `# ${capitalize(
        pointName
    )}board for ${subredditName}\n\n`;
    if (helpPage) {
        wikiContents += `[How to award ${pointName}s on /r/${subredditName}](https://old.reddit.com/r/${subredditName}/wiki/${helpPage})\n\n`;
    }

    wikiContents += `User | ${capitalize(pointName)}s Earned\n-|-\n`;

    if (highScores.length > 0) {
        wikiContents += highScores
            .map(
                (entry) =>
                    `[${markdownEscape(
                        entry.member
                    )}](https://www.reddit.com/r/${subredditName}/wiki/user/${
                        entry.member
                    })|${entry.score}`
            )
            .join("\n");
    } else {
        wikiContents += "No users have been awarded yet.";
    }

    wikiContents += `\n\nThe leaderboard shows the top ${leaderboardSize} ${pluralize(
        "user",
        leaderboardSize
    )} who ${pluralize(
        "has",
        leaderboardSize
    )} been awarded at least one ${pointName}`;

    const installDateTimestamp = await context.redis.get("InstallDate");
    if (installDateTimestamp) {
        const installDate = new Date(parseInt(installDateTimestamp));
        wikiContents += ` since ${installDate.toUTCString()}`;
    }
    wikiContents += ".";

    // ──────────────── Safe wiki handling ────────────────
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
