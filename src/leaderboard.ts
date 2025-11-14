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

function formatDate(dateString: string): string {
    const d = new Date(dateString);
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function extractSection(content: string, header: string): string | null {
    const regex = new RegExp(
        `## ${header}[\\s\\S]*?(?=\\n## |$)`,
        "i"
    );
    const match = content.match(regex);
    return match ? match[0] : null;
}

function extractTable(section: string): string {
    const tableMatch = section.match(/\|[\s\S]+/);
    return tableMatch ? tableMatch[0].trim() : "No history available.";
}

function buildReceivedTable(received: any[]): string {
    if (!received.length) return "No history available.";

    return `
| Date | Submission |
|------|------------|
${received
    .map(
        (r) =>
            `| ${formatDate(r.date)} | [${escapeTitle(r.postTitle)}](${r.postUrl}) |`
    )
    .join("\n")}
`.trim();
}

function buildGivenTable(given: any[]): string {
    if (!given.length) return "No history available.";

    return `
| Date | Submission | Snipe Comment | Awarded To |
|------|------------|----------------|-------------|
${given
    .map(
        (g) =>
            `| ${formatDate(g.date)} | [${escapeTitle(g.postTitle)}](${g.postUrl}) | [Link](${g.commentUrl}) | u/${g.receiver} |`
    )
    .join("\n")}
`.trim();
}

function escapeTitle(title: string): string {
    return title
        .replace(/\|/g, "\\|")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]");
}

export async function updateUserWikiReceived(
    context: TriggerContext,
    username: string
) {
    username = username.toLowerCase();
    logger.info("🔄 Updating RECEIVED section", { username });

    const settings = await context.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const subredditName =
        context.subredditName ??
        (await context.reddit.getCurrentSubreddit()).name;

    const safeWiki = new SafeWikiClient(context.reddit);
    const wikiPath = `user/${username}`;

    let page = await safeWiki.getWikiPage(subredditName, wikiPath);

    if (!page) {
        logger.warn("📄 Page missing, creating fresh", { username });
        page = { contentMd: "" } as any;
    }

    const original = page?.contentMd ?? "";

    // Extract the existing GIVEN section
    const givenSection = extractSection(original, `${capitalize(pointName)}s Given`);
    const givenTable = givenSection ? extractTable(givenSection) : "No history available.";

    // Get new RECEIVED history
    const rawReceived = await context.redis.zRange(
        `userHistory:received:${username}`,
        0,
        -1,
        { by: "rank" }
    );
    const received = rawReceived.map((r) => JSON.parse(r.member));

    const newReceivedTable = buildReceivedTable(received);
    const capPoint = capitalize(pointName);
    const pluralPoint = pluralize(pointName);
    const capPluralPoint = capitalize(pluralPoint);

    const newContent = `
# ${capPoint} History for u/${username}

---

## ${capPluralPoint} Received  
u/${username} has received **${received.length} ${pluralPoint}**.

${newReceivedTable}

---

## ${capPluralPoint} Given  
${givenTable}
`;

    await context.reddit.updateWikiPage({
        subredditName,
        page: wikiPath,
        content: newContent,
        reason: `Updated RECEIVED table for u/${username}`,
    });

    logger.info("✅ Updated RECEIVED table successfully", { username });
}

export async function updateUserWikiGiven(
    context: TriggerContext,
    username: string
) {
    username = username.toLowerCase();
    logger.info("🔄 Updating GIVEN section", { username });

    const settings = await context.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const subredditName =
        context.subredditName ??
        (await context.reddit.getCurrentSubreddit()).name;

    const safeWiki = new SafeWikiClient(context.reddit);
    const wikiPath = `user/${username}`;

    let page = await safeWiki.getWikiPage(subredditName, wikiPath);

    if (!page) {
        logger.warn("📄 Page missing, creating fresh", { username });
        page = { contentMd: "" } as any;
    }

    const original = page?.contentMd ?? "";

    // Extract the existing RECEIVED section
    const receivedSection = extractSection(original, `${capitalize(pointName)}s Received`);
    const receivedTable = receivedSection ? extractTable(receivedSection) : "No history available.";

    // Fetch new GIVEN entries
    const rawGiven = await context.redis.zRange(
        `userHistory:given:${username}`,
        0,
        -1,
        { by: "rank" }
    );
    const given = rawGiven.map((g) => JSON.parse(g.member));

    const newGivenTable = buildGivenTable(given);

    const capPoint = capitalize(pointName);
    const pluralPoint = pluralize(pointName);
    const capPluralPoint = capitalize(pluralPoint);

    const newContent = `
# ${capPoint} History for u/${username}

---

## ${capPluralPoint} Received  
${receivedTable}

---

## ${capPluralPoint} Given  
u/${username} has given ${given.length} ${pluralPoint}.

${newGivenTable}
`;

    await context.reddit.updateWikiPage({
        subredditName,
        page: wikiPath,
        content: newContent,
        reason: `Updated GIVEN table for u/${username}`,
    });

    logger.info("✅ Updated GIVEN table successfully", { username });
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

No history available.

---

## ${capPlural} Given  
u/${username} has given 0 ${plural}

No history available.
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
            .map((entry) => `${markdownEscape(entry.member)}|${entry.score}`)
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
