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

/**
 * Tracks the one-time migration that makes an already-existing leaderboard wiki
 * page authoritative over Redis. Without this guard, every scheduled leaderboard
 * refresh could restore an older wiki snapshot and erase points that were added to
 * Redis since the previous wiki update.
 */
function leaderboardWikiImportKey(
    subredditName: string,
    wikiPageName: string
): string {
    return `leaderboard:wikiImport:v1:${subredditName.toLowerCase()}:${wikiPageName.toLowerCase()}`;
}

type LeaderboardWikiEntry = {
    member: string;
    score: number;
};

/**
 * Parses the leaderboard table that this file renders to the wiki.
 *
 * Returns undefined when the page does not look like a leaderboard at all. An
 * empty array is different: it means the page has a valid leaderboard table but
 * contains no users, so Redis should be cleared during migration.
 */
function parseLeaderboardWikiEntries(
    content: string
): LeaderboardWikiEntry[] | undefined {
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const headerIndex = lines.findIndex((line) =>
        /^\s*\|?\s*User\s*\|\s*.+?\s+Earned\s*\|?\s*$/i.test(line)
    );

    if (headerIndex < 0) return;

    const entries = new Map<string, LeaderboardWikiEntry>();

    // Skip the header and its alignment row. Stop at the first blank line after
    // the table, which is how updateLeaderboard separates the table from prose.
    for (let index = headerIndex + 2; index < lines.length; index += 1) {
        const line = lines[index]?.trim() ?? "";
        if (!line) break;
        if (/^No users have been awarded yet\.?$/i.test(line)) break;

        const scoreMatch = line.match(
            /\|\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\|?\s*$/
        );
        if (!scoreMatch?.[1]) continue;

        const score = Number(scoreMatch[1].replace(/,/g, ""));
        if (!Number.isFinite(score) || score < 0) continue;

        let member: string | undefined;

        // Prefer the wiki/user URL because markdown labels may contain escaped
        // punctuation (for example an underscore in a username).
        const wikiUserMatch = line.match(
            /https?:\/\/(?:old\.)?reddit\.com\/r\/[^/\s)]+\/wiki\/user\/([^/\s)#?]+)(?:\/\d+)?/i
        );
        if (wikiUserMatch?.[1]) {
            try {
                member = decodeURIComponent(wikiUserMatch[1]);
            } catch {
                member = wikiUserMatch[1];
            }
        }

        // Compatibility fallback for older/custom leaderboard rows that retained
        // a normal markdown link but did not use the canonical wiki/user URL.
        if (!member) {
            const labelMatch = line.match(/^\s*\|?\s*\[([^\]]+)\]\(/);
            if (labelMatch?.[1]) {
                member = labelMatch[1].replace(/\\(.)/g, "$1");
            }
        }

        // Final fallback for a plain `username | score` table row.
        if (!member) {
            const plainMatch = line.match(
                /^\s*\|?\s*(?:\/?u\/)?([A-Za-z0-9_-]+)\s*\|/i
            );
            member = plainMatch?.[1];
        }

        if (!member) continue;
        const normalizedMember = wikiUsername(member);
        if (!normalizedMember) continue;

        entries.set(normalizedMember, {
            member: normalizedMember,
            score,
        });
    }

    return [...entries.values()];
}

/**
 * On the first run after this migration is introduced, replace POINTS_STORE_KEY
 * with the contents of an already-existing leaderboard wiki page. The marker is
 * scoped to the subreddit and configured wiki page name, so changing the wiki
 * page can intentionally seed Redis from that page once as well.
 */
