import { reddit, redis, settings } from "@devvit/web/server";
import { logger } from "./logger";
import { OnCommentCreateRequest, OnCommentUpdateRequest, OnPostSubmitRequest } from "@devvit/web/shared";

export function formatMessageOnComment(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    template: string,
    placeholders: Record<string, string>
): string {
    if (!event.subreddit) return "";
    let result = template;
    for (const [key, value] of Object.entries(placeholders)) {
        const singleRegex = new RegExp(`{${key}}`, "gi");
        const doubleRegex = new RegExp(`{{${key}}}`, "gi");
        if (doubleRegex.test(result)) {
            logger.debug(`Replacing {{${key}}} with ${value}`);
            result = result.replaceAll(doubleRegex, value);
        } else if (singleRegex.test(result)) {
            logger.debug(`Replacing {${key}} with ${value}`);
            result = result.replaceAll(singleRegex, value);
        }
    }

    const footer = `\n\n---\n\n^(I am a bot — [contact the mods of r/${event.subreddit.name}](https://reddit.com/message/compose?to=r/${event.subreddit.name}) with any questions or [r/TheRepBot](https://www.reddit.com/message/compose?to=r/TheRepBot) to talk directly with my developer)`;
    if (!result.trim().endsWith(footer)) {
        result = result.trim() + footer;
    }

    return result;
}

export function formatMessageOnPost(
    event: OnPostSubmitRequest,
    template: string,
    placeholders: Record<string, string>
): string {
    if (!event.subreddit) return "";
    let result = template;
    for (const [key, value] of Object.entries(placeholders)) {
        const singleRegex = new RegExp(`{${key}}`, "gi");
        const doubleRegex = new RegExp(`{{${key}}}`, "gi");
        if (doubleRegex.test(result)) {
            logger.debug(`Replacing {{${key}}} with ${value}`);
            result = result.replaceAll(doubleRegex, value);
        } else if (singleRegex.test(result)) {
            logger.debug(`Replacing {${key}} with ${value}`);
            result = result.replaceAll(singleRegex, value);
        }
    }

    const footer = `\n\n---\n\n^(I am a bot — [contact the mods of r/${event.subreddit.name}](https://reddit.com/message/compose?to=r/${event.subreddit.name}) with any questions or [r/TheRepBot](https://www.reddit.com/message/compose?to=r/TheRepBot) to talk directly with my developer)`;
    if (!result.trim().endsWith(footer)) {
        result = result.trim() + footer;
    }

    return result;
}

export async function triggerUsed(
    commentBody: string
) {
    const allTriggers = await getTriggers();

    const triggerUsed = allTriggers.find((t) => commentBody.includes(t));

    if (!triggerUsed || !triggerUsed[1]) {
        logger.debug("❌ No valid award command found.");
        return;
    }
    // typed (preserve case)
    const usedCommandRaw = triggerUsed[1];
    // normalized (lowercase) for logic checks
    const usedCommand = usedCommandRaw.toLowerCase();

    return usedCommand;
}

export async function modCommandValue() {
    const settingModAwardCommand = await settings.get("modAwardCommand");
    const modCommand = ((settingModAwardCommand as string) ?? "")
        .toLowerCase()
        .trim();
    return modCommand;
}

export async function userCommandValues() {
    const settingPointTriggerWords = await settings.get("pointTriggerWords");
    const userCommands = (
        (settingPointTriggerWords as string) ?? "!award\n.award"
    )
        .split("\n")
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => c.toLowerCase());
    return userCommands;
}

