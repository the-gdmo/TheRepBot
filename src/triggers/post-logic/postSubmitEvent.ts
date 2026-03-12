import { PostSubmit } from "@devvit/protos";
import { TriggerContext } from "@devvit/public-api";
import { AppSetting, TemplateDefaults } from "../../settings.js";
import { logger } from "../../logger.js";
import {
    getAwardsRequiredKey,
    getLastValidPostKey,
    getLastValidPostTitleKey,
    getRestrictedKey,
    requiredKeyExists,
    restrictedKeyExists,
} from "./redisKeys.js";
import { isModerator } from "../utils/user-utilities.js";

export async function onPostSubmit(event: PostSubmit, context: TriggerContext) {
    if (!event.subreddit || !event.author || !event.post) {
        logger.warn("❌ Missing required event data", { event });
        return;
    }

    const settings = await context.settings.getAll();
    const awardsRequired =
        (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) ?? 0;

    if (awardsRequired === 0) {
        logger.info(`Awarding not required, returning.`);
        return;
    }

    const subredditName = event.subreddit.name;
    const authorName = event.author.name;
    const author = await context.reddit.getUserByUsername(authorName);

    if (!author) {
        logger.warn("❌ Could not fetch author object", { authorName });
        return;
    }

    // ─────────────────────────────────────────────────────────
    // Moderator exemption
    // ─────────────────────────────────────────────────────────
    const modsExempt =
        (settings[AppSetting.ModeratorsExempt] as boolean) ?? true;
    const isMod = await isModerator(context, subredditName, authorName);

    if (isMod && modsExempt) {
        logger.info(
            `✅ ${author.username} is a moderator and is exempt from restrictions`
        );
        return;
    }

    // ─────────────────────────────────────────────────────────
    // Redis keys & restriction flags
    // ─────────────────────────────────────────────────────────

    const restrictedUserKey = await getRestrictedKey(author);
    const awardsRequiredKey = await getAwardsRequiredKey(author);
    const lastValidPostKey = await getLastValidPostKey(author);
    const lastValidPostTitleKey = await getLastValidPostTitleKey(author);
    const restrictedFlagExists = await restrictedKeyExists(
        context,
        author.username
    );

    //check if user is restricted, if they are, remove post and send notification with AppSetting.SubsequentPostRestrictionMessage
    //and return
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const triggerWords = (
        (settings[AppSetting.PointTriggerWords] as string) ?? "!award\n.award"
    )
        .split(/\r?\n/)
        .map((w) => w.trim())
        .filter(Boolean);

    const commandList = triggerWords.join(", ");
    const helpPage = (settings[AppSetting.PointSystemHelpPage] as string) ?? "";
    const discordLink =
        (settings[AppSetting.DiscordServerLink] as string) ?? "";
    if (restrictedFlagExists) {
        const subsequentTemplate =
            (settings[AppSetting.SubsequentPostRestrictionMessage] as string) ??
            TemplateDefaults.SubsequentPostRestrictionMessage;

        const title = await context.redis.get(lastValidPostTitleKey);
        const lastValidPost = await context.redis.get(lastValidPostKey);
        const requirement =
            (settings[AppSetting.AwardsRequiredToCreateNewPosts] as number) ??
            0;

        let msg = subsequentTemplate
            .replace(/{{name}}/g, pointName)
            .replace(/{{commands}}/g, commandList)
            .replace(
                /{{markdown_guide}}/g,
                "https://www.reddit.com/wiki/markdown"
            )
            .replace(/{{requirement}}/g, requirement.toString())
            .replace(/{{subreddit}}/g, subredditName);

        if (title) msg = msg.replace(/{{title}}/g, title);
        if (lastValidPost) msg = msg.replace(/{{permalink}}/g, lastValidPost);
        if (helpPage) {
            msg = msg.replace(
                /{{helpPage}}/g,
                `https://www.reddit.com/r/${subredditName}/wiki/${helpPage}`
            );
        }
        if (discordLink) msg = msg.replace(/{{discord}}/g, discordLink);

        // Post restriction comment
        const subsequentPostRestrictionMessage = await context.reddit.submitComment({
            id: event.post.id,
            text: msg,
        });

        await subsequentPostRestrictionMessage.distinguish(true);
        await context.reddit.remove(event.post.id, false);

        logger.info("🚫 Removed post from restricted user", {
            username: author.username,
            postId: event.post.id,
        });
        return;
    }

    //user is not restricted send AppSetting.MessageToRestrictedUsers and allow initial post
    //also set rediskeys to supplement this

    const template =
        (settings[AppSetting.MessageToRestrictedUsers] as string) ??
        TemplateDefaults.MessageToRestrictedUsers;

    let text = template
        .replace(/{{name}}/g, pointName)
        .replace(/{{commands}}/g, commandList)
        .replace(/{{markdown_guide}}/g, "https://www.reddit.com/wiki/markdown")
        .replace(/{{subreddit}}/g, subredditName);

    if (helpPage) {
        text = text.replace(
            /{{helpPage}}/g,
            `https://www.reddit.com/r/${subredditName}/wiki/${helpPage}`
        );
    }
    if (discordLink) {
        text = text.replace(/{{discord}}/g, discordLink);
    }

    const initialPostRestrictionMessage = await context.reddit.submitComment({
        id: event.post.id,
        text,
    });

    await initialPostRestrictionMessage.distinguish(true);

    // Save the valid post info
    await context.redis.set(lastValidPostKey, event.post.permalink);
    await context.redis.set(lastValidPostTitleKey, event.post.title);

    logger.info("🧹 Restricted user after they made a new post", {
        author: author.username,
        restrictedFlagExists,
    });
    await context.redis.set(restrictedUserKey, "1");
    await context.redis.set(awardsRequiredKey, "0");
}
