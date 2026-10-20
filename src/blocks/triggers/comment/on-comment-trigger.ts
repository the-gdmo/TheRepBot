import { CommentSubmit, CommentUpdate } from "@devvit/protos";
import {
    TriggerContext,
    Comment,
    SettingsValues,
    User,
} from "@devvit/public-api";
import {
    _replyToUser,
    CommentTriggerContext,
    getParentComment,
} from "./comment-trigger-context";
import { logger } from "../../logger";
import {
    commentContainsUserCommand,
    executeUserCommand,
} from "./user-specific-logic/normal-user-action";
import {
    commentContainsModCommand,
    executeModCommand,
} from "./user-specific-logic/mod-user-action";
import {
    AccessControlOptions,
    AppSetting,
    ExistingFlairOverwriteHandling,
    NotifyOnDisallowedFlairReplyOptions,
    NotifyOnModAwardFailReplyOptions,
    NotifyOnPostAuthorAwardReplyOptions,
    NotifyOnSelfAwardReplyOptions,
    NotifyOnUnflairedPostReplyOptions,
    TemplateDefaults,
} from "../../settings";
import {
    formatMessage,
    getIgnoredContextType,
    getTriggers,
    modCommandValue,
    ScoreResult,
} from "../utils/common-utilities";
import { setCleanupForUsers } from "../../cleanupTasks";
import { getCurrentScore } from "../utils/user-utilities";
import { POINTS_STORE_KEY } from "../utils/redisKeys";
import { UPDATE_LEADERBOARD_JOB } from "../../constants";
import { getSubredditName, SafeWikiClient } from "../../utility";
import {
    capitalize,
    discoverLatestPage,
    escapeMarkdownText,
    getNumberedUserWikiPath,
    getStoredLatestPage,
} from "../../leaderboard";
import pluralize from "pluralize";

export function getAwardsGivenFromWiki(
    wikiContent: string,
    capPlural: string
): string | undefined {
    const givenHeading = `## ${capPlural} Given`;
    const givenSectionStart = wikiContent.indexOf(givenHeading);

    if (givenSectionStart === -1) {
        return undefined;
    }

    // Only inspect the Given section, not Received.
    const givenSection = wikiContent.slice(givenSectionStart);
    const nextSectionStart = givenSection.indexOf("\n## ", givenHeading.length);

    const section =
        nextSectionStart === -1
            ? givenSection
            : givenSection.slice(0, nextSectionStart);

    const match = section.match(/has given a total of\s+([\d,]+)/i);

    if (!match) {
        logger.warn(
            "Could not find awards given in wiki content, returning undefined"
        );
        return undefined;
    }

    return match[1]?.toString().replaceAll(",", "");
}

