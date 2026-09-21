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
   * Safely gets a wiki page.
   * Returns undefined when the page has never been created.
   */
  public async getWikiPage(
    subredditName: string,
    wikiPath: string
  ): Promise<WikiPage | undefined> {
    try {
      return await this.reddit.getWikiPage(
        subredditName,
        wikiPath
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (
        errorMessage.includes("PAGE_NOT_CREATED") ||
        errorMessage.includes("404 Not Found")
      ) {
        return undefined;
      }

      if (
        errorMessage.includes(
          "Wiki page author details are missing"
        )
      ) {
        console.warn(
          "Wiki page exists but could not be read safely",
          {
            subredditName,
            wikiPath,
            error: errorMessage,
          }
        );

        throw error;
      }

      console.error(
        "Unexpected error while getting wiki page",
        error
      );

      throw error;
    }
  }

  /**
   * Creates a wiki page.
   */
  public async createWikiPage(
    options: CreateWikiPageOptions
  ): Promise<WikiPage | undefined> {
    try {
      // Don't .trim() here if this method is being used
      // to copy wiki content exactly.
      const content =
        options.content.length > 0
          ? options.content
          : "---";

      return await this.reddit.createWikiPage({
        ...options,
        content,
      });
    } catch (error) {
      console.warn("Error creating wiki page:", error);
      return undefined;
    }
  }

  /**
   * Copy one wiki page to another.
   *
   * Creates the destination if it does not exist.
   * Updates it if it already exists.
   */
  public async copyWikiPage(
    subredditName: string,
    sourcePath: string,
    destinationPath: string
  ): Promise<"created" | "updated"> {
    const source = await this.getWikiPage(
      subredditName,
      sourcePath
    );

    if (!source) {
      throw new Error(
        `Source wiki page "${sourcePath}" does not exist.`
      );
    }

    const destination = await this.getWikiPage(
      subredditName,
      destinationPath
    );

    // Important: use the WikiPage.content accessor directly.
    const content = source.content;

    const reason =
      `Copied from wiki/${sourcePath}`;

    if (destination) {
      await this.reddit.updateWikiPage({
        subredditName,
        page: destinationPath,
        content,
        reason,
      });

      return "updated";
    }

    const created = await this.createWikiPage({
      subredditName,
      page: destinationPath,
      content,
      reason,
    });

    if (!created) {
      throw new Error(
        `Failed to create destination wiki page "${destinationPath}".`
      );
    }

    return "created";
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