async function replaceLeaderboardRedisFromExistingWikiOnce(
    context: JobContext,
    subredditName: string,
    wikiPageName: string,
    wikiPage: WikiPage
): Promise<void> {
    const importKey = leaderboardWikiImportKey(subredditName, wikiPageName);
    if (await context.redis.get(importKey)) return;

    const entries = parseLeaderboardWikiEntries(getWikiMarkdown(wikiPage));
    if (entries === undefined) {
        logger.warn(
            "⚠️ Existing leaderboard wiki could not be parsed; Redis was left unchanged",
            { subredditName, wikiPageName }
        );
        return;
    }

    // The wiki is authoritative for this migration: remove the old sorted set
    // completely before inserting the values parsed from the page.
    await context.redis.del(POINTS_STORE_KEY);
    if (entries.length > 0) {
        await context.redis.zAdd(POINTS_STORE_KEY, ...entries);
    }

    await context.redis.set(importKey, new Date().toISOString());

    logger.info("📥 Replaced leaderboard Redis data from existing wiki", {
        subredditName,
        wikiPageName,
        importedUsers: entries.length,
    });
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
    const url = `https://old.reddit.com/r/${subreddit}/wiki/user/${user}/${latestPage}`;
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
    const section = getSectionBody(content, verb);

    return section
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("|") && line.endsWith("|"))
        .filter((line) => {
            // Treat the current wiki table as authoritative. Only ignore rows
            // that are clearly a table header or alignment separator; do not
            // rebuild/reformat valid data rows just because their presentation
            // differs from the bot's default template.
            const cells = line
                .slice(1, -1)
                .split("|")
                .map((cell) =>
                    cell
                        .trim()
                        .replace(/^\*\*(.*?)\*\*$/, "$1")
                        .trim()
                );

            if (cells.length === 0) return false;

            const isAlignmentRow = cells.every((cell) => /^:?-+:?$/.test(cell));
            if (isAlignmentRow) return false;

            const first = (cells[0] ?? "").toLowerCase();
            const second = (cells[1] ?? "").toLowerCase();
            if (first === "date" && second === "submission") return false;

            return true;
        })
        .filter((line) => !lineHasBackslashedUserMention(line));
}

type RedisGivenHistoryEntry = {
    date: string;
    postTitle: string;
    postUrl: string;
    recipient: string;
    commentUrl: string;
};

type RedisReceivedHistoryEntry = {
    date: string;
    postTitle: string;
    postUrl: string;
    awarder: string;
    commentUrl: string;
};

type ParsedGivenWikiEntry = {
    recipient: string;
    score: number;
    givenMember: string;
    receivedMember: string;
};

function userHistoryGivenKey(username: string): string {
    return `userHistory:given:${wikiUsername(username)}`;
}

function userHistoryReceivedKey(username: string): string {
    return `userHistory:received:${wikiUsername(username)}`;
}

/**
 * Tracks which received-history keys were populated from a specific awarder's
 * Given wiki rows. This lets a later wiki -> Redis rebuild remove stale rows
 * when moderators delete or correct an existing wiki entry.
 */
function userHistoryRecipientIndexKey(awarder: string): string {
    return `userHistory:wikiRecipients:${wikiUsername(awarder)}`;
}

function unescapeMarkdownText(input: string): string {
    return input.replace(/\\([\x20-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E])/g, "$1");
}

function decodeMarkdownUrl(input: string): string {
    try {
        return decodeURI(input);
    } catch {
        return input;
    }
}

/**
 * Wiki history only renders a calendar date, not the original timestamp. Add a
 * tiny deterministic offset so multiple otherwise-identical rows from the same
 * day remain distinct Redis sorted-set members and retain their wiki order.
 */
function parseWikiHistoryDate(
    input: string,
    sequence: number
): { date: string; score: number } | undefined {
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(input.trim());
    if (!match) return;

    const month = Number.parseInt(match[1]!, 10);
    const day = Number.parseInt(match[2]!, 10);
    const year = Number.parseInt(match[3]!, 10);
    const base = Date.UTC(year, month - 1, day);
    const parsed = new Date(base);

    if (
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() !== month - 1 ||
        parsed.getUTCDate() !== day
    ) {
        return;
    }

    // sequence is only used as a stable tie-breaker within wiki-derived data.
    const score = base + sequence;
    return { date: new Date(score).toISOString(), score };
}

/**
 * Parses one canonical Given-table row:
 * | Date | [Submission](url) | [Link](comment) | /u/recipient |
 *
 * A Given row contains enough information to rebuild BOTH Redis directions.
 * The Received wiki table alone cannot do that because it omits awarder and
 * commentUrl, so the awarder's Given history is the authoritative Redis source.
 */