async function setFlairForUser(
    context: TriggerContext,
    awarder: string,
    awardee: string,
    appSettings: SettingsValues
): Promise<void> {
    if (!context.subredditName) {
        logger.error("Cannot set user flair: subreddit name is missing");
        return;
    }

    const settings = await context.settings.getAll();
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const subredditName = await getSubredditName(context);
    const safeWiki = new SafeWikiClient(context.reddit);

    const baseCssClass =
        (appSettings[AppSetting.BaseCSSClass] as string | undefined) ||
        undefined;

    const baseFlairTemplate =
        (appSettings[AppSetting.BaseFlairTemplate] as string | undefined) ||
        undefined;

    const superAwarderCSSClass =
        (appSettings[AppSetting.SuperAwarderCSSClass] as string | undefined) ||
        undefined;

    // Use the base template until a dedicated Super Awarder template setting exists.
    const superAwarderFlairTemplate = baseFlairTemplate;

    const flairFormatting =
        (appSettings[AppSetting.FlairFormatting] as string | undefined) ??
        TemplateDefaults.FlairFormatting;

    const pointSymbol =
        (appSettings[AppSetting.PointSymbol] as string | undefined) ?? "";

    const superAwarderThreshold =
        (appSettings[AppSetting.SuperAwarderThreshold] as number) ?? 0;

    const superAwarderFlairText =
        (appSettings[AppSetting.SuperAwarderFlairText] as string) ??
        TemplateDefaults.SuperAwarderFlairText;

    const capPlural = escapeMarkdownText(capitalize(pluralize(pointName)));

    // Initialize the cached awards-given count from the latest wiki page
    // if it doesn't exist yet.
    const getOrInitializeAwardsGiven = async (
        username: string
    ): Promise<number> => {
        const redisKey = `awardsGiven:${username}`;
        const cached = await context.redis.get(redisKey);

        if (cached && cached !== null && cached !== "") {
            const parsed = Number.parseInt(cached, 10);
            return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
        }

        let count = 0;
        const latestPage = await getStoredLatestPage(context, username);

        if (!latestPage) {
            logger.warn("Couldn't find latest stored wiki page for user", {
                username,
            });
        } else {
            const wikiPage = await safeWiki.getWikiPage(
                subredditName,
                getNumberedUserWikiPath(username, latestPage)
            );

            if (!wikiPage) {
                logger.warn("User wiki page not found", {
                    username,
                    latestPage,
                });
            } else {
                const parsed = getAwardsGivenFromWiki(
                    wikiPage.content,
                    capPlural
                );

                const value = Number.parseInt(parsed ?? "0", 10);
                count = Number.isFinite(value) && value >= 0 ? value : 0;
            }
        }

        await context.redis.set(redisKey, count.toString());
        return count;
    };

    // The awarder gets credit for this award:
    // - If their cache already exists, increment it.
    // - Otherwise initialize it from their wiki without incrementing it.
    const awarderAwardsGivenKey = `awardsGiven:${awarder}`;
    const cachedAwarderCount = await context.redis.get(awarderAwardsGivenKey);

    if (cachedAwarderCount && cachedAwarderCount !== null && cachedAwarderCount !== "") {
        const parsed = Number.parseInt(cachedAwarderCount, 10);
        const currentCount =
            Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;

        await context.redis.set(
            awarderAwardsGivenKey,
            (currentCount + 1).toString()
        );
    } else {
        await getOrInitializeAwardsGiven(awarder);
    }

    // Get the received-points leaderboard once for both users.
    const leaderboard = await context.redis.zRange(POINTS_STORE_KEY, 0, -1, {
        by: "rank",
        reverse: true,
    });

    // If both names are the same, only update that user once.
    const usernames = [...new Set([awarder, awardee])];

    for (const username of usernames) {
        try {
            // Respect each user's own flair opt-out.
            const flairDisabled = await context.redis.exists(
                `flairToggle:${username}`
            );

            if (flairDisabled) {
                logger.info("Skipping flair update because user opted out", {
                    username,
                });
                continue;
            }

            // Received-points total and leaderboard position.
            const score =
                (await context.redis.zScore(POINTS_STORE_KEY, username)) ?? 0;

            const index = leaderboard.findIndex(
                (member) => member.member === username
            );

            const userRank = index >= 0 ? index + 1 : undefined;
            const placeText = userRank?.toString() ?? "N/A";

            // Determine Super Awarder status independently for each user.
            // This means receiving points won't remove their title.
            const awardsGiven = await getOrInitializeAwardsGiven(username);

            const isSuperAwarder =
                superAwarderThreshold > 0 &&
                awardsGiven >= superAwarderThreshold;

            let flairText = isSuperAwarder
                ? superAwarderFlairText
                : flairFormatting;

            let cssClass = isSuperAwarder
                ? superAwarderCSSClass ?? baseCssClass
                : baseCssClass;

            const flairTemplate = isSuperAwarder
                ? superAwarderFlairTemplate
                : baseFlairTemplate;

            // Replace both supported placeholder styles.
            const replacements: Record<string, string> = {
                "{{place}}": placeText,
                "{place}": placeText,
                "{{total}}": score.toString(),
                "{total}": score.toString(),
                "{{symbol}}": pointSymbol,
                "{symbol}": pointSymbol,
            };

            for (const [placeholder, value] of Object.entries(replacements)) {
                flairText = flairText.replaceAll(placeholder, value);
            }

            // A flair template ID takes precedence over the CSS class.
            if (flairTemplate) {
                cssClass = undefined;
            }

            await context.reddit.setUserFlair({
                subredditName: context.subredditName,
                username,
                cssClass,
                flairTemplateId: flairTemplate,
                text: flairText,
            });

            logger.info("Updated user flair", {
                username,
                isSuperAwarder,
                awardsGiven,
                score,
                userRank,
            });
        } catch (err) {
            logger.error(
                "Unable to update user flair",
                {
                    username,
                    error: err instanceof Error ? err.message : String(err),
                },
                context
            );
        }
    }
}

