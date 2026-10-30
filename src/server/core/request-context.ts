import { reddit, redis, scheduler } from "@devvit/web/server";
import type { UiResponse } from "@devvit/web/shared";

export type UiCapture = {
    response?: UiResponse;
};

type UiForm = {
    name?: string;
    title?: string;
    fields?: unknown[];
};

type Toast = {
    text: string;
    appearance?: "success" | "neutral" | "error";
};

type FormOptions = {
    fields?: unknown[];
    data?: Record<string, unknown>;
};

/**
 * Build a context for existing business handlers while capturing
 * UI responses for the Hono route.
 */
export async function createRequestContext(
    event: any = {},
    capture: UiCapture = {}
): Promise<any> {
    const source =
        event?.data && typeof event.data === "object"
            ? { ...event.data, ...event }
            : event;

    const subreddit = source?.subreddit ?? source?.community;
    const post = source?.post;
    const comment = source?.comment;
    const targetId = source?.targetId ?? source?.thingId;

    let username =
        source?.username ??
        source?.userName ??
        source?.authorName ??
        source?.author?.name ??
        source?.user?.username ??
        source?.user?.name;

    if (!username && source?.userId) {
        try {
            const user = await reddit.getUserById(source.userId);
            username = user?.username;
        } catch {
            // Some events do not contain a resolvable user.
        }
    }

    const context: any = {
        ...source,

        subredditName: source?.subredditName ?? subreddit?.name,
        subredditId: source?.subredditId ?? subreddit?.id,

        postId:
            source?.postId ??
            post?.id ??
            (source?.location === "post" ? targetId : undefined),

        commentId:
            source?.commentId ??
            comment?.id ??
            (source?.location === "comment" ? targetId : undefined),

        username,

        appSlug: source?.appSlug ?? "therepbot",
        appVersion: source?.appVersion ?? "31.7.7",

        reddit,
        redis,
        scheduler,

        ui: {
            showToast(toast: Toast) {
                capture.response = {
                    showToast: toast,
                } as UiResponse;
            },

            showForm(form: UiForm, options?: FormOptions) {
                const fields = options?.fields ?? form.fields ?? [];

                capture.response = {
                    showForm: {
                        name: form.name ?? "moderator-form",
                        form: {
                            title: form.title ?? form.name ?? "Moderator form",
                            fields,
                        },
                        data: {
                            postId: context.postId,
                            commentId: context.commentId,
                            username: context.username,
                            ...(options?.data ?? {}),
                        },
                    },
                } as UiResponse;
            },
        },
    };

    return context;
}

export function showToast(
    context: unknown,
    text: string,
    appearance: Toast["appearance"] = "neutral"
): void {
    (context as any)?.ui?.showToast?.({
        text,
        appearance,
    });
}

export function showForm(
    context: unknown,
    form: UiForm,
    options?: FormOptions
): void {
    (context as any)?.ui?.showForm?.(form, options);
}

export function toUiResponse(capture: UiCapture): UiResponse {
    return capture.response ?? {};
}