function parseGivenWikiRow(
    row: string,
    awarder: string,
    sequence: number
): ParsedGivenWikiEntry | undefined {
    const match = row.match(
        /^\|\s*([^|]+?)\s*\|\s*\[((?:\\.|[^\]])*)\]\(([^)\s]+)\)\s*\|\s*\[((?:\\.|[^\]])*)\]\(([^)\s]+)\)\s*\|\s*(?:\/?u\/)?([A-Za-z0-9_-]+)\s*\|$/i
    );
    if (!match) return;

    const parsedDate = parseWikiHistoryDate(match[1]!, sequence);
    if (!parsedDate) return;

    const recipient = wikiUsername(match[6]!);
    if (!recipient) return;

    const postTitle = unescapeMarkdownText(match[2]!);
    const postUrl = decodeMarkdownUrl(match[3]!);
    const commentUrl = decodeMarkdownUrl(match[5]!);
    const normalizedAwarder = wikiUsername(awarder);

    const given: RedisGivenHistoryEntry = {
        date: parsedDate.date,
        postTitle,
        postUrl,
        recipient,
        commentUrl,
    };
    const received: RedisReceivedHistoryEntry = {
        date: parsedDate.date,
        postTitle,
        postUrl,
        awarder: normalizedAwarder,
        commentUrl,
    };

    return {
        recipient,
        score: parsedDate.score,
        givenMember: JSON.stringify(given),
        receivedMember: JSON.stringify(received),
    };
}

async function getAllSortedSetEntries(
    context: TriggerContext,
    key: string
): Promise<Array<{ member: string; score: number }>> {
    const count = await context.redis.zCard(key);
    if (count <= 0) return [];
    return context.redis.zRange(key, 0, count - 1, { by: "rank" });
}

async function zAddInBatches(
    context: TriggerContext,
    key: string,
    entries: Array<{ member: string; score: number }>,
    batchSize = 100
): Promise<void> {
    for (let index = 0; index < entries.length; index += batchSize) {
        await context.redis.zAdd(
            key,
            ...entries.slice(index, index + batchSize)
        );
    }
}

function getRecipientFromGivenRedisMember(member: string): string | undefined {
    try {
        const parsed = JSON.parse(member) as Partial<RedisGivenHistoryEntry>;
        return typeof parsed.recipient === "string"
            ? wikiUsername(parsed.recipient)
            : undefined;
    } catch {
        return;
    }
}

function isReceivedRedisMemberFromAwarder(
    member: string,
    awarder: string
): boolean {
    try {
        const parsed = JSON.parse(member) as Partial<RedisReceivedHistoryEntry>;
        return (
            typeof parsed.awarder === "string" &&
            wikiUsername(parsed.awarder) === wikiUsername(awarder)
        );
    } catch {
        return false;
    }
}

/**
 * Rebuilds userHistory Redis from the awarder's numbered wiki pages.
 *
 * This is intentionally a replacement, not an append:
 * - userHistory:given:<awarder> becomes exactly the parseable Given wiki rows.
 * - matching rows contributed by this awarder are removed from each affected
 *   userHistory:received:<recipient> set, then rebuilt from those same wiki rows.
 *
 * Therefore moderator edits/migrations in the wiki become authoritative instead
 * of leaving stale Redis history behind.
 */