export async function setUserScore(
    context: TriggerContext,
    awardee: string,
    awarder: string,
    newScore: ScoreResult
): Promise<void> {
    /**
     * POINTS_STORE_KEY is the single source of truth.
     *
     * member = username
     * score  = user's point total
     */
    const settings = await context.settings.getAll();

    await context.redis.zAdd(POINTS_STORE_KEY, {
        member: awardee,
        score: newScore.score,
    });

    logger.debug("Saved user score", {
        awardee,
        score: newScore.score,
    });

    // Queue cleanup checks for both users.
    await setCleanupForUsers([awardee, awarder], context);

    // Queue a leaderboard update.

    if (!(await context.redis.get(`awardsGiven:${awarder}`))) {
        const safeWiki = new SafeWikiClient(context.reddit);
        const subredditName = await getSubredditName(context);
        const latestPage = await discoverLatestPage(
            context,
            subredditName,
            awarder,
            safeWiki
        );
        const pointName = (settings[AppSetting.PointName] as string) ?? "point";
        const capPlural = escapeMarkdownText(capitalize(pluralize(pointName)));

        for (let pageNumber = 1; pageNumber <= latestPage; pageNumber += 1) {
            const awarderWiki = await safeWiki.getWikiPage(
                subredditName,
                getNumberedUserWikiPath(awarder, pageNumber)
            );

            if (!awarderWiki) {
                logger.error("Couldn't retrieve awarder wiki, skipping page", {
                    awarder,
                    pageNumber,
                });
                continue;
            }

            const awardsGiven = getAwardsGivenFromWiki(
                awarderWiki.content,
                capPlural
            );

            if (awardsGiven !== undefined) {
                await context.redis.set(`awardsGiven:${awarder}`, awardsGiven);
            } else {
                await context.redis.set(`awardsGiven:${awarder}`, "1");
            }
        }
    }

    const awarderScore =
        (await context.redis.get(`awardsGiven:${awarder}`)) ?? "0";

    await context.scheduler.runJob({
        name: UPDATE_LEADERBOARD_JOB,
        runAt: new Date(),
        data: {
            reason: `Updated score for ${awardee} and ${awarder}. Awardee Score: ${newScore.score}. Awarder Score: ${awarderScore}.`,
        },
    });

    // Respect the configured existing-flair overwrite behavior.
    const existingFlairOverwriteHandling =
        (settings[AppSetting.ExistingFlairHandling] as
            | ExistingFlairOverwriteHandling
            | undefined) ?? ExistingFlairOverwriteHandling.OverwriteNumeric;

    let shouldSetUserFlair: boolean;

    if (
        existingFlairOverwriteHandling ===
            ExistingFlairOverwriteHandling.OverwriteNumericSymbol ||
        existingFlairOverwriteHandling ===
            ExistingFlairOverwriteHandling.OverwriteNumeric
    ) {
        shouldSetUserFlair = true;
    } else if (
        existingFlairOverwriteHandling ===
        ExistingFlairOverwriteHandling.NeverSet
    ) {
        shouldSetUserFlair = false;
    } else {
        shouldSetUserFlair =
            !newScore.userHasFlair ||
            newScore.flairIsNumber ||
            newScore.flairShouldBeManaged;
    }

    if (!shouldSetUserFlair) {
        logger.debug(
            "Flair not set because existing flair should be preserved",
            {
                awardee,
                awarder,
                existingFlairOverwriteHandling,
            }
        );
        return;
    }

    if (!context.subredditName) {
        logger.error(
            "❌ No subreddit name found in context, cannot set user flair"
        );
        return;
    }

    // Set the recipient's flair using their updated score.
    await setFlairForUser(context, awarder, awardee, settings);
}

