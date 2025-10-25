import { WikiPage } from "@devvit/protos";
import { CreateWikiPageOptions, RedditAPIClient, TriggerContext } from "@devvit/public-api";
import { addWeeks } from "date-fns";

export function replaceAll (input: string, pattern: string, replacement: string): string {
    return input.split(pattern).join(replacement);
}

export async function isModerator (context: TriggerContext, subredditName: string, username: string): Promise<boolean> {
    const filteredModeratorList = await context.reddit.getModerators({ subredditName, username }).all();
    return filteredModeratorList.length > 0;
}

export async function getSubredditName (context: TriggerContext): Promise<string> {
    if (context.subredditName) {
        return context.subredditName;
    }

    const subredditName = await context.redis.get("subredditname");
    if (subredditName) {
        return subredditName;
    }

    const subreddit = await context.reddit.getCurrentSubreddit();
    await context.redis.set("subredditname", subreddit.name, { expiration: addWeeks(new Date(), 1) });
    return subreddit.name;
}

export async function replacePlaceholders(template: string, placeholders: {
    author: string;
    restoree: string;
    restorer: string;
    restoreCommand: string;
    awardee: string;
    awarder: string;
    point: string;
    total: number;
    symbol: string;
    scoreboard: string;
    permalink: string;
    command: string;
}): Promise<string> {
    let result = template;
    result = replaceAll(result, "{{restore_command}}", placeholders.restoreCommand)
    result = replaceAll(result, "{{restoree}}", placeholders.restoree)
    result = replaceAll(result, "{{restorer}}", placeholders.restorer)
    result = replaceAll(result, "{{author}}", placeholders.author);
    result = replaceAll(result, "{{awardee}}", placeholders.awardee);
    result = replaceAll(result, "{{awarder}}", placeholders.awarder);
    result = replaceAll(result, "{{name}}", placeholders.point);
    result = replaceAll(result, "{{total}}", placeholders.total.toString());
    result = replaceAll(result, "{{symbol}}", placeholders.symbol);
    result = replaceAll(result, "{{scoreboard}}", placeholders.scoreboard);
    result = replaceAll(result, "{{permalink}}", placeholders.permalink);
    result = replaceAll(result, "{{command}}", placeholders.command);
    return result;
}
// export async function getWikiPage (subredditName: string, wikiPath: string): Promise<WikiPage | undefined> {
//         try {
//             const wikiPage = await this.reddit.getWikiPage(subredditName, wikiPath);
//             return wikiPage;
//         } catch (error) {
//             // Try to the error, we don't need more than the error message.
//             let errorMessage: string;
//             if (error instanceof Error) {
//                 errorMessage = error.message;
//             } else {
//                 errorMessage = String(error);
//             }

//             if (errorMessage.includes("PAGE_NOT_CREATED") || errorMessage.includes("404 Not Found")) {
//                 // If the wiki page doesn't exist, return undefined.
//                 return;
//             } else if (errorMessage.includes("Wiki page author details are missing")) {
//                 // This error occurs when the wiki page exists, but doesn't have a revision history.
//                 // We can fix this by making the first edit to the wiki page.
//                 await this.reddit.updateWikiPage({
//                     subredditName,
//                     page: wikiPath,
//                     content: "---", // Markdown renders this as a horizontal line, AutoModerator uses this to separate sections. It's a safe default for both.
//                     reason: "Devvit blank page fix",
//                 });
//                 return this.getWikiPage(subredditName, wikiPath);
//             } else {
//                 console.error("Unexpected error while getting wiki page!");
//                 throw error;
//             }
//         }
//     }

// export class SafeWikiClient {
//     constructor (protected reddit: RedditAPIClient) {}

//     /**
//      * This function safely gets the status of a wiki page. Devvit throws an error if a wiki page doesn't exist or if it doesn't have a revision history.
//      * The function will return undefined if the wiki page doesn't exist.
//      * If the wiki page exists, but doesn't have a revision history, the function will make the first edit to the wiki page before returning it.
//      * @param subredditName Subreddit of the wiki page.
//      * @param wikiPath Path of the wiki page.
//      * @returns {WikiPage | undefined} The wiki page if it exists, or undefined if it doesn't.
//      */
//     public async getWikiPage (subredditName: string, wikiPath: string): Promise<WikiPage | undefined> {
//         try {
//             const wikiPage = await this.reddit.getWikiPage(subredditName, wikiPath);
//             return wikiPage;
//         } catch (error) {
//             // Try to the error, we don't need more than the error message.
//             let errorMessage: string;
//             if (error instanceof Error) {
//                 errorMessage = error.message;
//             } else {
//                 errorMessage = String(error);
//             }

//             if (errorMessage.includes("PAGE_NOT_CREATED") || errorMessage.includes("404 Not Found")) {
//                 // If the wiki page doesn't exist, return undefined.
//                 return;
//             } else if (errorMessage.includes("Wiki page author details are missing")) {
//                 // This error occurs when the wiki page exists, but doesn't have a revision history.
//                 // We can fix this by making the first edit to the wiki page.
//                 await this.reddit.updateWikiPage({
//                     subredditName,
//                     page: wikiPath,
//                     content: "---", // Markdown renders this as a horizontal line, AutoModerator uses this to separate sections. It's a safe default for both.
//                     reason: "Devvit blank page fix",
//                 });
//                 return this.getWikiPage(subredditName, wikiPath);
//             } else {
//                 console.error("Unexpected error while getting wiki page!");
//                 throw error;
//             }
//         }
//     }

//     public async createWikiPage (options: CreateWikiPageOptions): Promise<WikiPage | undefined> {
//         try {
//             if (options.content === "") {
//                 // If the content is empty, we'll set it to "---" to avoid creating a problematic blank page.
//                 options.content = "---";
//             }
//             const createdPage = await this.reddit.createWikiPage(options);
//             return createdPage;
//         } catch (error) {
//             console.warn("Error creating wiki page", error);
//             return;
//         }
//     }
// }

export class SafeWikiClient {
    constructor (protected reddit: RedditAPIClient) {}

    /**
     * Safely gets or creates a wiki page.
     * Handles missing or uninitialized wiki pages without throwing.
     */
    public async getWikiPage (subredditName: string, wikiPath: string): Promise<WikiPage | undefined> {
        try {
            const wikiPage = await this.reddit.getWikiPage(subredditName, wikiPath);

            // 🩹 Some RedditAPIClient versions return a partial wiki page
            // Fill missing fields to satisfy the WikiPage type
            const safeWikiPage: WikiPage = {
                ...wikiPage,
                contentHtml: "",
                revisionId: "",
                revisionDate: 2025,
                contentMd: "",
                mayRevise: true,
            };

            return safeWikiPage;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            if (errorMessage.includes("PAGE_NOT_CREATED") || errorMessage.includes("404 Not Found")) {
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

            console.error("❌ Unexpected error while getting wiki page!", error);
            throw error;
        }
    }

    /**
     * Creates a wiki page safely, avoiding empty-content issues.
     */
    public async createWikiPage (options: CreateWikiPageOptions): Promise<WikiPage | undefined> {
        try {
            const content = options.content?.trim() || "---";
            const created = await this.reddit.createWikiPage({ ...options, content });

            // Ensure full WikiPage structure
            const safeWikiPage: WikiPage = {
                ...created,
                contentHtml: "",
                revisionId: "",
                revisionDate: 2025,
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