async function replaceUserHistoryRedisFromWiki(
    context: TriggerContext,
    subredditName: string,
    awarder: string
): Promise<number> {
    awarder = wikiUsername(awarder);
    const safeWiki = new SafeWikiClient(context.reddit);
    const latestPage = await discoverLatestPage(
        context,
        subredditName,
        awarder,
        safeWiki
    );

    const parsedEntries: ParsedGivenWikiEntry[] = [];
    let sequence = 0;

    for (let pageNumber = 1; pageNumber <= latestPage; pageNumber += 1) {
        const page = await safeWiki.getWikiPage(
            subredditName,
            getNumberedUserWikiPath(awarder, pageNumber)
        );
        if (!page) continue;

        const rows = extractSectionRows(
            normalizeWikiContent(getWikiMarkdown(page)),
            "given"
        );
        for (const row of rows) {
            const parsed = parseGivenWikiRow(row, awarder, sequence);
            sequence += 1;
            if (parsed) parsedEntries.push(parsed);
        }
    }

    const givenKey = userHistoryGivenKey(awarder);
    const previousGiven = await getAllSortedSetEntries(context, givenKey);

    // Recipients from old Redis, current wiki, and our previous sync index are
    // all candidates for stale received rows that need to be removed.
    const affectedRecipients = new Set<string>();
    for (const entry of previousGiven) {
        const recipient = getRecipientFromGivenRedisMember(entry.member);
        if (recipient) affectedRecipients.add(recipient);
    }
    for (const entry of parsedEntries) {
        affectedRecipients.add(entry.recipient);
    }

    const recipientIndexKey = userHistoryRecipientIndexKey(awarder);
    const indexedRecipients = await context.redis.get(recipientIndexKey);
    if (indexedRecipients) {
        try {
            const parsed = JSON.parse(indexedRecipients);
            if (Array.isArray(parsed)) {
                for (const recipient of parsed) {
                    if (typeof recipient === "string") {
                        affectedRecipients.add(wikiUsername(recipient));
                    }
                }
            }
        } catch {
            logger.warn("⚠️ Invalid user-history recipient index; rebuilding", {
                awarder,
            });
        }
    }

    // Remove this awarder's old contribution from every received-history set we
    // know about before rebuilding it from the wiki.
    for (const recipient of affectedRecipients) {
        if (!recipient) continue;
        const receivedKey = userHistoryReceivedKey(recipient);
        const existing = await getAllSortedSetEntries(context, receivedKey);
        const staleMembers = existing
            .filter((entry) =>
                isReceivedRedisMemberFromAwarder(entry.member, awarder)
            )
            .map((entry) => entry.member);

        if (staleMembers.length > 0) {
            await context.redis.zRem(receivedKey, staleMembers);
        }
    }

    // Replace the awarder's Given set completely.
    await context.redis.del(givenKey);
    await zAddInBatches(
        context,
        givenKey,
        parsedEntries.map((entry) => ({
            member: entry.givenMember,
            score: entry.score,
        }))
    );

    // Rebuild Received entries grouped by recipient.
    const receivedByRecipient = new Map<
        string,
        Array<{ member: string; score: number }>
    >();
    for (const entry of parsedEntries) {
        const list = receivedByRecipient.get(entry.recipient) ?? [];
        list.push({ member: entry.receivedMember, score: entry.score });
        receivedByRecipient.set(entry.recipient, list);
    }

    for (const [recipient, entries] of receivedByRecipient) {
        await zAddInBatches(
            context,
            userHistoryReceivedKey(recipient),
            entries
        );
    }

    await context.redis.set(
        recipientIndexKey,
        JSON.stringify([...receivedByRecipient.keys()])
    );

    // Verify that the replacement actually persisted instead of silently
    // continuing with a partially-written Given history.
    const savedGivenCount = await context.redis.zCard(givenKey);
    if (savedGivenCount !== parsedEntries.length) {
        throw new Error(
            `Redis user history verification failed for ${awarder}: expected ${parsedEntries.length} Given entries, found ${savedGivenCount}`
        );
    }

    logger.info("💾 Rebuilt Redis user history from wiki", {
        awarder,
        latestPage,
        givenEntries: parsedEntries.length,
        recipients: receivedByRecipient.size,
    });

    return parsedEntries.length;
}