export async function handleThanksEvent(
    event: CommentSubmit | CommentUpdate,
    devvitContext: TriggerContext
) {
    if (!event.post || !event.author || !event.comment) {
        logger.warn("❌ Missing required event data", { event });
        return;
    }

    // ─────────────────────────────────────────────
    // Initialize context
    // ─────────────────────────────────────────────
    const commentTriggerContext = new CommentTriggerContext();
    await commentTriggerContext.init(event, devvitContext);

    const parentComment: Comment | undefined = await getParentComment(
        event,
        devvitContext
    );
    if (!parentComment) {
        logger.warn("❌ Parent comment not found", {
            commentId: event.comment.id,
        });
        return;
    }

    const settings = await devvitContext.settings.getAll();
    const awarder = event.author.name;
    const commentBody = event.comment.body.toLowerCase();
    const triggers = await getTriggers(devvitContext);
    const triggerUsed = triggers.find((t) => commentBody.includes(t));
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    if (!triggerUsed) {
        logger.debug("❌ No valid award command found.");
        return;
    }

    const ignoredType = getIgnoredContextType(event.comment.body, triggerUsed);

    const IgnoredContextNeedsHandling = await ignoredContextNeedsHandling(
        event,
        devvitContext,
        triggerUsed
    );
    if (ignoredType) {
        logger.info(`ignoredType exists in comment`, { ignoredType });
        if (IgnoredContextNeedsHandling) {
            logger.info(`Running handleIgnoredContext()`, {
                IgnoredContextNeedsHandling,
            });
            await handleIgnoredContext(event, devvitContext, triggerUsed);
            return;
        } else {
            logger.info(`Ignored context doesn't need handling`);
            return;
        }
    }

    const awardee = parentComment.authorName;
    if (!awardee) {
        logger.warn("❌ No recipient found", { parentComment });
        return;
    }

    let recipient: User | undefined;

    try {
        recipient = await devvitContext.reddit.getUserByUsername(awardee);
    } catch {
        recipient = undefined;
    }
    if (!recipient) {
        logger.warn("❌ Could not fetch user object for recipient", {
            recipient: awardee,
        });
        return;
    }

    const existingScore = await getCurrentScore(recipient, devvitContext);
    if (!existingScore) {
        logger.warn("❌ Could not fetch existing score for recipient", {
            recipient: awardee,
        });
        return;
    }

    const isMod = commentTriggerContext.isMod;
    const isSuperUser = commentTriggerContext.isSuperUser;
    const userCanAward = commentTriggerContext.userCanAward;

    // ─────────────────────────────────────────────
    // Access control enforcement
    // ─────────────────────────────────────────────
    let user: User | undefined;

    try {
        user = await devvitContext.reddit.getUserByUsername(awarder);
    } catch {
        user = undefined;
    }
    if (!user) {
        logger.warn("❌ Could not fetch user object for awarder", { awarder });
        return;
    }

    const hasPermission = await userHasPermission(
        event,
        user.id,
        commentTriggerContext,
        devvitContext,
        settings
    );

    if (!hasPermission) {
        logger.debug("❌ User does not have permission", {
            awarder,
            commentId: event.comment.id,
        });

        return;
    }

    // ─────────────────────────────────────────────
    // Detect which command type exists
    // ─────────────────────────────────────────────

    const containsMod = await commentContainsModCommand(event, devvitContext);
    const containsUser = await commentContainsUserCommand(event, devvitContext);

    logger.debug("Checking values", {
        trigger: triggerUsed,
        containsMod,
        containsUser,
    });

    await unflairedPostLogic(event, devvitContext, awarder, settings);

    await flairTextNotAllowedLogic(
        event,
        devvitContext,
        awarder,
        commentBody,
        triggerUsed,
        settings
    );

    await selfAwardAttemptLogic(
        event,
        devvitContext,
        awarder,
        awardee,
        settings
    );

    await recipientIsBot(event, devvitContext, awarder, awardee, settings);

    // ─────────────────────────────────────────────
    // Normal user command logic
    // ─────────────────────────────────────────────

    if (containsUser && !containsMod) {
        if (!userCanAward) {
            logger.debug("❌ User blocked from awarding points", { awarder });
            return;
        }
        const handled = await executeUserCommand(event, devvitContext);
        // Trigger leaderboard update
        if (handled) {
            await devvitContext.scheduler.runJob({
                name: UPDATE_LEADERBOARD_JOB,
                runAt: new Date(),
                data: {
                    reason: `Updated score for ${user.username}. Triggered by user command.`,
                },
            });
            logger.info("✅ User command executed successfully");
            return;
        } else {
            logger.debug("❌ User command detected but not handled");
        }
        return;
    }

    // ─────────────────────────────────────────────
    // Mod command logic
    // ─────────────────────────────────────────────
    if (containsMod && !containsUser) {
        if (isMod || isSuperUser) {
            //recipient is OP
            let originalPoster: User | undefined;
            try {
                originalPoster = await devvitContext.reddit.getUserById(
                    event.post.authorId
                );
            } catch (err) {
                logger.error(
                    `Original poster could not be found in executeUserCommand(), returning`
                );
                return;
            }

            if (!originalPoster) return;

            if (recipient.username === originalPoster.username) {
                const notifyMode = (
                    settings[AppSetting.NotifyOnPostAuthorAward] as string[]
                )?.[0];
                const formattedPostAuthorAwardMessage = formatMessage(
                    event,
                    (settings[AppSetting.PostAuthorAwardMessage] ??
                        TemplateDefaults.PostAuthorAwardMessage) as string,
                    { name: pointName }
                );

                if (
                    notifyMode ===
                    NotifyOnPostAuthorAwardReplyOptions.ReplyAsComment
                ) {
                    const postAuthorAwardComment =
                        await devvitContext.reddit.submitComment({
                            id: event.comment.id,
                            text: formattedPostAuthorAwardMessage,
                        });
                    postAuthorAwardComment.distinguish();
                } else if (
                    notifyMode === NotifyOnPostAuthorAwardReplyOptions.ReplyByPM
                ) {
                    await devvitContext.reddit.sendPrivateMessage({
                        to: awarder,
                        subject: `You do not have permission to award ${pointName}s to Post Authors`,
                        text: formattedPostAuthorAwardMessage,
                    });
                }
                return;
            }

            const handled = await executeModCommand(event, devvitContext);
            // Trigger leaderboard update
            if (handled) {
                await devvitContext.scheduler.runJob({
                    name: UPDATE_LEADERBOARD_JOB,
                    runAt: new Date(),
                    data: {
                        reason: `Updated score for ${user.username}. Triggered by mod command.`,
                    },
                });
                logger.info("✅ Mod command executed successfully");
                return;
            }
        } else {
            const command = await modCommandValue(devvitContext);
            //send message saying no perms
            // ModAwardCommandFailMessage
            const modAwardFailMsg = formatMessage(
                event,
                (settings[AppSetting.ModAwardCommandFail] as string) ??
                    TemplateDefaults.ModAwardCommandFailMessage,
                {
                    awarder,
                    awardee,
                    command,
                }
            );

            const notify = ((settings[
                AppSetting.NotifyOnModAwardFail
            ] as string[]) ?? ["none"])[0];

            if (notify === NotifyOnModAwardFailReplyOptions.ReplyByPM) {
                await devvitContext.reddit.sendPrivateMessage({
                    to: awarder,
                    text: modAwardFailMsg,
                    subject: "Unsuccessful Award",
                });
            } else if (
                notify === NotifyOnModAwardFailReplyOptions.ReplyAsComment
            ) {
                const modAwardFailComment =
                    await devvitContext.reddit.submitComment({
                        id: event.comment.id,
                        text: modAwardFailMsg,
                    });

                await modAwardFailComment.distinguish();
            }
        }
    }

    // ─────────────────────────────────────────────
    // Fallback unexpected flow
    // ─────────────────────────────────────────────
    logger.error("Unexpected command flow detected", {
        containsMod,
        containsUser,
        awarder,
        commentId: event.comment.id,
    });
}

