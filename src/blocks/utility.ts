import { CommentUpdate, WikiPage } from "@devvit/protos";
import {
    CreateWikiPageOptions,
    RedditAPIClient,
    TriggerContext,
} from "@devvit/public-api";
import { logger } from "./logger";

export async function isModerator(
    context: TriggerContext,
    subredditName: string,
    username: string,
): Promise<boolean> {
    const filteredModeratorList = await context.reddit
        .getModerators({ subredditName, username })
        .all();
    return filteredModeratorList.length > 0;
}

export async function getSubredditName(
    context: TriggerContext,
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
        wikiPath: string,
    ): Promise<WikiPage | undefined> {
        try {
            const wikiPage = await this.reddit.getWikiPage(
                subredditName,
                wikiPath,
            );

            // 🩹 Some RedditAPIClient versions return a partial wiki page
            // Fill missing fields to satisfy the WikiPage type
            const safeWikiPage: WikiPage = {
                ...wikiPage,
                contentHtml: "",
                revisionId: "",
                revisionDate: Date.now(),
                contentMd: "",
                mayRevise: true,
            };

            return safeWikiPage;
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
                // Page exists but has no revision history → seed with safe content
                await this.reddit.updateWikiPage({
                    subredditName,
                    page: wikiPath,
                    content: "---",
                    reason: "Devvit blank page fix",
                });
                // Try again
                return this.getWikiPage(subredditName, wikiPath);
            }

            console.error(
                "❌ Unexpected error while getting wiki page!",
                error,
            );
            throw error;
        }
    }

    /**
     * Creates a wiki page safely, avoiding empty-content issues.
     */
    public async createWikiPage(
        options: CreateWikiPageOptions,
    ): Promise<WikiPage | undefined> {
        try {
            const content = options.content?.trim() || "---";
            const created = await this.reddit.createWikiPage({
                ...options,
                content,
            });

            // Ensure full WikiPage structure
            const safeWikiPage: WikiPage = {
                ...created,
                contentHtml: "",
                revisionId: "",
                revisionDate: Date.now(),
                contentMd: "",
                mayRevise: true,
            };

            return safeWikiPage;
        } catch (error) {
            console.warn("⚠️ Error creating wiki page:", error);
            return;
        }
    }
}

export async function handleConfirmReply(
    event: CommentUpdate,
    context: TriggerContext,
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