function buildCanonicalUserWikiBody(
    content: string,
    username: string,
    capPoint: string,
    capPlural: string,
    escapedPlural: string
): string {
    // Existing wiki markdown is the source of truth for what the page should
    // display. normalizeWikiContent() only applies the bot's targeted repairs
    // (latest-page notice removal, malformed mention cleanup, legacy escaping,
    // etc.); it no longer causes the page to be reconstructed from a template.
    const normalized = normalizeWikiContent(content);
    if (normalized) {
        return normalized;
    }

    // Only an actually empty/new page gets the default structure.
    const displayUsername = wikiUsername(username);
    return `
# ${capPoint} History for u/${displayUsername}

## ${capPlural} Received
u/${displayUsername} has received a total of 0 ${escapedPlural}.

| Date | Submission |
| :-: | :-- |

---

## ${capPlural} Given
u/${displayUsername} has given a total of 0 ${escapedPlural}.

| Date | Submission | ${capPoint} Comment | Awarded To |
| :-: | :-- | :-: | :-: |
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

    // Preserve the existing page as the display source. If the requested
    // section does not exist at all, add only that missing section.
    if (sectionStart < 0) {
        return `${content.trimEnd()}\n\n---\n\n${heading}\n\n${tableHeader}\n${alignmentRow}\n${row}`;
    }

    const nextDivider = content.indexOf("\n---", sectionStart + heading.length);
    const nextHeading = content.indexOf("\n## ", sectionStart + heading.length);
    const ends = [nextDivider, nextHeading].filter((n) => n >= 0);
    const sectionEnd = ends.length > 0 ? Math.min(...ends) : content.length;

    let section = content.slice(sectionStart, sectionEnd);
    section = section.replace(/\nNo history yet\.?\s*$/i, "");

    const sectionLines = section.split("\n");
    const existingHeaderIndex = sectionLines.findIndex((line) =>
        /^\|\s*(?:\*\*)?Date(?:\*\*)?\s*\|\s*(?:\*\*)?Submission(?:\*\*)?\s*\|/i.test(
            line.trim()
        )
    );

    if (existingHeaderIndex >= 0) {
        // Keep the existing wiki header/layout intact. Only add an alignment row
        // when the table truly does not have one.
        let alignmentIndex = existingHeaderIndex + 1;
        const nextLine = sectionLines[alignmentIndex]?.trim() ?? "";
        const isAlignmentRow =
            nextLine.startsWith("|") &&
            nextLine.endsWith("|") &&
            nextLine
                .slice(1, -1)
                .split("|")
                .map((cell) => cell.trim())
                .filter(Boolean)
                .every((cell) => /^:?-+:?$/.test(cell));

        if (!isAlignmentRow) {
            sectionLines.splice(alignmentIndex, 0, alignmentRow);
        }

        // Walk only through the contiguous markdown table. This puts the new
        // Received/Given data directly after the last existing table row rather
        // than at the end of the entire section, preserving custom text below it.
        let insertIndex = alignmentIndex + 1;
        while (insertIndex < sectionLines.length) {
            const candidate = sectionLines[insertIndex]?.trim() ?? "";
            if (!candidate.startsWith("|") || !candidate.endsWith("|")) {
                break;
            }
            insertIndex += 1;
        }

        sectionLines.splice(insertIndex, 0, row);
        section = sectionLines.join("\n");
    } else {
        // The section exists but has no history table yet. Add the table at the
        // bottom of that section and put the new data row into it immediately.
        section = `${section.trimEnd()}\n\n${tableHeader}\n${alignmentRow}\n${row}`;
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

    // Write the wiki first. The wiki is the authoritative history, so Redis is
    // rebuilt from the actual persisted Given rows after both pages are updated.
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

    // Replace Redis from the awarder's complete Given wiki history. Given rows
    // contain recipient + comment URL, so they can reconstruct both Redis keys.
    // This also imports legacy/migrated wiki rows instead of only saving the new
    // award that happened during this invocation.
    const redisHistoryCount = await replaceUserHistoryRedisFromWiki(
        context,
        subredditName,
        awarder
    );

    logger.info("📄 User wiki and Redis history updated", {
        awarder,
        recipient,
        redisHistoryCount,
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

    // ──────────────── Existing wiki -> Redis migration ────────────────
    // If a leaderboard wiki page already exists, its table is authoritative on
    // the first run of this migration and replaces the existing Redis sorted set.
    // A per-page marker prevents future scheduled updates from rolling Redis back
    // to an older wiki snapshot.
    const safeWiki = new SafeWikiClient(context.reddit);
    const wikiPage = await safeWiki.getWikiPage(subredditName, wikiPageName);
    if (wikiPage) {
        await replaceLeaderboardRedisFromExistingWikiOnce(
            context,
            subredditName,
            wikiPageName,
            wikiPage
        );
    }

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
    let currentWikiPage = wikiPage;

    const wikiPageOptions = {
        subredditName,
        page: wikiPageName,
        content: wikiContents,
        reason: event.data?.reason as string | undefined,
    };

    if (currentWikiPage) {
        if (getWikiMarkdown(currentWikiPage) !== wikiContents) {
            await context.reddit.updateWikiPage(wikiPageOptions);
            console.log("Leaderboard: Leaderboard updated.");
        }
    } else {
        currentWikiPage = await context.reddit.createWikiPage(wikiPageOptions);
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

        if (!currentWikiPage) {
            throw new Error(
                `Failed to create or retrieve wiki page ${wikiPageName}`
            );
        }
        const wikiPageSettings = await currentWikiPage.getSettings();
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