export async function unflairedPostLogic(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
    awarder: string,
    settings: SettingsValues
) {
    if (!event.post || !event.comment || !event.author || !event.subreddit)
        return;

    const allowUnflairedPosts =
        (settings[AppSetting.AllowUnflairedPosts] as boolean) ?? true;

    const unflairedMessage =
        (settings[AppSetting.UnflairedPostMessage] as string) ??
        TemplateDefaults.UnflairedPostMessage;

    const notifyUnflaired = ((settings[
        AppSetting.NotifyOnUnflairedPost
    ] as string[]) ?? [NotifyOnUnflairedPostReplyOptions.NoReply])[0];

    if (!event.post.linkFlair) {
        logger.error(`linkFlair doesn't exist`, {
            linkFlair: event.post.linkFlair,
        });
        return;
    }

    const postFlairText = event.post.linkFlair?.text?.trim();

    // 🚫 Unflaired posts not allowed
    if (!allowUnflairedPosts && postFlairText === "") {
        // 🚫 Ignore bot’s own comments to prevent loops
        if (event.author.name === context.appSlug) {
            logger.debug(
                "🤖 Bot-authored comment detected; skipping unflaired-post response"
            );
            return;
        }

        // 🔑 One response per award attempt (per comment)
        const responseKey = `unflairedResponse:${event.comment.id}`;

        if (await context.redis.exists(responseKey)) {
            logger.debug("ℹ️ Unflaired post response already sent — skipping", {
                commentId: event.comment.id,
            });
            return;
        }

        logger.info("🚫 Award blocked — post is unflaired", {
            awarder,
            postId: event.post.id,
            commentId: event.comment.id,
            notifyUnflaired,
        });

        try {
            if (
                notifyUnflaired === NotifyOnUnflairedPostReplyOptions.ReplyByPM
            ) {
                await context.reddit.sendPrivateMessage({
                    to: awarder,
                    subject: `Awards disabled for unflaired posts`,
                    text: unflairedMessage,
                });
            } else if (
                notifyUnflaired ===
                NotifyOnUnflairedPostReplyOptions.ReplyAsComment
            ) {
                const unflairedPostMessage = await context.reddit.submitComment(
                    {
                        id: event.comment.id,
                        text: unflairedMessage,
                    }
                );
                await unflairedPostMessage.distinguish();
            }
        } catch (err) {
            logger.error(
                "❌ Failed to notify user about unflaired post restriction",
                { awarder, commentId: event.comment.id, err }
            );
        }

        await context.redis.set(responseKey, "1");
        return; // ⛔ Stop award flow ONLY for unflaired posts
    }
}

