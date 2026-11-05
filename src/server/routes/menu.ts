import { Hono } from "hono";
import type { UiResponse, MenuItemRequest } from "@devvit/web/shared";
import type { Context } from "@devvit/web/server";
import { redis } from "@devvit/web/server";

import {
    createRequestContext,
    showForm,
    toUiResponse,
    type UiCapture,
} from "../core/request-context";

import {
    handleCommentPin,
    checkFlairToggle,
    transferWikiForm,
    handleFlairToggleForUser,
} from "../core/moderation";

import {
    handleManualPointSetting,
    handleManualUserWikiTotalsSetting,
    handleManualPostRestrictionRemoval,
    handlePostRestrictionCheck,
} from "../core/utils/mod-utilities";

export const menu = new Hono();

const NUMBER_OF_USERS_KEY = "leaderboard:numberOfUsers";

type MenuHandler = (event: MenuItemRequest, context: Context) => Promise<void>;

/**
 * Menu actions that execute immediately or open a form.
 */

const menuHandlers: Record<string, MenuHandler> = {
    "/flair-toggle-for-user": handleFlairToggleForUser,
    "/check-flair-toggle": checkFlairToggle,
    "/remove-post-restriction": handleManualPostRestrictionRemoval,
    "/check-post-restriction": handlePostRestrictionCheck,
    "/pin-comment": handleCommentPin,
    "/set-points": handleManualPointSetting,
    "/set-user-wiki-totals": handleManualUserWikiTotalsSetting,
};

/**
 * Register menu action routes.
 */
for (const [path, handler] of Object.entries(menuHandlers)) {
    menu.post(path, async (c) => {
        const data = await c.req.json().catch(() => ({}));
        const capture: UiCapture = {};

        try {
            const context = await createRequestContext(data, capture);

            await handler(data as MenuItemRequest, context);

            return c.json<UiResponse>(toUiResponse(capture), 200);
        } catch (error) {
            console.error(`Menu handler failed for ${path}:`, error);

            return c.json<UiResponse>(
                {
                    showToast: {
                        text: "The moderator action could not be completed.",
                        appearance: "neutral",
                    },
                },
                500
            );
        }
    });
}

/**
 * Transfer wiki form.
 */
menu.post("/transfer-wiki", async (c) => {
    const capture: UiCapture = {};

    try {
        const context = await createRequestContext({}, capture);

        showForm(context, transferWikiForm);

        return c.json<UiResponse>(toUiResponse(capture), 200);
    } catch (error) {
        console.error("Failed to open transfer wiki form:", error);

        return c.json<UiResponse>(
            {
                showToast: {
                    text: "Unable to open the transfer wiki form.",
                    appearance: "neutral",
                },
            },
            500
        );
    }
});

/**
 * Create leaderboard post form.
 */
menu.post("/create-post", async (c) => {
    return c.json<UiResponse>(
        {
            showForm: {
                name: "post-create-form",
                form: {
                    title: "Create Leaderboard Post",
                    fields: [
                        {
                            label: "Post title",
                            name: "postTitle",
                            type: "string",
                            defaultValue: "RepBot High Scores",
                        },
                        {
                            label: "Sticky post",
                            name: "stickyPost",
                            type: "boolean",
                            defaultValue: true,
                        },
                        {
                            label: "Remove previous leaderboard post",
                            name: "removeExisting",
                            type: "boolean",
                            defaultValue: true,
                        },
                        {
                            label: "Lock comment by bot?",
                            name: "lockBotComment",
                            type: "boolean",
                            defaultValue: true,
                        },
                    ],
                },
            },
        },
        200
    );
});

/**
 * Get the configured leaderboard size.
 */
export const getLeaderboardSize = async (): Promise<number> => {
    const value = await redis.get(NUMBER_OF_USERS_KEY);
    const size = Number.parseInt(value ?? "20", 10);

    return Number.isFinite(size) && size > 0 ? size : 20;
};
