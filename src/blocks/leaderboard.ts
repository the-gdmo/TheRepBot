import {
    ScheduledJobEvent,
    JobContext,
    JSONObject,
    WikiPage,
    TriggerContext,
} from "@devvit/public-api";
import { AppSetting, LeaderboardMode } from "./settings";
import { getSubredditName, SafeWikiClient } from "./utility";
import pluralize from "pluralize";
import { logger } from "./logger";
import { POINTS_STORE_KEY } from "./triggers/utils/redisKeys";

function capitalize(word: string): string {
    return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Escapes text that will be inserted into Reddit/CommonMark markdown.
 *
 * This deliberately includes backslash itself in the same single pass as every
 * ASCII punctuation character that CommonMark allows to be backslash-escaped.
 * That is important for strings such as `\\[` or `\\*`: both the existing
 * backslash and the following markdown character must be escaped independently.
 *
 * Newlines/tabs are collapsed so user-controlled text cannot create a new wiki
 * table row/cell or otherwise change the surrounding markdown structure.
 */
function escapeMarkdownText(input: string): string {
    return String(input)
        .replace(/[\r\n\t]+/g, " ")
        .replace(/[\x20-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]/g, "\\$&");
}

/**
 * Escapes a URL used as a markdown link destination. Reddit permalinks are
 * normally already safe, but encoding the destination also protects against
 * parentheses, whitespace, backslashes, and other characters that can terminate
 * or corrupt markdown link syntax.
 */
function escapeMarkdownUrl(input: string): string {
    return encodeURI(String(input)).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function markdownEscape(input: string): string {
    return escapeMarkdownText(input);
}

function formatDate(dateValue: string | number | Date): string {
    const d = new Date(dateValue);
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function escapeTitle(title: string): string {
    // A post title must never be allowed to create a second markdown/table line.
    return escapeMarkdownText(title.replace(/[\r\n\t]+/g, " "));
}

function escapeRegExp(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wikiUsername(username: string): string {
    return String(username)
        .replace(/^\/?u\//i, "")
        .replace(/[\r\n\t]+/g, "")
        .trim()
        .toLowerCase();
}

/**
 * A user mention containing a backslash is malformed for these bot-managed
 * pages. Remove the entire source line instead of trying to guess what the
 * original username was.
 */
function lineHasBackslashedUserMention(line: string): boolean {
    const mentions = line.match(/(?:^|[\s|[(])\/?u(?:\\?\/)[^\s|)\]]+/gi) ?? [];
    return mentions.some((mention) => mention.includes("\\"));
}

function removeMalformedUserMentionLines(content: string): string {
    return content
        .split("\n")
        .filter((line) => !lineHasBackslashedUserMention(line))
        .join("\n");
}

const USER_WIKI_MAX_LENGTH = 520_000;
const LATEST_PAGE_NOTICE_PREFIX = "> **Most recent history page:**";

function getWikiMarkdown(page: WikiPage | undefined): string {
    if (!page) return "";

    // Devvit 0.14+ exposes WikiPage.content. Keep contentMd as a compatibility
    // fallback for projects pinned to older generated/proto shapes.
    const compatiblePage = page as WikiPage & { contentMd?: string };
    return compatiblePage.content ?? compatiblePage.contentMd ?? "";
}

function userWikiLatestPageKey(username: string): string {
    return `userWiki:latestPage:${username.toLowerCase()}`;
}

function userWikiManualTotalKey(
    username: string,
    kind: "received" | "given"
): string {
    return `userWiki:manualTotal:${kind}:${wikiUsername(username)}`;
}

async function getManualUserWikiTotal(
    context: TriggerContext,
    username: string,
    kind: "received" | "given"
): Promise<number | undefined> {
    const raw = await context.redis.get(userWikiManualTotalKey(username, kind));
    if (raw === undefined || raw === null || raw === "") return;

    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function persistManualUserWikiTotalIfPresent(
    context: TriggerContext,
    username: string,
    kind: "received" | "given",
    value: number
): Promise<void> {
    const key = userWikiManualTotalKey(username, kind);
    if (await context.redis.exists(key)) {
        await context.redis.set(key, String(value));
    }
}

function getNumberedUserWikiPath(username: string, pageNumber: number): string {
    return `user/${username.toLowerCase()}/${pageNumber}`;
}

function getLegacyUserWikiPath(username: string): string {
    return `user/${username.toLowerCase()}`;
}

function buildLatestPageNotice(
    subredditName: string,
    username: string,
    latestPage: number
): string {
    const user = encodeURIComponent(username.toLowerCase());
    const subreddit = encodeURIComponent(subredditName);
    const url = `https://www.reddit.com/r/${subreddit}/wiki/user/${user}/${latestPage}`;
    return `${LATEST_PAGE_NOTICE_PREFIX} [Go to page ${latestPage}](${url}).`;
}

function stripLatestPageNotice(content: string): string {
    const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
    if (lines[0]?.startsWith(LATEST_PAGE_NOTICE_PREFIX)) {
        lines.shift();
        while (lines[0] === "") lines.shift();
    }
    return lines.join("\n");
}

/**
 * Repairs the failure modes this bot can create in wiki markdown without
 * reformatting unrelated moderator-authored content.
 */
function normalizeWikiContent(content: string): string {
    let normalized = stripLatestPageNotice(content).replace(/\r\n/g, "\n");

    // Older versions escaped literal spaces even though CommonMark does not
    // support backslash-escaping spaces. Repair that bot-generated formatting.
    normalized = normalized.replace(/\\ /g, " ");

    // Keep markdown link labels (including submission titles) on one source line.
    normalized = normalized.replace(
        /\[([^\]]*?[\r\n][^\]]*?)\]\(([^\r\n)]+)\)/g,
        (_match, label: string, url: string) =>
            `[${label
                .replace(/[\r\n\t]+/g, " ")
                .replace(/ {2,}/g, " ")}](${url.trim()})`
    );

    // Existing bot/user-history links that still target the old unnumbered page
    // should land on page 1 after pagination is introduced.
    normalized = normalized.replace(
        /(https?:\/\/(?:old\.)?reddit\.com\/r\/[^/\s)]+\/wiki\/user\/[^/\s)#?]+)(?=[)#?\s]|$)/gi,
        "$1/1"
    );

    // Do not preserve malformed escaped user mentions. This intentionally drops
    // the entire affected row/line so it cannot be copied into a numbered page.
    normalized = removeMalformedUserMentionLines(normalized);

    return normalized.trim();
}

function getSectionBody(content: string, verb: "received" | "given"): string {
    const headingPattern =
        verb === "received"
            ? /^##\s+[^\n]*\bReceived\s*$/im
            : /^##\s+[^\n]*\bGiven\s*$/im;
    const headingMatch = headingPattern.exec(content);
    if (!headingMatch) return "";

    const sectionStart = headingMatch.index + headingMatch[0].length;
    const nextDivider = content.indexOf("\n---", sectionStart);
    const nextHeading = content.indexOf("\n## ", sectionStart);
    const ends = [nextDivider, nextHeading].filter((value) => value >= 0);
    const sectionEnd = ends.length > 0 ? Math.min(...ends) : content.length;
    return content.slice(sectionStart, sectionEnd);
}

function extractSectionRows(
    content: string,
    verb: "received" | "given"
): string[] {
    return getSectionBody(content, verb)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("|") && line.endsWith("|"))
        .filter((line) => !/^\|\s*Date\s*\|\s*Submission\s*\|/i.test(line))
        .filter((line) => !/^\|\s*:?-+:?\s*\|/.test(line))
        .filter((line) => !lineHasBackslashedUserMention(line));
}

function buildCanonicalUserWikiBody(
    content: string,
    username: string,
    capPoint: string,
    capPlural: string,
    escapedPlural: string
): string {
    const normalized = normalizeWikiContent(content);
    const displayUsername = wikiUsername(username);
    const receivedRows = extractSectionRows(normalized, "received");
    const givenRows = extractSectionRows(normalized, "given");

    const receivedCount = Math.max(
        receivedRows.length,
        readSectionCount(normalized, displayUsername, "received") ?? 0
    );
    const givenCount = Math.max(
        givenRows.length,
        readSectionCount(normalized, displayUsername, "given") ?? 0
    );

    const receivedRowsText =
        receivedRows.length > 0 ? `\n${receivedRows.join("\n")}` : "";
    const givenRowsText =
        givenRows.length > 0 ? `\n${givenRows.join("\n")}` : "";

    return `
# ${capPoint} History for u/${displayUsername}

## ${capPlural} Received
u/${displayUsername} has received a total of ${receivedCount} ${escapedPlural}.

| Date | Submission |
| :-: | :-- |${receivedRowsText}

---

## ${capPlural} Given
u/${displayUsername} has given a total of ${givenCount} ${escapedPlural}.

| Date | Submission | ${capPoint} Comment | Awarded To |
| :-: | :-- | :-: | :-: |${givenRowsText}
    `.trim();
}

function withLatestPageNotice(
    content: string,
    subredditName: string,
    username: string,
    latestPage: number
): string {
    const body = normalizeWikiContent(content);
    const notice = buildLatestPageNotice(subredditName, username, latestPage);
    return body ? `${notice}\n\n${body}` : notice;
}

function countRowsInSection(content: string, heading: string): number {
    const sectionStart = content.indexOf(heading);
    if (sectionStart < 0) return 0;

    const nextDivider = content.indexOf("\n---", sectionStart + heading.length);
    const nextHeading = content.indexOf("\n## ", sectionStart + heading.length);
    const ends = [nextDivider, nextHeading].filter((n) => n >= 0);
    const sectionEnd = ends.length > 0 ? Math.min(...ends) : content.length;
    const section = content.slice(sectionStart, sectionEnd);

    return section
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("|") && line.endsWith("|"))
        .filter((line) => !/^\|\s*Date\s*\|/i.test(line))
        .filter((line) => !/^\|\s*:?-+:?\s*\|/.test(line)).length;
}

function appendRowToSection(
    content: string,
    heading: string,
    tableHeader: string,
    alignmentRow: string,
    row: string
): string {
    const sectionStart = content.indexOf(heading);

    // A non-standard legacy page should be preserved, not discarded. If its
    // expected section is missing, add only the missing section at the bottom.
    if (sectionStart < 0) {
        return `${content.trimEnd()}\n\n---\n\n${heading}\n\n${tableHeader}\n${alignmentRow}\n${row}`;
    }

    const nextDivider = content.indexOf("\n---", sectionStart + heading.length);
    const nextHeading = content.indexOf("\n## ", sectionStart + heading.length);
    const ends = [nextDivider, nextHeading].filter((n) => n >= 0);
    const sectionEnd = ends.length > 0 ? Math.min(...ends) : content.length;

    let section = content.slice(sectionStart, sectionEnd).trimEnd();
    section = section.replace(/\nNo history yet\.?\s*$/i, "");

    const sectionLines = section.split("\n");
    const existingHeaderIndex = sectionLines.findIndex((line) =>
        /^\|\s*Date\s*\|\s*Submission\s*\|/i.test(line)
    );

    if (existingHeaderIndex >= 0) {
        // Repair an older malformed table header/alignment in place, then append.
        sectionLines[existingHeaderIndex] = tableHeader;
        if (
            /^\|\s*:?-+:?\s*\|/.test(
                sectionLines[existingHeaderIndex + 1]?.trim() ?? ""
            )
        ) {
            sectionLines[existingHeaderIndex + 1] = alignmentRow;
        } else {
            sectionLines.splice(existingHeaderIndex + 1, 0, alignmentRow);
        }
        section = `${sectionLines.join("\n")}\n${row}`;
    } else {
        section += `\n\n${tableHeader}\n${alignmentRow}\n${row}`;
    }

    const sectionSpacer = sectionEnd < content.length ? "\n" : "";
    return `${content.slice(
        0,
        sectionStart
    )}${section}${sectionSpacer}${content.slice(sectionEnd)}`;
}

function readSectionCount(
    content: string,
    username: string,
    verb: "received" | "given"
): number | undefined {
    const renderedUser = wikiUsername(username);
    const safeUser = escapeRegExp(renderedUser);
    const match = content.match(
        new RegExp(
            `u\\/${safeUser}\\s+has\\s+${verb}\\s+(?:a\\s+total\\s+of\\s+)?(\\d+)`,
            "i"
        )
    );
    if (!match || !match[1]) return;

    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function updateSectionCount(
    content: string,
    username: string,
    verb: "received" | "given",
    count: number,
    escapedPlural: string
): string {
    const renderedUser = wikiUsername(username);
    const safeUser = escapeRegExp(renderedUser);
    const pattern = new RegExp(
        `(u\\/${safeUser}\\s+has\\s+${verb}\\s+)(?:a\\s+total\\s+of\\s+)?\\d+(?:\\s+[^\\n.]*)?\\.?`,
        "i"
    );
    const replacement = `$1a total of ${count} ${escapedPlural}.`;

    if (pattern.test(content)) {
        return content.replace(pattern, replacement);
    }

    // A custom/migrated wiki may not have had a count sentence at all. Insert
    // the lifetime total immediately below the matching section heading instead
    // of silently leaving that numbered page without a total.
    const settingsHeading = verb === "received" ? "Received" : "Given";
    const headingPattern = new RegExp(
        `(^##\\s+[^\\n]*${settingsHeading}[^\\n]*$)`,
        "im"
    );
    const countLine = `u/${renderedUser} has ${verb} a total of ${count} ${escapedPlural}.`;

    return headingPattern.test(content)
        ? content.replace(headingPattern, `$1\n${countLine}`)
        : content;
}

export type UserWikiLifetimeTotals = {
    received: number;
    given: number;
};

/**
 * Derive lifetime totals from the numbered wiki pages themselves. The wiki is
 * intentionally authoritative here so migrated history that predates Redis is
 * still included. Explicit total lines are considered alongside actual table
 * rows, which also repairs totals created by older page-local implementations.
 */
async function getUserWikiLifetimeTotals(
    context: TriggerContext,
    subredditName: string,
    username: string,
    latestPage: number,
    safeWiki: SafeWikiClient,
    latestPageBody?: string
): Promise<UserWikiLifetimeTotals> {
    let receivedRows = 0;
    let givenRows = 0;
    let highestReceivedCount = 0;
    let highestGivenCount = 0;

    const settings = await context.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const capPlural = escapeMarkdownText(capitalize(pluralize(pointName)));
    const receivedHeading = `## ${capPlural} Received`;
    const givenHeading = `## ${capPlural} Given`;

    for (let pageNumber = 1; pageNumber <= latestPage; pageNumber += 1) {
        let body: string;

        if (pageNumber === latestPage && latestPageBody !== undefined) {
            body = buildCanonicalUserWikiBody(
                latestPageBody,
                username,
                escapeMarkdownText(capitalize(pointName)),
                capPlural,
                escapeMarkdownText(pluralize(pointName))
            );
        } else {
            const page = await safeWiki.getWikiPage(
                subredditName,
                getNumberedUserWikiPath(username, pageNumber)
            );
            if (!page) continue;
            body = buildCanonicalUserWikiBody(
                getWikiMarkdown(page),
                username,
                escapeMarkdownText(capitalize(pointName)),
                capPlural,
                escapeMarkdownText(pluralize(pointName))
            );
        }

        receivedRows += countRowsInSection(body, receivedHeading);
        givenRows += countRowsInSection(body, givenHeading);

        const receivedCount = readSectionCount(body, username, "received");
        const givenCount = readSectionCount(body, username, "given");

        if (receivedCount !== undefined) {
            highestReceivedCount = Math.max(
                highestReceivedCount,
                receivedCount
            );
        }
        if (givenCount !== undefined) {
            highestGivenCount = Math.max(highestGivenCount, givenCount);
        }
    }

    const [manualReceived, manualGiven] = await Promise.all([
        getManualUserWikiTotal(context, username, "received"),
        getManualUserWikiTotal(context, username, "given"),
    ]);

    return {
        received:
            manualReceived ?? Math.max(receivedRows, highestReceivedCount),
        given: manualGiven ?? Math.max(givenRows, highestGivenCount),
    };
}

async function refreshLifetimeTotalsOnPages(
    context: TriggerContext,
    subredditName: string,
    username: string,
    latestPage: number,
    lifetimeTotals: UserWikiLifetimeTotals,
    capPoint: string,
    capPlural: string,
    escapedPlural: string,
    safeWiki: SafeWikiClient
) {
    for (let pageNumber = 1; pageNumber <= latestPage; pageNumber += 1) {
        const pagePath = getNumberedUserWikiPath(username, pageNumber);
        const page = await safeWiki.getWikiPage(subredditName, pagePath);
        if (!page) continue;

        const current = getWikiMarkdown(page);
        let updated = buildCanonicalUserWikiBody(
            current,
            username,
            capPoint,
            capPlural,
            escapedPlural
        );
        updated = updateSectionCount(
            updated,
            username,
            "received",
            lifetimeTotals.received,
            escapedPlural
        );
        updated = updateSectionCount(
            updated,
            username,
            "given",
            lifetimeTotals.given,
            escapedPlural
        );
        updated = withLatestPageNotice(
            updated,
            subredditName,
            username,
            latestPage
        );

        if (updated !== current) {
            await context.reddit.updateWikiPage({
                subredditName,
                page: pagePath,
                content: updated,
                reason: `Updated lifetime wiki totals for ${username}`,
            });
        }
    }
}

async function getStoredLatestPage(
    context: TriggerContext,
    username: string
): Promise<number | undefined> {
    const raw = await context.redis.get(userWikiLatestPageKey(username));
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function discoverLatestPage(
    context: TriggerContext,
    subredditName: string,
    username: string,
    safeWiki: SafeWikiClient
): Promise<number> {
    const stored = await getStoredLatestPage(context, username);
    if (stored) {
        const storedPage = await safeWiki.getWikiPage(
            subredditName,
            getNumberedUserWikiPath(username, stored)
        );
        if (storedPage) {
            // Recover cleanly if a page was created but the Redis pointer was not
            // advanced (for example, an interrupted deployment between writes).
            let latest = stored;
            while (
                await safeWiki.getWikiPage(
                    subredditName,
                    getNumberedUserWikiPath(username, latest + 1)
                )
            ) {
                latest += 1;
            }
            return latest;
        }
    }

    let pageNumber = 1;
    while (true) {
        const page = await safeWiki.getWikiPage(
            subredditName,
            getNumberedUserWikiPath(username, pageNumber)
        );
        if (!page) break;
        pageNumber += 1;
    }

    return Math.max(1, pageNumber - 1);
}

async function refreshLatestPageLinks(
    context: TriggerContext,
    subredditName: string,
    username: string,
    latestPage: number,
    safeWiki: SafeWikiClient
) {
    const settings = await context.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const plural = pluralize(pointName);
    const capPoint = escapeMarkdownText(capitalize(pointName));
    const capPlural = escapeMarkdownText(capitalize(plural));
    const escapedPlural = escapeMarkdownText(plural);
    for (let pageNumber = 1; pageNumber <= latestPage; pageNumber += 1) {
        const pagePath = getNumberedUserWikiPath(username, pageNumber);
        const page = await safeWiki.getWikiPage(subredditName, pagePath);
        if (!page) continue;

        const current = getWikiMarkdown(page);
        const canonical = buildCanonicalUserWikiBody(
            current,
            username,
            capPoint,
            capPlural,
            escapedPlural
        );
        const updated = withLatestPageNotice(
            canonical,
            subredditName,
            username,
            latestPage
        );

        if (updated !== current) {
            await context.reddit.updateWikiPage({
                subredditName,
                page: pagePath,
                content: updated,
                reason: `Updated newest-page link for ${username}`,
            });
        }
    }
}

async function ensureUserWikiInitialized(
    context: TriggerContext,
    subredditName: string,
    username: string,
    safeWiki: SafeWikiClient
): Promise<number> {
    username = wikiUsername(username);
    const settings = await context.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const plural = pluralize(pointName);
    const capPoint = escapeMarkdownText(capitalize(pointName));
    const capPlural = escapeMarkdownText(capitalize(plural));
    const escapedPlural = escapeMarkdownText(plural);
    const pageOnePath = getNumberedUserWikiPath(username, 1);
    const pageOne = await safeWiki.getWikiPage(subredditName, pageOnePath);

    if (!pageOne) {
        // The existing unnumbered page is the authoritative migration source.
        // Copy its markdown first; only use a fresh page when no legacy page exists.
        const legacyPage = await safeWiki.getWikiPage(
            subredditName,
            getLegacyUserWikiPath(username)
        );
        const sourceContent =
            getWikiMarkdown(legacyPage).trim() ||
            (await buildInitialUserWiki(context, username));
        const canonicalSource = buildCanonicalUserWikiBody(
            sourceContent,
            username,
            capPoint,
            capPlural,
            escapedPlural
        );
        const migratedContent = withLatestPageNotice(
            canonicalSource,
            subredditName,
            username,
            1
        );

        const created = await safeWiki.createWikiPage({
            subredditName,
            page: pageOnePath,
            content: migratedContent,
            reason: legacyPage
                ? `Migrated existing user wiki history for ${username} to page 1`
                : `Created initial user wiki history page 1 for ${username}`,
        });
        if (!created) {
            throw new Error(`Failed to create ${pageOnePath}`);
        }

        await context.redis.set(userWikiLatestPageKey(username), "1");
        return 1;
    }

    const latestPage = await discoverLatestPage(
        context,
        subredditName,
        username,
        safeWiki
    );
    await context.redis.set(
        userWikiLatestPageKey(username),
        String(latestPage)
    );
    return latestPage;
}

async function appendUserWikiEntry(
    context: TriggerContext,
    subredditName: string,
    username: string,
    kind: "received" | "given",
    data: {
        date: string;
        postTitle: string;
        postUrl: string;
        otherUser: string;
        commentUrl: string;
    },
    capPoint: string,
    capPlural: string,
    escapedPlural: string
) {
    username = wikiUsername(username);
    const safeWiki = new SafeWikiClient(context.reddit);
    let latestPage = await ensureUserWikiInitialized(
        context,
        subredditName,
        username,
        safeWiki
    );

    const heading = `## ${capPlural} ${
        kind === "received" ? "Received" : "Given"
    }`;
    const tableHeader =
        kind === "received"
            ? "| Date | Submission |"
            : `| Date | Submission | ${capPoint} Comment | Awarded To |`;
    const alignmentRow =
        kind === "received" ? "| :-: | :-- |" : "| :-: | :-- | :-: | :-: |";
    const row =
        kind === "received"
            ? `| ${formatDate(data.date)} | [${escapeTitle(
                  data.postTitle
              )}](${escapeMarkdownUrl(data.postUrl)}) |`
            : `| ${formatDate(data.date)} | [${escapeTitle(
                  data.postTitle
              )}](${escapeMarkdownUrl(
                  data.postUrl
              )}) | [Link](${escapeMarkdownUrl(
                  data.commentUrl
              )}) | /u/${wikiUsername(data.otherUser)} |`;

    const currentPath = getNumberedUserWikiPath(username, latestPage);
    const currentPage = await safeWiki.getWikiPage(subredditName, currentPath);
    const currentBody = buildCanonicalUserWikiBody(
        getWikiMarkdown(currentPage) ||
            (await buildInitialUserWiki(context, username)),
        username,
        capPoint,
        capPlural,
        escapedPlural
    );
    const lifetimeTotals = await getUserWikiLifetimeTotals(
        context,
        subredditName,
        username,
        latestPage,
        safeWiki,
        currentBody
    );

    if (kind === "received") {
        lifetimeTotals.received += 1;
    } else {
        lifetimeTotals.given += 1;
    }

    let candidate = appendRowToSection(
        currentBody,
        heading,
        tableHeader,
        alignmentRow,
        row
    );
    candidate = updateSectionCount(
        candidate,
        username,
        "received",
        lifetimeTotals.received,
        escapedPlural
    );
    candidate = updateSectionCount(
        candidate,
        username,
        "given",
        lifetimeTotals.given,
        escapedPlural
    );
    candidate = withLatestPageNotice(
        candidate,
        subredditName,
        username,
        latestPage
    );

    // Rotate before writing if the new entry would push the page over the
    // requested safety threshold. A migrated legacy page may already exceed the
    // threshold; in that case it is frozen and the new entry begins page 2.
    if (candidate.length > USER_WIKI_MAX_LENGTH) {
        latestPage += 1;
        const newPagePath = getNumberedUserWikiPath(username, latestPage);
        let newPageBody = await buildInitialUserWiki(
            context,
            username,
            lifetimeTotals
        );
        newPageBody = appendRowToSection(
            newPageBody,
            heading,
            tableHeader,
            alignmentRow,
            row
        );
        const newPageContent = withLatestPageNotice(
            newPageBody,
            subredditName,
            username,
            latestPage
        );

        const created = await safeWiki.createWikiPage({
            subredditName,
            page: newPagePath,
            content: newPageContent,
            reason: `Started user wiki history page ${latestPage} for ${username}`,
        });
        if (!created) {
            throw new Error(`Failed to create ${newPagePath}`);
        }
        await context.redis.set(
            userWikiLatestPageKey(username),
            String(latestPage)
        );

        // Only rotation requires touching older pages: update their top notice so
        // every numbered page links directly to the true newest page.
        await refreshLatestPageLinks(
            context,
            subredditName,
            username,
            latestPage,
            safeWiki
        );
        await refreshLifetimeTotalsOnPages(
            context,
            subredditName,
            username,
            latestPage,
            lifetimeTotals,
            capPoint,
            capPlural,
            escapedPlural,
            safeWiki
        );
        await persistManualUserWikiTotalIfPresent(
            context,
            username,
            kind,
            lifetimeTotals[kind]
        );
        return;
    }

    await context.reddit.updateWikiPage({
        subredditName,
        page: currentPath,
        content: candidate,
        reason: `Updated wiki history for ${username}`,
    });
    await context.redis.set(
        userWikiLatestPageKey(username),
        String(latestPage)
    );
    await refreshLifetimeTotalsOnPages(
        context,
        subredditName,
        username,
        latestPage,
        lifetimeTotals,
        capPoint,
        capPlural,
        escapedPlural,
        safeWiki
    );
    await persistManualUserWikiTotalIfPresent(
        context,
        username,
        kind,
        lifetimeTotals[kind]
    );
}

/**
 * Returns the user's lifetime wiki totals. Numbered wiki history remains the
 * default source of truth, but a moderator-set override wins for that specific
 * direction so corrections can intentionally be lower than the number of rows.
 */
export async function getUserWikiLifetimeTotalsForUser(
    context: TriggerContext,
    username: string
): Promise<UserWikiLifetimeTotals> {
    username = wikiUsername(username);
    const subredditName =
        context.subredditName ??
        (await context.reddit.getCurrentSubreddit()).name;
    const safeWiki = new SafeWikiClient(context.reddit);
    const latestPage = await ensureUserWikiInitialized(
        context,
        subredditName,
        username,
        safeWiki
    );

    return getUserWikiLifetimeTotals(
        context,
        subredditName,
        username,
        latestPage,
        safeWiki
    );
}

/**
 * Sets moderator-corrected lifetime received/given totals without deleting
 * history rows. The corrected values are written to every numbered wiki page
 * and persisted as overrides so future awards increment from the correction.
 */
export async function setUserWikiLifetimeTotalsForUser(
    context: TriggerContext,
    username: string,
    totals: UserWikiLifetimeTotals
): Promise<UserWikiLifetimeTotals> {
    username = wikiUsername(username);

    if (
        !Number.isInteger(totals.received) ||
        totals.received < 0 ||
        !Number.isInteger(totals.given) ||
        totals.given < 0
    ) {
        throw new Error(
            "Wiki lifetime totals must be whole numbers of 0 or higher"
        );
    }

    const subredditName =
        context.subredditName ??
        (await context.reddit.getCurrentSubreddit()).name;
    const settings = await context.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const plural = pluralize(pointName);
    const capPoint = escapeMarkdownText(capitalize(pointName));
    const capPlural = escapeMarkdownText(capitalize(plural));
    const escapedPlural = escapeMarkdownText(plural);
    const safeWiki = new SafeWikiClient(context.reddit);
    const latestPage = await ensureUserWikiInitialized(
        context,
        subredditName,
        username,
        safeWiki
    );

    await refreshLifetimeTotalsOnPages(
        context,
        subredditName,
        username,
        latestPage,
        totals,
        capPoint,
        capPlural,
        escapedPlural,
        safeWiki
    );

    await Promise.all([
        context.redis.set(
            userWikiManualTotalKey(username, "received"),
            String(totals.received)
        ),
        context.redis.set(
            userWikiManualTotalKey(username, "given"),
            String(totals.given)
        ),
    ]);

    logger.info("📄 Moderator set user wiki lifetime totals", {
        username,
        received: totals.received,
        given: totals.given,
    });

    return totals;
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
    awarder = wikiUsername(awarder);
    recipient = wikiUsername(recipient);

    const settings = await context.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const subredditName =
        context.subredditName ??
        (await context.reddit.getCurrentSubreddit()).name;

    const plural = pluralize(pointName);
    const capPoint = escapeMarkdownText(capitalize(pointName));
    const escapedPlural = escapeMarkdownText(plural);
    const capPlural = escapeMarkdownText(capitalize(plural));
    const now = new Date().toISOString();

    // Keep Redis history for compatibility/diagnostics, but the current wiki
    // markdown is the authoritative source for rendering and migration.
    await context.redis.zAdd(`userHistory:given:${awarder}`, {
        member: JSON.stringify({
            date: now,
            postTitle: data.postTitle,
            postUrl: data.postUrl,
            recipient,
            commentUrl: data.commentUrl,
        }),
        score: Date.now(),
    });

    await context.redis.zAdd(`userHistory:received:${recipient}`, {
        member: JSON.stringify({
            date: now,
            postTitle: data.postTitle,
            postUrl: data.postUrl,
            awarder,
            commentUrl: data.commentUrl,
        }),
        score: Date.now(),
    });

    // Append in chronological order: old entries remain above new entries.
    await appendUserWikiEntry(
        context,
        subredditName,
        awarder,
        "given",
        {
            date: now,
            postTitle: data.postTitle,
            postUrl: data.postUrl,
            otherUser: recipient,
            commentUrl: data.commentUrl,
        },
        capPoint,
        capPlural,
        escapedPlural
    );

    await appendUserWikiEntry(
        context,
        subredditName,
        recipient,
        "received",
        {
            date: now,
            postTitle: data.postTitle,
            postUrl: data.postUrl,
            otherUser: awarder,
            commentUrl: data.commentUrl,
        },
        capPoint,
        capPlural,
        escapedPlural
    );

    logger.info("📄 User wiki updated for both awarder & recipient", {
        awarder,
        recipient,
    });
}

export async function buildInitialUserWiki(
    context: TriggerContext,
    username: string,
    lifetimeTotals: UserWikiLifetimeTotals = { received: 0, given: 0 }
) {
    const settings = await context.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const plural = pluralize(pointName);
    const capPoint = escapeMarkdownText(capitalize(pointName));
    const escapedPlural = escapeMarkdownText(plural);
    const capPlural = escapeMarkdownText(capitalize(plural));
    const displayUsername = wikiUsername(username);

    return `
# ${capPoint} History for u/${displayUsername}

## ${capPlural} Received
u/${displayUsername} has received a total of ${lifetimeTotals.received} ${escapedPlural}.

| Date | Submission |
| :-: | :-- |

---

## ${capPlural} Given
u/${displayUsername} has given a total of ${lifetimeTotals.given} ${escapedPlural}.

| Date | Submission | ${capPoint} Comment | Awarded To |
| :-: | :-- | :-: | :-: |
`.trim();
}

export async function InitialUserWikiOptions(
    context: TriggerContext,
    username: string
) {
    const subredditName =
        context.subredditName ??
        (await context.reddit.getCurrentSubreddit()).name;
    const safeWiki = new SafeWikiClient(context.reddit);

    // This no longer resets an existing user's history. It migrates the current
    // unnumbered page into /1 when needed, or ensures the numbered pages exist.
    const latestPage = await ensureUserWikiInitialized(
        context,
        subredditName,
        username.toLowerCase(),
        safeWiki
    );

    await refreshLatestPageLinks(
        context,
        subredditName,
        username.toLowerCase(),
        latestPage,
        safeWiki
    );
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
        (settings[AppSetting.LeaderboardSize] as number | undefined) ?? 50;

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
        wikiContents += `[How to award ${pointName}s on /r/${subredditName}](https://reddit.com/r/${subredditName}/wiki/${helpPage})\n\n`;
    }

    wikiContents += `User | ${capitalize(pointName)}s Earned\n-|-\n`;

    if (highScores.length > 0) {
        wikiContents += highScores
            .map(
                (entry) =>
                    `[${markdownEscape(
                        entry.member
                    )}](https://old.reddit.com/r/${subredditName}/wiki/user/${
                        entry.member
                    }/1)|${entry.score.toLocaleString("en")}`
            )
            .join("\n");
    } else {
        wikiContents += "No users have been awarded yet.";
    }

    wikiContents += `\n\nThe leaderboard shows the top ${leaderboardSize.toLocaleString(
        "en"
    )} ${pluralize("user", leaderboardSize)} who ${pluralize(
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

    const mode = leaderboardMode[0];

    let correctPermissionLevel: number;

    if (!LeaderboardMode.CurrentWikiSettings) {
        switch (mode) {
            case LeaderboardMode.SubredditPermissions:
                correctPermissionLevel = 0;
                break;

            case LeaderboardMode.ApprovedContributorsOnly:
                correctPermissionLevel = 1;
                break;

            case LeaderboardMode.ModOnly:
                correctPermissionLevel = 2;
                break;

            default:
                logger.warn(
                    "⚠️ Unknown leaderboard mode, defaulting to mod only",
                    {
                        mode,
                    }
                );
                correctPermissionLevel = 2;
                break;
        }

        const wikiPageSettings = await wikiPage.getSettings();
        if (wikiPageSettings.permLevel !== correctPermissionLevel) {
            await context.reddit.updateWikiPageSettings({
                subredditName,
                page: wikiPageName,
                listed: true,
                permLevel: correctPermissionLevel,
            });
        }

        logger.info("🔐 Checking leaderboard wiki page permissions", {
            leaderboardMode,
            mode,
            correctPermissionLevel,
            wikiPermLevel: wikiPageSettings.permLevel,
        });
    } else {
        logger.info(
            "🔐 Leaderboard wiki page permissions set to current wiki settings, no changes made",
            {
                leaderboardMode,
                mode,
            }
        );
    }
}

function modInfoTemplate(subredditName: string): string {
    return (
        `# TheRepBot Mod Info for r/${subredditName}\n\n` +
        `***This page is automatically managed by TheRepBot. Any edits will be overwritten.***\n\n` +
        `---\n\n` +
        `## Leaderboard Configuration\n\n` +
        `* If no help page is set, the leaderboard post will not include a link to a help page.\n\n` +
        `* If you want to change the name of the help page, you must update the "Point System Help Page" setting.\n\n` +
        `* **Note:** If you change the leaderboard name in settings, the wiki page link will be updated in the leaderboard post but the old page's contents` +
        ` will not be pulled and you will have to edit the new one manually.\n\n`
    );
}

export async function modInfoJob(
    _: ScheduledJobEvent<JSONObject | undefined>,
    context: JobContext
) {
    const subreddit = await context.reddit.getCurrentSubreddit();
    const subredditName = subreddit.name;
    const safeWiki = new SafeWikiClient(context.reddit);
    const wikiPath = "therepbot/modinfo";

    const template = modInfoTemplate(subredditName);

    let existingPage = undefined;
    try {
        existingPage = await safeWiki.getWikiPage(subredditName, wikiPath);

        if (!existingPage) {
            await safeWiki.createWikiPage({
                subredditName,
                page: wikiPath,
                content: template,
                reason: "Mod info wiki page setup",
            });
            logger.info(`📘 No existing wiki page found — created ${wikiPath}`);
        } else {
            logger.info("ℹ️ Existing mod info wiki page found");
        }
    } catch (err) {
        logger.error("❌ Error retrieving mod info wiki page", {
            error: String(err),
        });
    }
    // ──────────────── set page content to template ────────────────

    await context.reddit.updateWikiPage({
        subredditName,
        page: wikiPath,
        content: template,
        reason: `Set page to template content`,
    });
}
