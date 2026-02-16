import { SettingsValues, TriggerContext } from "@devvit/public-api";
import { AppSetting, ExistingFlairOverwriteHandling } from "../../settings.js";
import { logger } from "../../logger.js";
import { CommentSubmit, CommentUpdate } from "@devvit/protos";

export function formatMessage(
    template: string,
    placeholders: Record<string, string>
): string {
    let result = template;
    for (const [key, value] of Object.entries(placeholders)) {
        const regex = new RegExp(`{{${key}}}`, "g");
        result = result.replace(regex, value);
    }

    const footer = `\n\n---\n\n^(I am a bot - please contact the mods with any questions)`;
    if (
        !result
            .trim()
            .endsWith(
                `\n\n---\n\n^(I am a bot - please contact the mods with any questions)`
            )
    ) {
        result = result.trim() + footer;
    }

    return result;
}

export async function triggerUsed(
    context: TriggerContext,
    commentBody: string
) {
    const allTriggers = await getTriggers(context);

    const triggerUsed = allTriggers.find((t) => commentBody.includes(t));

    if (!triggerUsed) {
        logger.debug("❌ No valid award command found.");
        return;
    }
    // typed (preserve case)
    const usedCommandRaw = triggerUsed[1];
    // normalized (lowercase) for logic checks
    const usedCommand = usedCommandRaw.toLowerCase();

    return usedCommand;
}

export async function modCommandValue(context: TriggerContext) {
    const settings = await context.settings.getAll();
    const modCommand = ((settings[AppSetting.ModAwardCommand] as string) ?? "")
        .toLowerCase()
        .trim();
    return modCommand;
}

export async function userCommandValues(context: TriggerContext) {
    const settings = await context.settings.getAll();
    const userCommands = (
        (settings[AppSetting.PointTriggerWords] as string) ?? "!award\n.award"
    )
        .split("\n")
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => c.toLowerCase());
    return userCommands;
}

export function escapeForRegex(string: string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function getTriggers(context: TriggerContext) {
    const settings = await context.settings.getAll();
    const userCommands = (
        (settings[AppSetting.PointTriggerWords] as string) ?? "!award\n.award"
    )
        .split(/\r?\n/)
        .map((w) => w.trim())
        .filter(Boolean);

    // Superuser/Mod award command
    const modCommand = (
        (settings[AppSetting.ModAwardCommand] as string) ?? "!modaward"
    )
        .toLowerCase()
        .trim();

    const allTriggers = Array.from(
        new Set([...userCommands, modCommand].filter((t) => t && t.length > 0))
    );
    return allTriggers;
}

export async function updateAwardeeFlair(
    context: TriggerContext,
    subredditName: string,
    commentAuthor: string,
    newScore: number,
    settings: SettingsValues
) {
    const pointSymbol = (settings[AppSetting.PointSymbol] as string) ?? "";
    const flairSetting = ((settings[AppSetting.ExistingFlairHandling] as
        | string[]
        | undefined) ?? [
        ExistingFlairOverwriteHandling.OverwriteNumeric,
    ])[0] as ExistingFlairOverwriteHandling;

    // Make sure newScore is a safe primitive
    const scoreValue =
        newScore !== undefined && newScore !== null ? Number(newScore) : 0;

    let flairText = "";
    switch (flairSetting) {
        case ExistingFlairOverwriteHandling.OverwriteNumericSymbol:
            flairText = `${scoreValue}${pointSymbol}`;
            break;
        case ExistingFlairOverwriteHandling.OverwriteNumeric:
        default:
            flairText = `${scoreValue}`;
            break;
    }

    // CSS class + template logic
    let cssClass = settings[AppSetting.CSSClass] as string | undefined;
    let flairTemplate = settings[AppSetting.FlairTemplate] as
        | string
        | undefined;

    // If using a flair template, CSS class cannot be used
    if (flairTemplate) cssClass = undefined;

    try {
        await context.reddit.setUserFlair({
            subredditName,
            username: commentAuthor,
            cssClass,
            flairTemplateId: flairTemplate,
            text: flairText,
        });

        logger.info(
            `🧑‍🎨 Awardee flair updated: u/${commentAuthor} → (“${flairText}”)`
        );
    } catch (err) {
        logger.error("❌ Failed to update awardee flair", {
            user: commentAuthor,
            err,
        });
    }
}

export function commandUsedInIgnoredContext(
    commentBody: string,
    command: string
): boolean {
    const quoteBlock = `> .*${command}.*`;
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
): "quote" | "alt" | "spoiler" | undefined {
    const quoteBlock = `> .*${command}.*`;
    const altText = `\`.*${command}.*\``;
    const spoilerText = `>!${command}.*!<`;

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
    context: TriggerContext,
    event: CommentSubmit | CommentUpdate,
    comment: string
) {
    // Check ignored contexts for each trigger in comment
    for (const trigger of await getTriggers(context)) {
        if (!new RegExp(`${escapeForRegex(trigger)}`, "i").test(comment))
            continue;

        if (!event.author) return;
        if (!event.comment) return;
        if (!event.subreddit) return;
        if (commandUsedInIgnoredContext(comment, trigger)) {
            const ignoredText = getIgnoredContextType(comment, trigger);
            if (ignoredText) {
                const ignoreKey = `ignoreDM:${event.author.name.toLowerCase()}:${ignoredText}`;
                const alreadyConfirmed = await context.redis.exists(ignoreKey);

                if (!alreadyConfirmed) {
                    const contextLabel =
                        ignoredText === "quote"
                            ? "a quote block (`> this`)"
                            : ignoredText === "alt"
                            ? "alt text (``this``)"
                            : ignoredText === "spoiler"
                            ? "a spoiler block (`>!this!<`)"
                            : undefined;

                    const dmText = `Hey u/${event.author.name}, I noticed you used the command **${trigger}** inside ${contextLabel}.
                    
                    If this was intentional, edit [the comment that triggered this](${event.comment.permalink}) with **CONFIRM** (in all caps) and you will not receive this message again for ${ignoredText} text.
                    
                    ---
                    
                    ^(I am a bot - please contact the mods of ${event.subreddit.name} with any questions)
                    
                    ---`;

                    await context.reddit.sendPrivateMessage({
                        to: event.author.name,
                        subject: `Your ${trigger} command was ignored`,
                        text: dmText,
                    });

                    await context.redis.set(
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
