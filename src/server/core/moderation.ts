import { SafeWikiClient } from "./utils/utility";
import { showToast, showForm } from "./request-context";
import { logger } from "./utils/logger";
import { reddit, redis } from "@devvit/web/server";
import type { Context, User } from "@devvit/web/server";
import type { JsonObject, MenuItemRequest } from "@devvit/web/shared";

type JSONObject = Record<string, any>;

type FormOnSubmitEvent<T extends Record<string, any> = Record<string, any>> = {
    values: T;
    data?: Record<string, unknown>;
};

export const manualSetPointsForm = {
    name: "manualSetPointsForm",
    title: "Set user score manually",
};

export const manualSetUserWikiTotalsForm = {
    name: "manualSetUserWikiTotalsForm",
    title: "Set user given/received totals",
};

export const manualSetFlairManagementForm = {
    name: "manualSetFlairManagementForm",
    title: "Set flair management",
};

export const manualSetFlairManagementForUserForm = {
    name: "manualSetFlairManagementForUserForm",
    title: "Set flair management for user",
};

export const manualPostRestrictionRemovalForm = {
    name: "manualPostRestrictionRemovalForm",
    title: "Remove post restriction",
};

export const transferWikiForm = {
    name: "transferWikiForm",
    title: "Transfer wiki page",
    fields: [
        {
            type: "string",
            name: "sourcePage",
            label: "Source wiki page",
            placeholder: "example/source",
            required: true,
        },
        {
            type: "string",
            name: "destinationPage",
            label: "Destination wiki page",
            placeholder: "example/destination",
            required: true,
        },
    ],
};

export async function handleCommentPin(
    event: MenuItemRequest,
    context: Context
): Promise<void> {
    if (event.location !== "comment" || !event.targetId) {
        showToast(context, "Invalid comment target");
        return;
    }

    try {
        const comment = await reddit.getCommentById(
            event.targetId as `t1_${string}`
        );

        if (!comment) {
            showToast(context, "Comment not found");
            return;
        }

        const appUser = await reddit.getAppUser();

        if (comment.authorName !== appUser?.username) {
            showToast(
                context,
                "Only comments created by u/therepbot can be pinned"
            );

            logger.warn("Attempted to pin non-bot comment", {
                commentAuthor: comment.authorName,
                botUsername: appUser?.username,
            });

            return;
        }

        if (!comment.parentId?.startsWith("t3_")) {
            showToast(context, "Only top-level comments can be pinned");
            await logger.error(
                "Attempted to pin a comment that is not top-level"
            );
            return;
        }

        if (comment.isStickied()) {
            showToast(context, "This comment is already pinned");
            await logger.error(
                "Attempted to pin a comment that is already stickied"
            );
            return;
        }

        await comment.distinguish(true);

        showToast(context, "Comment pinned successfully");

        logger.info("Comment pinned", {
            commentId: comment.id,
        });
    } catch (error) {
        await logger.error("Failed to pin comment", {
            commentId: event.targetId,
            error: String(error),
        });

        showToast(context, "Failed to pin comment");
    }
}

export async function handleFlairToggle(
    event: MenuItemRequest,
    context: Context
): Promise<void> {
    try {
        if (!event.targetId || !event.location) {
            showToast(context, "Invalid target");
            return;
        }

        const username = await getAuthorFromTarget(context, event.targetId);

        if (!username) {
            showToast(context, "Cannot toggle flair. User may be shadowbanned");
            return;
        }

        const key = `flairToggle:${username}`;
        const exists = await redis.exists(key);
        const currentValue = exists ? "disabled" : "enabled";

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

        showForm(context, manualSetFlairManagementForm, { fields });
    } catch (error) {
        logger.error("Failed to toggle flair management", {
            error: String(error),
        });

        showToast(context, "An error occurred while toggling flair management");
    }
}

export async function checkFlairToggle(
    event: MenuItemRequest,
    context: Context
): Promise<void> {
    if (!event.targetId) {
        showToast(context, "Invalid target");
        return;
    }

    const username = await getAuthorFromTarget(context, event.targetId);

    if (!username) {
        showToast(context, "Could not resolve user");
        return;
    }

    const key = `flairToggle:${username}`;
    const exists = await redis.exists(key);

    if (exists) {
        showToast(
            context,
            `Flair management is currently disabled for u/${username}`
        );
    } else {
        showToast(
            context,
            `Flair management is currently enabled for u/${username}`
        );
    }
}

export async function getAuthorFromTarget(
    _context: Context,
    targetId: string
): Promise<string | null> {
    if (!targetId) {
        return null;
    }

    try {
        const comment = await reddit.getCommentById(targetId as `t1_${string}`);
        return comment?.authorName ?? null;
    } catch {
        // It may be a post ID instead.
    }

    try {
        const post = await reddit.getPostById(targetId as `t3_${string}`);
        return post?.authorName ?? null;
    } catch {
        // Neither a comment nor a post could be resolved.
    }

    return null;
}