export async function flairTextNotAllowedLogic(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
    awarder: string,
    commentBody: string,
    triggerUsed: string,
    settings: SettingsValues
) {
    if (!event.post || !event.comment || !event.author) return;
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const flairTextDisallowedMessage = formatMessage(
        event,
        (settings[AppSetting.DisallowedFlairMessage] as string) ??
            TemplateDefaults.DisallowedFlairMessage,
        { name: pointName }
    );
    const postFlairText = event.post.linkFlair?.text?.trim();

    const notifyFlairIgnored = ((settings[
        AppSetting.NotifyOnDisallowedFlair
    ] as string[]) ?? [NotifyOnDisallowedFlairReplyOptions.NoReply])[0];

    // ─────────────────────────────────────────────
    // Disallowed flair guard (non-terminating)
    // ─────────────────────────────────────────────

    if (
        (settings[AppSetting.DisallowedFlairs] as string).includes(
            postFlairText ?? ""
        )
    ) {
        logger.error(
            `User attempted to award points on flair-disallowed post, but it's not allowed`,
            { linkFlair: event.post.linkFlair }
        );
        return;
    }

    if (!postFlairText) return;

    const rawDisallowedFlairs =
        (settings[AppSetting.DisallowedFlairs] as string | undefined) ?? "";

    const disallowedFlairs = rawDisallowedFlairs
        .split(/\r?\n/) // newline-only entries
        .map((flair) => flair.trim())
        .filter(Boolean);

    if (
        disallowedFlairs.length !== 0 &&
        disallowedFlairs.includes(postFlairText)
    ) {
        logger.debug("🔍 Disallowed flair check", {
            postFlair: postFlairText,
            disallowedFlairs,
        });

        if (!triggerUsed || !commentBody.includes(triggerUsed)) {
            logger.info(`Comment in disallowed flair, but not a command`);
            return;
        }

        if (event.author.name === context.appSlug) {
            // 🚫 Ignore bot’s own comments to prevent loops
            logger.debug(
                "🤖 Bot-authored comment detected; skipping disallowed flair response"
            );
            return;
        }

        const responseKey = `disallowedFlairResponse:${event.comment.id}`;

        if (await context.redis.exists(responseKey)) {
            logger.debug(
                "♻️ Disallowed flair already handled for this comment",
                {
                    commentId: event.comment.id,
                }
            );
            return;
        }

        // Mark handled BEFORE replying
        await context.redis.set(responseKey, "1");

        logger.info("🚫 Award blocked due to disallowed flair", {
            postFlair: postFlairText,
        });

        if (
            notifyFlairIgnored === NotifyOnDisallowedFlairReplyOptions.ReplyByPM
        ) {
            await context.reddit.sendPrivateMessage({
                to: awarder,
                subject: `${pointName}s cannot be awarded on ${event.post.title}`,
                text: flairTextDisallowedMessage,
            });
        } else if (
            notifyFlairIgnored ===
            NotifyOnDisallowedFlairReplyOptions.ReplyAsComment
        ) {
            const disallowedFlairMessage = await context.reddit.submitComment({
                id: event.comment.id,
                text: flairTextDisallowedMessage,
            });
            await disallowedFlairMessage.distinguish();
        }
        return; // ⛔ block award
    }
}

