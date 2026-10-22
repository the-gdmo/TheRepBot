import { settings } from "@devvit/web/server";
import type { PostSubmit } from "@devvit/protos";
import type { TriggerContext } from "../../compat";
import { logger } from "../../logger";
import {
    getAwardsRequiredKey,
    getLastValidPostKey,
    getLastValidPostTitleKey,
    getRestrictedKey,
    restrictedKeyExists,
} from "../utils/redisKeys";
import { isModerator } from "../utils/user-utilities";
import { formatMessage } from "../utils/common-utilities";
import { recordDigestPost } from "../utils/digest-stats";

export async function onPostSubmit(event: PostSubmit, context: TriggerContext) {
    if (!event.subreddit || !event.author || !event.post) {
        logger.warn("❌ Missing required event data", { event });
        return;
    }

    // Count every post submission, including mod/exempt and later-removed posts.
    // Do this before any restriction or early-return logic.
    try {
        await recordDigestPost(context);
    } catch (error) {
        logger.error("Could not record post-creation digest statistic", {
            postId: event.post.id,
            error,
        });
    }

    const settingAwardsRequiredToCreateNewPosts = await settings.get(
        "awardsRequiredToCreateNewPosts"
    );
    const settingPointName = await settings.get("pointName");
    const settingPointTriggerWords = await settings.get("pointTriggerWords");
    const settingPointSystemHelpPage = await settings.get(
        "pointSystemHelpPage"
    );
    const settingDiscordServerLink = await settings.get("discordServerLink");
    const settingUnrestrictedPostingMessage = await settings.get(
        "UnrestrictedPostingMessage"
    );
    const settingModeratorsExempt = await settings.get("moderatorsExempt");
    const settingSubsequentPostRestrictionMessage = await settings.get(
        "subsequentPostRestrictionMessage"
    );
    const settingInitialMessageToRestrictedUsers = await settings.get(
        "messageToRestrictedUsers"
    );
    const awardsRequired =
        (settingAwardsRequiredToCreateNewPosts as number) ?? 0;

    const pointName = (settingPointName as string) ?? "point";
    const triggers = ((settingPointTriggerWords as string) ?? "!award\n.award")
        .split(/\r?\n/)
        .map((w) => w.trim())
        .filter(Boolean);

    let commandListWithAnd = "";
    let commandListWithOr = "";

    for (const [index, trigger] of triggers.entries()) {
        if (index === 0) {
            commandListWithAnd += `**${trigger}**`;
            commandListWithOr += `**${trigger}**`;
        } else if (triggers.length === 2) {
            commandListWithAnd += ` and **${trigger}**`;
            commandListWithOr += ` or **${trigger}**`;
        } else if (index === triggers.length - 1) {
            commandListWithAnd += `, and **${trigger}**`;
            commandListWithOr += `, or **${trigger}**`;
        } else {
            commandListWithAnd += `, **${trigger}**`;
            commandListWithOr += `, **${trigger}**`;
        }
    }

    const helpPage = (settingPointSystemHelpPage as string) ?? "";
    const discordLink = (settingDiscordServerLink as string) ?? "";

    if (awardsRequired === 0) {
        const unrestrictedPostingMessage = formatMessage(
            event,
            (settingUnrestrictedPostingMessage as string) ?? "",
            {
                name: pointName,
                commandsWithAnd: commandListWithAnd,
                commandsWithOr: commandListWithOr,
                markdownGuide: "https://www.reddit.com/wiki/markdown",
            }
        );

        const unrestrictedPostingComment = await context.reddit.submitComment({
            id: event.post.id,
            text: unrestrictedPostingMessage,
        });

        unrestrictedPostingComment.distinguish(true);

        logger.info(`Awarding not required, sending comment and returning.`);
        return;
    }

    const subredditName = event.subreddit.name;
    const authorName = event.author.name;
    const author = await context.reddit.getUserByUsername(authorName);

    if (!author) {
        logger.warn("❌ Could not fetch author object", { authorName });
        return;
    }

    if (author.username === (await context.reddit.getAppUser()).username) {
        logger.info("🤖 Post submitted by RepBot, skipping post restriction");
        return;
    }

    // ─────────────────────────────────────────────────────────
    // Moderator exemption
    // ─────────────────────────────────────────────────────────
    const modsExempt = (settingModeratorsExempt as boolean) ?? true;
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
    if (restrictedFlagExists) {
        const subsequentTemplate =
            (settingSubsequentPostRestrictionMessage as string) ?? "";

        const title = await context.redis.get(lastValidPostTitleKey);
        const lastValidPost = await context.redis.get(lastValidPostKey);
        const requirement =
            (settingAwardsRequiredToCreateNewPosts as number) ?? 0;

        const subsequentRestrictionMsg = formatMessage(
            event,
            subsequentTemplate,
            {
                discord: discordLink,
                helpPage: helpPage,
                title: title ?? "",
                permalink: lastValidPost ?? "",
                requirement: requirement.toString(),
                subreddit: subredditName,
                name: pointName,
                commandsWithOr: commandListWithOr,
                commandsWithAnd: commandListWithAnd,
            }
        );
        // Post restriction comment
        const subsequentPostRestrictionMsg = await context.reddit.submitComment(
            {
                id: event.post.id,
                text: subsequentRestrictionMsg,
            }
        );

        await subsequentPostRestrictionMsg.distinguish(true);
        await context.reddit.remove(event.post.id, false);

        logger.info("🚫 Removed post from restricted user", {
            username: author.username,
            postId: event.post.id,
        });
        return;
    }

    //user is not restricted send AppSetting.InitialMessageToRestrictedUsers and allow initial post
    //also set rediskeys to supplement this

    const requirement = (settingAwardsRequiredToCreateNewPosts as number) ?? 0;
    const initialMessageToRestrictedUsers =
        (settingInitialMessageToRestrictedUsers as string) ?? "";

    const formattedText = formatMessage(
        event,
        initialMessageToRestrictedUsers,
        {
            discordLink,
            helpPage,
            requirement: requirement.toString(),
            subreddit: subredditName,
            name: pointName,
            commandsWithOr: commandListWithOr,
            commandsWithAnd: commandListWithAnd,
            markdownGuide: "https://www.reddit.com/wiki/markdown",
        }
    );
    const initialPostRestrictionMessage = await context.reddit.submitComment({
        id: event.post.id,
        text: formattedText,
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
