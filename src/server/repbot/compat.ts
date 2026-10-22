/**
 * Devvit Web compatibility surface for RepBot's migrated business logic.
 * These are local structural types only; no Blocks runtime is used.
 */
import {
    context as webContext,
    reddit,
    redis,
    settings,
    scheduler,
} from "@devvit/web/server";

export type Context = any;
export type TriggerContext = any;
export type JobContext = any;
export type FormOnSubmitEvent<T = any> = { values: T; [key: string]: any };
export type MenuItemOnPressEvent = {
    targetId?: string;
    location?: string;
    [key: string]: any;
};
export type JSONObject = Record<string, any>;
export type FormField = any;
export type SettingsFormField = any;
export type SettingsFormFieldValidatorEvent<T = any> = {
    value: T;
    [key: string]: any;
};
export type User = any;
export type Comment = any;
export type Post = any;
export type WikiPage = any;
export type CreateWikiPageOptions = any;
export type RedditAPIClient = any;
export type ModMailService = any;
export type SettingsValues = Record<string, any>;

export type UiCapture = {
    showToast?: unknown;
    showForm?: unknown;
    navigateTo?: string;
};

/** Build the context shape the original business logic used from Devvit Web services. */
export function createCompatContext(
    requestData: Record<string, any> = {},
    capture?: UiCapture
): any {
    const ui = {
        showToast(value: any) {
            if (capture)
                capture.showToast =
                    typeof value === "string" ? { text: value } : value;
        },
        showForm(form: any, data?: any) {
            if (!capture) return;
            const name =
                typeof form === "string"
                    ? form
                    : form?.name ?? form?.id ?? "repbot-form";
            capture.showForm = {
                name,
                form: {
                    title: form?.title ?? name,
                    description: form?.description,
                    fields: data?.fields ?? form?.fields ?? [],
                    acceptLabel: form?.acceptLabel,
                    cancelLabel: form?.cancelLabel,
                },
            };
        },
    };
    return {
        ...webContext,
        reddit,
        redis,
        settings,
        scheduler,
        ui,
        subredditName: webContext.subredditName,
        subredditId: webContext.subredditId,
        postId:
            webContext.postId ??
            requestData.postId ??
            (requestData.location === "post"
                ? requestData.targetId
                : undefined),
        commentId:
            webContext.commentId ??
            requestData.commentId ??
            (requestData.location === "comment"
                ? requestData.targetId
                : undefined),
        userId: webContext.userId,
        appSlug: webContext.appName ?? webContext.appSlug,
        appVersion: webContext.appVersion,
    };
}

export function toUiResponse(capture: UiCapture): Record<string, unknown> {
    const response: Record<string, unknown> = {};
    if (capture.showToast !== undefined) response.showToast = capture.showToast;
    if (capture.showForm !== undefined) response.showForm = capture.showForm;
    if (capture.navigateTo !== undefined)
        response.navigateTo = capture.navigateTo;
    return response;
}
