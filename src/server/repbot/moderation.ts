import type { Context, FormOnSubmitEvent, JSONObject, MenuItemOnPressEvent, User } from "./compat";
import { SafeWikiClient } from "./utility";
import { logger } from "./logger";
import { reddit, redis } from "@devvit/web/server";

export const manualSetPointsForm = { name: "manualSetPointsForm", title: "Set user score manually" };
export const manualSetUserWikiTotalsForm = { name: "manualSetUserWikiTotalsForm", title: "Set user given/received totals" };
export const manualSetFlairManagementForm = { name: "manualSetFlairManagementForm", title: "Set flair management" };
export const manualSetFlairManagementForUserForm = { name: "manualSetFlairManagementForUserForm", title: "Set flair management for user" };
export const manualPostRestrictionRemovalForm = { name: "manualPostRestrictionRemovalForm", title: "Remove post restriction" };
export const transferWikiForm = { name: "transferWikiForm", title: "Transfer wiki page", fields: [
  { type: "string", name: "sourcePage", label: "Source wiki page", placeholder: "example/source", required: true },
  { type: "string", name: "destinationPage", label: "Destination wiki page", placeholder: "example/destination", required: true },
] };

export async function handleCommentPin(
    event: MenuItemOnPressEvent,
    context: Context
): Promise<void> {
    if (event.location !== "comment" || !event.targetId) {
        context.ui.showToast({
            text: "Invalid comment target",
        });
        return;
    }

    try {
        const comment = await reddit.getCommentById(event.targetId as `t1_${string}`);
        if (!comment) {
            context.ui.showToast({
                text: "Comment not found",
            });
            return;
        }

        const appUser = await reddit.getAppUser();

        if (comment.authorName !== appUser!.username) {
            context.ui.showToast({
                text: "Only comments created by u/therepbot can be pinned",
            });
            logger.warn("❌ Attempted to pin non-bot comment", {
                commentAuthor: comment.authorName,
                botUsername: appUser!.username,
            });
            return;
        }

        // 🔒 Must be a top-level comment (parent is the post)
        if (!comment.parentId?.startsWith("t3_")) {
            context.ui.showToast({
                text: "Only top-level comments can be pinned",
            });
            await logger.error(
                `❌ Attempted to pin comment that isn't top-level`
            );
            return;
        }

        if (comment.isStickied()) {
            context.ui.showToast({
                text: "This comment is already pinned",
            });
            await logger.error(
                `❌ Attempted to pin comment that is already stickied`
            );
            return;
        }
        await comment.distinguish(true);

        context.ui.showToast({
            text: "Comment pinned successfully",
        });

        logger.info("📌 Comment pinned", {
            commentId: comment.id,
        });
    } catch (err) {
        await logger.error("❌ Failed to pin comment", {
            commentId: event.targetId,
            error: String(err),
        });

        context.ui.showToast({
            text: "Failed to pin comment",
        });
    }
}

export async function handleFlairToggle(
    event: MenuItemOnPressEvent,
    context: Context
) {
    try {
        if (!event.targetId || !event.location) {
            context.ui.showToast("Invalid target");
            return;
        }

        let currentValue = "";

        const username = await getAuthorFromTarget(context, event.targetId);
        const key = `flairToggle:${username}`;
        const exists = await redis.exists(key);

        if (!username) {
            context.ui.showToast(
                "Cannot toggle flair. User may be shadowbanned"
            );
            return;
        }

        if (exists) {
            currentValue = "disabled";
        } else {
            currentValue = "enabled";
        }

        const fields = [
            {
                name: "isEnabled",
                type: "string",
                label: `Flair management for u/${username}`,
                defaultValue: currentValue,
                helpText:
                    "Case insensitive. 'enabled' = bot manages flair, 'disabled' = bot will not manage flair",
                required: true,
            },
        ];

        context.ui.showForm(manualSetFlairManagementForm, { fields });
    } catch (err) {
        logger.error("❌ Failed to toggle flair management", {
            error: String(err),
        });

        context.ui.showToast(
            "An error occurred while toggling flair management"
        );
    }
}

export async function checkFlairToggle(
    event: MenuItemOnPressEvent,
    context: Context
): Promise<void> {
    if (!event.targetId) {
        context.ui.showToast("Invalid target");
        return;
    }

    const username = await getAuthorFromTarget(context, event.targetId);

    if (!username) {
        context.ui.showToast("Could not resolve user");
        return;
    }

    const key = `flairToggle:${username}`;
    const exists = await redis.exists(key);

    if (exists) {
        context.ui.showToast(
            `Flair management is currently disabled for u/${username}`
        );
    } else {
        context.ui.showToast(
            `Flair management is currently enabled for u/${username}`
        );
    }
}

export async function getAuthorFromTarget(
    _: Context,
    targetId: string
): Promise<string | null> {
    if (!targetId) return null;
    try {
        // Try comment first
        const comment = await reddit.getCommentById(targetId as `t1_${string}`);
        return comment?.authorName ?? null;
    } catch {}

    try {
        // Try post fallback
        const post = await reddit.getPostById(targetId as `t3_${string}`);
        return post?.authorName ?? null;
    } catch {}

    return null;
}

