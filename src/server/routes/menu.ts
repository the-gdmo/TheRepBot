import { Hono } from "hono";
import type { UiResponse } from "@devvit/web/shared";
import { redis } from "@devvit/web/server";
import {
    createRequestContext,
    showForm,
    toUiResponse,
    type UiCapture,
} from "../core/request-context";
import {
    handleCommentPin,
    handleFlairToggle,
    checkFlairToggle,
    handleFlairToggleForUser,
    transferWikiForm,
} from "../core/moderation";
import {
    handleManualPointSetting,
    handleManualUserWikiTotalsSetting,
    handleManualPostRestrictionRemoval,
    handlePostRestrictionCheck,
    handleUserRestrictionCheck,
} from "../core/utils/mod-utilities";

export const menu = new Hono();

const NUMBER_OF_USERS_KEY = "leaderboard:numberOfUsers";

const menuHandlers: Record<string, (event: any, context: any) => Promise<any>> =
    {
        "/flair-toggle-for-user": handleFlairToggleForUser,
        "/remove-post-restriction": handleManualPostRestrictionRemoval,
        "/check-post-restriction": handlePostRestrictionCheck,
        "/check-user-restriction": handleUserRestrictionCheck,
        "/pin-comment": handleCommentPin,
        "/check-flair-toggle": checkFlairToggle,
        "/toggle-flair": handleFlairToggle,
        "/set-points": handleManualPointSetting,
        "/set-user-wiki-totals": handleManualUserWikiTotalsSetting,
    };

for (const [path, handler] of Object.entries(menuHandlers)) {
    menu.post(path, async (c) => {
        const data = await c.req.json().catch(() => ({}));
        const capture: UiCapture = {};

        try {
            const context = await createRequestContext(data, capture);
            await handler(data, context);

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

menu.post("/transfer-wiki", async (c) => {
    const capture: UiCapture = {};
    const context = await createRequestContext({}, capture);

    showForm(context, transferWikiForm);

    return c.json<UiResponse>(toUiResponse(capture), 200);
});

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
                            defaultValue: "TheRepBot High Scores",
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

export const getLeaderboardSize = async (): Promise<number> => {
    const value = await redis.get(NUMBER_OF_USERS_KEY);
    const size = Number.parseInt(value ?? "20", 10);

    return Number.isFinite(size) && size > 0 ? size : 20;
};
