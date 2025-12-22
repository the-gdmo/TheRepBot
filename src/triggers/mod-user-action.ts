import { TriggerContext } from "@devvit/public-api";
import { AppSetting } from "../settings.js";
import {
    commandUsedInIgnoredContext,
    getIgnoredContextType,
} from "../thanksPoints.js";
import { CommentSubmit, CommentUpdate } from "@devvit/protos";
import { logger } from "../logger.js";

export const triggerUsed = async (devvitContext: TriggerContext, comment: string) => {
    const allTriggers = await getTriggers(devvitContext);

    const triggerUsed = allTriggers.find((t) => comment.includes(t));

    if (!triggerUsed) {
        logger.debug("❌ No valid award command found.");
        return;
    }
    // typed (preserve case)
    const usedCommandRaw = triggerUsed[1];
    // normalized (lowercase) for logic checks
    const usedCommand = usedCommandRaw.toLowerCase();

    return usedCommand;
};

export const modCommandValue = async (devvitContext: TriggerContext) => {
    const settings = await devvitContext.settings.getAll();
    const modCommand = (
        (settings[AppSetting.ModAwardCommand] as string) ?? "!modaward"
    )
        .toLowerCase()
        .trim();
    return modCommand;
}; 

export const userCommandValues = async (devvitContext: TriggerContext) => {
    const settings = await devvitContext.settings.getAll();
    const userCommands = (
        (settings[AppSetting.PointTriggerWords] as string) ?? "!award\n.award"
    )
        .split("\n")
        .map((c) => c.trim())
        .filter(Boolean)
        .map((c) => c.toLowerCase());
    return userCommands;
};

export const commentContainsModCommand = async (
    devvitContext: TriggerContext,
    comment: string,
) => {
    const usedCommand = await triggerUsed(devvitContext, comment);
    const modCommand = await modCommandValue(devvitContext);
    if (usedCommand === modCommand) {
        return true;
    }
    return false;
};

function escapeForRegex(str: string) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const getTriggers = async (devvitContext: TriggerContext) => {
    const settings = await devvitContext.settings.getAll();
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
};

export const checkIgnoredContext = async (
    devvitContext: TriggerContext,
    event: CommentSubmit | CommentUpdate,
    comment: string
) => {
    // Check ignored contexts for each trigger in comment
    for (const trigger of await getTriggers(devvitContext)) {
        if (!new RegExp(`${escapeForRegex(trigger)}`, "i").test(comment))
            continue;

        if (!event.author) return;
        if (!event.comment) return;
        if (!event.subreddit) return;
        if (commandUsedInIgnoredContext(comment, trigger)) {
            const ignoredText = getIgnoredContextType(comment, trigger);
            if (ignoredText) {
                const ignoreKey = `ignoreDM:${event.author.name.toLowerCase()}:${ignoredText}`;
                const alreadyConfirmed = await devvitContext.redis.exists(ignoreKey);

                if (!alreadyConfirmed) {
                    const contextLabel =
                        ignoredText === "quote"
                            ? "a quote block (`> this`)"
                            : ignoredText === "alt"
                            ? "alt text (``this``)"
                            : "a spoiler block (`>!this!<`)";

                    const dmText = `Hey u/${event.author.name}, I noticed you used the command **${trigger}** inside ${contextLabel}.
                    
                    If this was intentional, edit [the comment that triggered this](${event.comment.permalink}) with **CONFIRM** (in all caps) and you will not receive this message again for ${ignoredText} text.
                    
                    ---
                    
                    ^(I am a bot - please contact the mods of ${event.subreddit.name} with any questions)
                    
                    ---`;

                    await devvitContext.reddit.sendPrivateMessage({
                        to: event.author.name,
                        subject: `Your ${trigger} command was ignored`,
                        text: dmText,
                    });

                    await devvitContext.redis.set(
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
};