export async function manualSetFlairManagementFormHandler(
    event: FormOnSubmitEvent<JSONObject>,
    context: Context
) {
    const value = event.values.isEnabled as string | undefined;
    if (!value) {
        context.ui.showToast("Your entry must contain a value");
        return;
    }
    const enabled = /^enabled$/i;
    const disabled = /^disabled$/i;
    if (!disabled.test(value) && !enabled.test(value)) {
        context.ui.showToast(`You must enter "enabled" or "disabled"`);
        return;
    }

    if (!context.commentId) return;
    const comment = await reddit.getCommentById(context.commentId);

    let user: User | undefined;
    try {
        user = await reddit.getUserByUsername(comment.authorName);
    } catch {
        //
    }

    if (!user) {
        context.ui.showToast("Cannot set points. User may be shadowbanned");
        return;
    }

    let targetId: string | undefined;

    if (context.commentId) {
        targetId = context.commentId;
    } else if (context.postId) {
        targetId = context.postId;
    }

    if (!targetId) {
        context.ui.showToast(`Could not resolve user`);
        return;
    }

    const username = await getAuthorFromTarget(context, targetId);
    const key = `flairToggle:${username}`;

    if (!username) {
        context.ui.showToast("Cannot toggle flair. User may be shadowbanned");
        return;
    }

    // enabled = no key
    if (enabled.test(value)) {
        await redis.del(key);
    } else if (disabled.test(value)) {
        await redis.set(key, "disabled");
    }

    context.ui.showToast(
        `Flair management for u/${user.username} is now ${value}`
    );
}

export async function handleFlairToggleForUser(
    _: MenuItemOnPressEvent,
    context: Context
) {
    try {
        const fields = [
            {
                name: "target",
                type: "string",
                label: "Target Username (no u/)",
                defaultValue: "",
                helpText:
                    "Case insensitive. The username of the user you want to toggle flair management for",
                required: true,
            },
            {
                name: "isEnabled",
                type: "string",
                label: `Set Flair Management Status`,
                defaultValue: "",
                helpText:
                    "Case insensitive. 'enabled' = bot manages flair, 'disabled' = bot will not manage flair",
                required: true,
            },
        ];

        context.ui.showForm(manualSetFlairManagementForUserForm, { fields });
    } catch (err) {
        logger.error("❌ Failed to toggle flair management", {
            error: String(err),
        });

        context.ui.showToast(
            "An error occurred while toggling flair management"
        );
    }
}

export async function manualSetFlairManagementForUserFormHandler(
    event: FormOnSubmitEvent<JSONObject>,
    context: Context
) {
    const isEnabled = event.values.isEnabled as string | undefined;
    const target = event.values.target as string | undefined;

    if (!target) {
        context.ui.showToast("Target user is required");
        return;
    }

    if (!isEnabled) {
        context.ui.showToast("Enablement status is required");
        return;
    }

    const enabled = /^enabled$/i;
    const disabled = /^disabled$/i;

    if (!disabled.test(isEnabled) && !enabled.test(isEnabled)) {
        context.ui.showToast(`You must enter "enabled" or "disabled"`);
        return;
    }

    const userRegex = /^[a-z0-9\_\-]{3,21}$/i;

    if (!userRegex.test(target)) {
        context.ui.showToast(
            "Username must be between 3 and 21 characters long and contain only letters, numbers, underscores, or hyphens"
        );
        return;
    }

    // 🔍 Resolve user from target
    const key = `flairToggle:${target}`;

    // enabled = no key
    if (enabled.test(isEnabled)) {
        await redis.del(key);
    } else if (disabled.test(isEnabled)) {
        await redis.set(key, "disabled");
    }

    context.ui.showToast(
        `Flair management for u/${target} is now ${isEnabled}`
    );
}

export function normalizeWikiPath(input: string): string {
    let path = input.trim();

    // Allow someone to paste:
    // foo/bar
    // wiki/foo/bar
    // /wiki/foo/bar
    path = path.replace(/^\/?wiki\//i, path);

    // Strip leading/trailing slashes.
    path = path.replace(/^\/+|\/+$/g, path);

    return path;
}


export async function transferWikiFormHandler(event: FormOnSubmitEvent<JSONObject>, context: Context) {
  const sourcePage = normalizeWikiPath(String(event.values.sourcePage ?? ""));
  const destinationPage = normalizeWikiPath(String(event.values.destinationPage ?? ""));
  if (!sourcePage || !destinationPage) {
    context.ui.showToast("Source and destination pages are required.");
    return;
  }
  if (sourcePage === destinationPage) {
    context.ui.showToast("Source and destination cannot be the same page.");
    return;
  }
  try {
    const subreddit = await reddit.getCurrentSubreddit();
    const safeWiki = new SafeWikiClient(reddit);
    const result = await safeWiki.copyWikiPage(subreddit.name, sourcePage, destinationPage);
    context.ui.showToast(result === "created" ? `Created wiki/${destinationPage} from wiki/${sourcePage}.` : `Updated wiki/${destinationPage} from wiki/${sourcePage}.`);
  } catch (error) {
    console.error("Wiki transfer failed:", error);
    context.ui.showToast({ text: error instanceof Error ? error.message : "Unknown wiki transfer error.", appearance: "neutral" });
  }
}