export async function selfAwardAttemptLogic(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
    awarder: string,
    recipient: string,
    settings: SettingsValues
) {
    if (!event.comment || !event.author) return;
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    const selfMsgTemplate =
        (settings[AppSetting.SelfAwardMessage] as string) ??
        TemplateDefaults.SelfAwardTemplate;
    const notifySelf = ((settings[
        AppSetting.NotifyOnSelfAward
    ] as string[]) ?? [NotifyOnSelfAwardReplyOptions.NoReply])[0];
    if (awarder === recipient) {
        const selfText = formatMessage(event, selfMsgTemplate, {
            awarder,
            name: pointName,
        });
        if (notifySelf === NotifyOnSelfAwardReplyOptions.ReplyAsComment) {
            const selfAwardMessage = await context.reddit.submitComment({
                id: event.comment.id,
                text: selfText,
            });
            await selfAwardMessage.distinguish();
        } else if (notifySelf === NotifyOnSelfAwardReplyOptions.ReplyByPM) {
            await context.reddit.sendPrivateMessage({
                to: awarder,
                subject: `You tried to award yourself a ${pointName}`,
                text: selfText,
            });
        }
        logger.debug("❌ User tried to award themselves.");
        return;
    }
}
export async function replyToUser(
    context: TriggerContext,
    notifyMode: string,
    recipient: string,
    message: string,
    commentId: string
) {
    if (!notifyMode || notifyMode === "none") {
        logger.debug("ℹ️ replyToUser: notifyMode is none — skipping reply");
        return;
    }

    // 🚫 Prevent bot loops
    if (
        recipient.toLowerCase() === context.appSlug.toLowerCase() ||
        recipient.toLowerCase() === "automoderator"
    ) {
        logger.debug("🤖 replyToUser: recipient is bot/system — skipping");
        return;
    }

    // 🔑 One reply per comment + notify type
    const responseKey = `replyToUser:${notifyMode}:${commentId}`;
    if (await context.redis.exists(responseKey)) {
        logger.debug("♻️ replyToUser: response already sent", {
            commentId,
            notifyMode,
        });
        return;
    }

    try {
        if (notifyMode === "replybypm") {
            await context.reddit.sendPrivateMessage({
                to: recipient,
                subject: "Award not allowed",
                text: message,
            });

            logger.info("📬 replyToUser: sent PM", {
                recipient,
                commentId,
            });
        } else if (notifyMode === "replybycomment") {
            const reply = await context.reddit.submitComment({
                id: commentId,
                text: message,
            });
            await reply.distinguish();

            logger.info("💬 replyToUser: posted comment reply", {
                commentId,
            });
        } else {
            logger.warn("⚠️ replyToUser: unknown notifyMode", {
                notifyMode,
            });
            return;
        }

        // ✅ Mark handled AFTER success
        await context.redis.set(responseKey, "1");
    } catch (err) {
        logger.error("❌ replyToUser failed", {
            recipient,
            commentId,
            notifyMode,
            err,
        });
    }
}

export async function userHasPermission(
    event: CommentSubmit | CommentUpdate,
    awarderID: string,
    commentTriggerContext: CommentTriggerContext,
    devvitContext: TriggerContext,
    settings: SettingsValues
): Promise<boolean> {
    if (!event.post || !event.comment) return false;

    const pointName = (settings[AppSetting.PointName] as string) ?? "point";

    const isMod = commentTriggerContext.isMod;
    const isSuperUser = commentTriggerContext.isSuperUser;
    const isOP = awarderID === event.post.authorId;

    const accessControl = ((settings[AppSetting.AccessControl] as string[]) ?? [
        "everyone",
    ])[0];

    const hasPermission =
        accessControl === AccessControlOptions.Everyone ||
        (accessControl === AccessControlOptions.ModsOnly && isMod) ||
        (accessControl === AccessControlOptions.ModsAndSuperusers &&
            (isMod || isSuperUser)) ||
        (accessControl === AccessControlOptions.ModsSuperusersAndPostAuthor &&
            (isMod || isSuperUser || isOP)) ||
        (accessControl === AccessControlOptions.ModsAndPostAuthor &&
            (isMod || isOP));

    logger.debug("Permission check", {
        accessControl,
        isMod,
        isSuperUser,
        isOP,
        hasPermission,
    });

    if (!hasPermission) {
        let msgKey: AppSetting;
        let notifyKey: AppSetting;

        switch (accessControl) {
            case AccessControlOptions.ModsOnly:
                msgKey = AppSetting.ModOnlyDisallowedMessage;
                notifyKey = AppSetting.NotifyOnModOnlyDisallowed;
                break;

            case AccessControlOptions.ModsAndSuperusers:
                msgKey = AppSetting.ApprovedOnlyDisallowedMessage;
                notifyKey = AppSetting.NotifyOnApprovedOnlyDisallowed;
                break;

            case AccessControlOptions.ModsSuperusersAndPostAuthor:
                msgKey = AppSetting.OPOnlyDisallowedMessage;
                notifyKey = AppSetting.NotifyOnOPOnlyDisallowed;
                break;

            case AccessControlOptions.ModsAndPostAuthor:
                msgKey = AppSetting.ModsAndPostAuthorDisallowedMessage;
                notifyKey = AppSetting.NotifyOnModsAndPostAuthorDisallowed;
                break;

            default:
                logger.warn("⚠️ Unknown accessControl value", {
                    accessControl,
                });
                return false;
        }

        const denyMsg = formatMessage(
            event,
            (settings[msgKey] as string) ??
                TemplateDefaults.ModOnlyDisallowedMessage,
            {
                awarder: awarderID,
                name: pointName,
            }
        );

        const notifyMode = ((settings[notifyKey] as string[]) ?? ["none"])[0];

        await replyToUser(
            devvitContext,
            notifyMode ?? "none",
            awarderID,
            denyMsg,
            event.comment.id
        );

        return false;
    }

    return true;
}