export function escapeForRegex(string: string) {
    // String being replaced represents all symbols that
    // appear on the standard computer keyboard
    const regex =
        /[\`\~\!\@\#\$\%\^\&\*\(\)\_\+\-\=\{\}\[\]\:\"\;\'\<\>\?\,\.\/\|\\a-z0-9\s]+/gi;
    return string.replace(regex, (match) => `${match}`);
}

export async function getTriggers() {
    const settingModAwardCommand = await settings.get("modAwardCommand");
    const settingPointTriggerWords = await settings.get("pointTriggerWords");
    const userCommands = (
        (settingPointTriggerWords as string) ?? "!award\n.award"
    )
        .split(/\r?\n/)
        .map((w) => w.trim())
        .filter(Boolean);

    // Legend/Mod award command
    const modCommand = ((settingModAwardCommand as string) ?? "!modaward")
        .toLowerCase()
        .trim();

    const allTriggers = Array.from(
        new Set([...userCommands, modCommand].filter((t) => t && t.length > 0))
    );
    return allTriggers;
}

export interface ScoreResult {
    score: number;
    place?: number;
    userHasFlair: boolean;
    flairIsNumber: boolean;
    flairShouldBeManaged: boolean;
}

export function commandUsedInIgnoredContext(
    commentBody: string,
    command: string
): boolean {
    const quoteBlock = `>.*${command}.*`;
    const altText = `\`.*${command}.*\``;
    const spoilerText = `>!.*${command}.*!<`;

    const patterns = [
        // Quote block: > anything with command
        new RegExp(`${quoteBlock}`, "i"),

        // Alt text: [anything including command using `grave accent`]
        new RegExp(`${altText}`, "i"),

        // Spoiler block: >! anything with command !<
        new RegExp(`${spoilerText}`, "i"),
    ];

    return patterns.some((p) => p.test(commentBody));
}

export function getIgnoredContextType(
    commentBody: string,
    command: string
): "quote" | "alt" | "spoiler" | "code_block" | undefined {
    const quoteBlock = `> .*${command}.*`;
    const altText = `\`.*${command}.*\``;
    const spoilerText = `>!.*${command}.*!<`;

    const patterns: { type: "quote" | "alt" | "spoiler"; regex: RegExp }[] = [
        { type: "quote", regex: new RegExp(`${quoteBlock}`, "i") },
        { type: "alt", regex: new RegExp(`${altText}`, "i") },
        { type: "spoiler", regex: new RegExp(`${spoilerText}`, "i") },
    ];

    for (const { type, regex } of patterns) {
        if (regex.test(commentBody)) return type;
    }
    return undefined;
}

export async function checkIgnoredContext(
    event: OnCommentCreateRequest | OnCommentUpdateRequest,
    comment: string
) {
    // Check ignored contexts for each trigger in comment
    for (const trigger of await getTriggers()) {
        if (!new RegExp(`${trigger}`, "i").test(comment)) continue;

        if (!event.author) return;
        if (!event.comment) return;
        if (!event.subreddit) return;
        if (commandUsedInIgnoredContext(comment, trigger)) {
            const ignoredText = getIgnoredContextType(comment, trigger);
            if (ignoredText) {
                const ignoreKey = `ignoreDM:${event.author.name.toLowerCase()}:${ignoredText}`;
                const alreadyConfirmed = await redis.exists(ignoreKey);

                if (!alreadyConfirmed) {
                    const contextLabel =
                        ignoredText === "quote"
                            ? "a quote block (`> text`)"
                            : ignoredText === "alt"
                            ? "alt text (`text`)"
                            : ignoredText === "spoiler"
                            ? "a spoiler block (`>!text!<`)"
                            : ignoredText === "code_block"
                            ? "a code block (```text```)"
                            : undefined;

                    const dmText = `Hey u/${event.author.name}, I noticed you used the command **${trigger}** inside ${contextLabel}.

                    If this was intentional, edit [the comment that triggered this](${event.comment.permalink}) with **CONFIRM** (in all caps) and you will not receive this message again for ${ignoredText} text.

                    ---

                    ^(I am a bot — contact the mods of [r/${event.subreddit.name}](https://reddit.com/r/${event.subreddit.name}) with any questions or [r/TheRepBot](https://www.reddit.com/message/compose?to=r/TheRepBot) to talk directly with my developer)

                    ---`;

                    await reddit.sendPrivateMessage({
                        to: event.author.name,
                        subject: `Your ${trigger} command was ignored`,
                        text: dmText,
                    });

                    await redis.set(
                        `pendingConfirm:${event.author.name.toLowerCase()}`,
                        ignoredText
                    );

                    logger.info(
                        "⚠️ Ignored command in special context; DM sent.",
                        { user: event.author.name, trigger, ignoredText }
                    );
                } else {
                    logger.info(
                        "ℹ️ Ignored command in special context; user pre-confirmed no DMs.",
                        { user: event.author.name, trigger, ignoredText }
                    );
                }

                return; // stop here — do NOT award points
            }
        }
    }
}

/**
 * Reads a select setting. Devvit can hand these back as a one-item list or as
 * plain text, so every select setting should be read through here.
 */
export async function getSelectSetting(
    name: string,
    fallback: string
): Promise<string> {
    const value = await settings.get<string | string[]>(name);
    const selected = Array.isArray(value) ? value[0] : value;
    return selected || fallback;
}

export type NotifyMode = "none" | "replybypm" | "replybycomment";

export async function getNotifyMode(name: string): Promise<NotifyMode> {
    const mode = await getSelectSetting(name, "none");
    return mode === "replybypm" || mode === "replybycomment" ? mode : "none";
}

/**
 * Delivers a message using a moderator's chosen notify mode. A failed reply is
 * logged rather than thrown so it can't stop an award from being completed.
 */
export async function notifyUser(options: {
    mode: NotifyMode;
    to: string;
    subject: string;
    text: string;
    commentId: string;
}): Promise<void> {
    const { mode, to, subject, text, commentId } = options;

    try {
        if (mode === "replybypm") {
            await reddit.sendPrivateMessage({
                to,
                subject: subject.slice(0, 100),
                text,
            });
        } else if (mode === "replybycomment") {
            const reply = await reddit.submitComment({
                id: commentId as `t1_${string}`,
                text,
            });
            await reply.distinguish();
        }
    } catch (error) {
        logger.error("Could not send notification", {
            mode,
            to,
            commentId,
            error: String(error),
        });
    }
}

/**
 * Finds the command used in a comment. A command must stand on its own, so
 * "!modsnipe" isn't read as ".snipe", and a link like "site.snipe.com" or a
 * word like "!sniped" isn't read as a command at all.
 */
export function findCommandInBody(
    body: string,
    commands: string[]
): string | undefined {
    return [...commands]
        .sort((a, b) => b.length - a.length)
        .find((command) =>
            new RegExp(
                `(?:^|[\\s>\`(*_~!])${escapeForRegex(
                    command
                )}(?=$|[\\s.,!?;:)*_~\`<])`,
                "i"
            ).test(body)
        );
}