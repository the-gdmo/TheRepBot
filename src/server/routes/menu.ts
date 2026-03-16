import { Hono } from "hono";
import type { UiResponse } from "@devvit/web/shared";

export const menu = new Hono();

menu.post("/create-post", async (c) => {
    try {
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
                        ],
                    },
                },
            },
            200,
        );
    } catch (error) {
        console.error(`Error creating post: ${error}`);
        return c.json<UiResponse>(
            {
                showToast: "Failed to create post",
            },
            400,
        );
    }
});