export async function manualSetFlairManagementFormHandler(
    event: FormOnSubmitEvent<JSONObject>,
    context: Context
): Promise<void> {
    const value = event.values.isEnabled as string | undefined;

    if (!value) {
        showToast(context, "Your entry must contain a value");
        return;
    }

    const enabled = /^enabled$/i;
    const disabled = /^disabled$/i;

    if (!disabled.test(value) && !enabled.test(value)) {
        showToast(context, 'You must enter "enabled" or "disabled"');
        return;
    }

    const targetId = context.commentId ?? context.postId;

    if (!targetId) {
        showToast(context, "Could not resolve the target user");
        return;
    }

    const username = await getAuthorFromTarget(context, targetId);

    if (!username) {
        showToast(context, "Cannot toggle flair. User may be shadowbanned");
        return;
    }

    let user: User | undefined;

    try {
        user = await reddit.getUserByUsername(username);
    } catch {
        // The target user may no longer be available.
    }

    if (!user) {
        showToast(context, "Cannot resolve the target user");
        return;
    }

    const key = `flairToggle:${username}`;

    if (enabled.test(value)) {
        await redis.del(key);
    } else {
        await redis.set(key, "disabled");
    }

    showToast(
        context,
        `Flair management for u/${user.username} is now ${value}`
    );
}

export async function handleFlairToggleForUser(
    _event: MenuItemRequest,
    context: Context
): Promise<void> {
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
            label: "Set Flair Management Status",
            defaultValue: "",
            helpText:
                "Case insensitive. 'enabled' = bot manages flair, 'disabled' = bot will not manage flair",
            required: true,
        },
    ];

    showForm(context, manualSetFlairManagementForUserForm, { fields });
}

export async function manualSetFlairManagementForUserFormHandler(
    event: FormOnSubmitEvent<JsonObject>,
    context: Context
): Promise<void> {
    const isEnabled = event.values.isEnabled as string | undefined;
    const target = (event.values.target as string | undefined)?.trim();

    if (!target) {
        showToast(context, "Target user is required");
        return;
    }

    if (!isEnabled) {
        showToast(context, "Enablement status is required");
        return;
    }

    const enabled = /^enabled$/i;
    const disabled = /^disabled$/i;

    if (!disabled.test(isEnabled) && !enabled.test(isEnabled)) {
        showToast(context, 'You must enter "enabled" or "disabled"');
        return;
    }

    const userRegex = /^[a-z0-9_-]{3,21}$/i;

    if (!userRegex.test(target)) {
        showToast(
            context,
            "Username must be between 3 and 21 characters long and contain only letters, numbers, underscores, or hyphens"
        );
        return;
    }

    const key = `flairToggle:${target}`;

    if (enabled.test(isEnabled)) {
        await redis.del(key);
    } else {
        await redis.set(key, "disabled");
    }

    showToast(context, `Flair management for u/${target} is now ${isEnabled}`);
}

export function normalizeWikiPath(input: string): string {
    let path = input.trim();

    // Accept foo/bar, wiki/foo/bar, or /wiki/foo/bar.
    path = path.replace(/^\/?wiki\//i, "");

    // Remove leading and trailing slashes.
    path = path.replace(/^\/+|\/+$/g, "");

    return path;
}

export async function transferWikiFormHandler(
    event: FormOnSubmitEvent<JSONObject>,
    context: Context
): Promise<void> {
    const sourcePage = normalizeWikiPath(String(event.values.sourcePage ?? ""));

    const destinationPage = normalizeWikiPath(
        String(event.values.destinationPage ?? "")
    );

    if (!sourcePage || !destinationPage) {
        showToast(context, "Source and destination pages are required.");
        return;
    }

    if (sourcePage === destinationPage) {
        showToast(context, "Source and destination cannot be the same page.");
        return;
    }

    try {
        const subreddit = await reddit.getCurrentSubreddit();
        const safeWiki = new SafeWikiClient(reddit);

        const result = await safeWiki.copyWikiPage(
            subreddit.name,
            sourcePage,
            destinationPage
        );

        showToast(
            context,
            result === "created"
                ? `Created wiki/${destinationPage} from wiki/${sourcePage}.`
                : `Updated wiki/${destinationPage} from wiki/${sourcePage}.`
        );
    } catch (error) {
        console.error("Wiki transfer failed:", error);

        showToast(
            context,
            error instanceof Error
                ? error.message
                : "Unknown wiki transfer error."
        );
    }
}