export async function awarderIsBot(
    event: CommentSubmit | CommentUpdate,
    devvitContext: TriggerContext,
    awarder: string,
    settings: SettingsValues
) {
    if (!event.comment) return;
    if (
        ["automoderator", devvitContext.appSlug.toLowerCase()].includes(
            awarder.toLowerCase()
        )
    ) {
        logger.debug("❌ System user attempted a command");
        return;
    }

    const parentComment: Comment | undefined = await getParentComment(
        event,
        devvitContext
    );
    if (!parentComment) {
        logger.warn("❌ Parent comment not found", {
            commentId: event.comment.id,
        });
        return;
    }

    const recipient = parentComment.authorName;
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";

    if (
        awarder === devvitContext.appSlug ||
        awarder.toLowerCase() === "automoderator"
    ) {
        const botMsg = formatMessage(
            event,
            (settings[AppSetting.BotAwardMessage] as string) ??
                TemplateDefaults.BotAwardMessage,
            { name: pointName, awardee: recipient }
        );
        const botAwardMessage = await devvitContext.reddit.submitComment({
            id: event.comment.id,
            text: botMsg,
        });
        await botAwardMessage.distinguish();
        logger.debug(`❌ ${recipient} cannot be awarded points`);
        return;
    }
}

export async function recipientIsBot(
    event: CommentSubmit | CommentUpdate,
    devvitContext: TriggerContext,
    awarder: string,
    recipient: string,
    settings: SettingsValues
) {
    if (!event.comment) return;
    const pointName = (settings[AppSetting.PointName] as string) ?? "point";
    if (
        ["automoderator", devvitContext.appSlug.toLowerCase()].includes(
            awarder.toLowerCase()
        )
    ) {
        logger.debug("❌ System user attempted a command");
        return;
    }

    if (
        ["automoderator", devvitContext.appSlug.toLowerCase()].includes(
            recipient.toLowerCase()
        )
    ) {
        // Prevent bot account or Automod granting points
        const botAwardMessage = formatMessage(
            event,
            (settings[AppSetting.BotAwardMessage] as string) ??
                TemplateDefaults.BotAwardMessage,
            { name: pointName, awardee: recipient }
        );

        const awardGivenToBotMessage = await devvitContext.reddit.submitComment(
            {
                id: event.comment.id,
                text: botAwardMessage,
            }
        );
        await awardGivenToBotMessage.distinguish();
        logger.debug("❌ Bot cannot award itself points");
        return;
    }
}

export async function handleIgnoredContext(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
    trigger: string
): Promise<void> {
    if (!event.comment || !event.author || !event.subreddit) return;

    const body = (event.comment.body ?? "").toLowerCase();
    const ignoredType = getIgnoredContextType(body, trigger);
    if (!ignoredType) return;

    const ignoreKey = `normalCommandIgnoreDM:${event.author.name.toLowerCase()}:${ignoredType}`;
    const alreadyConfirmed = await context.redis.exists(ignoreKey);

    if (alreadyConfirmed) return;

    const contextLabel =
        ignoredType === "quote"
            ? "a quote block (`> text`)"
            : ignoredType === "alt"
            ? "`alt text` (text surrounded by backticks (`))"
            : "a spoiler block (`>!text!<`)";

    const initialTriggerInContextLabelNotification = `Hey u/${event.author.name}, I noticed you used the command **${trigger}** inside ${contextLabel}.\n\n`;
    const confirmInfo = `Edit [this comment](${event.comment.permalink}) with **CONFIRM** if you intended to use the command this way and don't wish to be warned about this in the future.`;

    const dmText = formatMessage(
        event,
        initialTriggerInContextLabelNotification + confirmInfo,
        {}
    );

    await context.reddit.sendPrivateMessage({
        to: event.author.name,
        subject: `Your ${trigger} command was ignored`,
        text: dmText,
    });

    await context.redis.set(
        `pendingConfirm:${event.author.name.toLowerCase()}`,
        ignoredType
    );

    logger.info("⚠️ Normal command ignored due to context", {
        user: event.author.name,
        trigger,
        ignoredType,
    });

    return;
}

export async function ignoredContextNeedsHandling(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
    trigger: string
): Promise<boolean> {
    if (!event.comment || !event.author || !event.subreddit) return false;

    const body = (event.comment.body ?? "").toLowerCase();
    const ignoredType = getIgnoredContextType(body, trigger);
    if (!ignoredType) return false;

    const ignoreKey = `normalCommandIgnoreDM:${event.author.name.toLowerCase()}:${ignoredType}`;
    const alreadyConfirmed = await context.redis.exists(ignoreKey);

    if (alreadyConfirmed) return true;

    return false;
}
