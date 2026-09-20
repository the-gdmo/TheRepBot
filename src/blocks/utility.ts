import { CommentUpdate } from "@devvit/protos";
import {
    CreateWikiPageOptions,
    RedditAPIClient,
    TriggerContext,
    WikiPage,
} from "@devvit/public-api";
import { logger } from "./logger";

export async function isModerator(
    context: TriggerContext,
    subredditName: string,
    username: string
): Promise<boolean> {
    const filteredModeratorList = await context.reddit
        .getModerators({ subredditName, username })
        .all();
    return filteredModeratorList.length > 0;
}

export async function getSubredditName(
    context: TriggerContext
): Promise<string> {
    if (context.subredditName) {
        return context.subredditName;
    }

    const subredditName = await context.redis.get("subredditname");
    if (subredditName) {
        return subredditName;
    }

    const subreddit = await context.reddit.getCurrentSubreddit();
    await context.redis.set("subredditname", subreddit.name);
    return subreddit.name;
}

export class SafeWikiClient {
    constructor(protected reddit: RedditAPIClient) {}

    /**
     * Safely gets or creates a wiki page.
     * Handles missing or uninitialized wiki pages without throwing.
     */
    public async getWikiPage(
        subredditName: string,
        wikiPath: string
    ): Promise<WikiPage | undefined> {
        try {
            const wikiPage = await this.reddit.getWikiPage(
                subredditName,
                wikiPath
            );

            // Return the actual WikiPage object intact. Modern Devvit exposes
            // markdown through WikiPage.content; reconstructing/spreading this
            // class can drop accessor-backed fields and lose the page content.
            return wikiPage;
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : String(error);

            if (
                errorMessage.includes("PAGE_NOT_CREATED") ||
                errorMessage.includes("404 Not Found")
            ) {
                // Page doesn't exist
                return;
            }

            if (errorMessage.includes("Wiki page author details are missing")) {
                // Do not seed/overwrite this page. The page may contain history,
                // and preserving existing wiki content is more important than
                // silently replacing an unreadable revision with placeholder text.
                logger.warn("Wiki page exists but could not be read safely", {
                    subredditName,
                    wikiPath,
                    error: errorMessage,
                });
                throw error;
            }

            console.error(
                "❌ Unexpected error while getting wiki page!",
                error
            );
            throw error;
        }
    }

    /**
     * Creates a wiki page safely, avoiding empty-content issues.
     */
    public async createWikiPage(
        options: CreateWikiPageOptions
    ): Promise<WikiPage | undefined> {
        try {
            const content = options.content?.trim() || "---";
            const created = await this.reddit.createWikiPage({
                ...options,
                content,
            });

            return created;
        } catch (error) {
            console.warn("⚠️ Error creating wiki page:", error);
            return;
        }
    }
}

export async function handleConfirmReply(
    event: CommentUpdate,
    context: TriggerContext
) {
    if (!event.comment || !event.author) return;

    const messageBody = event.comment.body?.trim().toUpperCase() ?? "";
    if (!messageBody.includes("CONFIRM")) return;

    const username = event.author.name.toLowerCase();
    const pendingKey = `pendingConfirm:${username}`;
    const contextType = await context.redis.get(pendingKey);

    // If no pending confirmation, nothing to do
    if (!contextType) {
        logger.debug(`ℹ️ No pending confirmation found for ${username}`);
        return;
    }

    // Store that this user has confirmed this type
    await context.redis.set(`ignoreDM:${username}:${contextType}`, "true");
    await context.redis.del(pendingKey);

    // DM the user acknowledging confirmation
    await context.reddit.sendPrivateMessage({
        to: event.author.name,
        subject: "Confirmation received ✅",
        text: `Got it — you won't be notified again when you use commands inside ${contextType} text.`,
    });

    logger.info("✅ User confirmed ignore preference", {
        username,
        contextType,
    });
}
