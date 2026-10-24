import { reddit, redis, scheduler, settings } from "@devvit/web/server";
import type { CommentSubmit, CommentUpdate } from "@devvit/protos";
import type { TriggerContext, Comment, User } from "../../compat";
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
    awardee: string
): Promise<void> {
    const settingBaseCSSClass = await settings.get<string>("baseCSSClass");
    const settingBaseFlairTemplate = await settings.get<string>(
        "baseFlairTemplate"
    );
    const settingSuperAwarderCSSClass = await settings.get<string>(
        "superAwarderCSSClass"
    );

    if (!context.subredditName) {
        logger.error("Cannot set user flair: subreddit name is missing");
        return;
    }

    const settingPointName = await settings.get<string>("pointName");
    const pointName = settingPointName ?? "point";
    const subredditName = await getSubredditName(context);
    const safeWiki = new SafeWikiClient(reddit);

    const baseCssClass = settingBaseCSSClass || undefined;

    const baseFlairTemplate = settingBaseFlairTemplate || undefined;

    const superAwarderCSSClass = settingSuperAwarderCSSClass || undefined;

    // Use the base template until a dedicated Super Awarder template setting exists.
    const superAwarderFlairTemplate = await settings.get<string>(
        "superAwarderFlairTemplate"
    );

    const flairFormatting = await settings.get<string>("flairFormatting");

    const pointSymbol = (await settings.get<string>("pointSymbol")) ?? "";

    const superAwarderThreshold =
        (await settings.get<number>("superAwarderThreshold")) ?? 0;

    const superAwarderFlairText = await settings.get<string>(
        "superAwarderFlairText"
    );

    const capPlural = escapeMarkdownText(capitalize(pluralize(pointName)));

    // Initialize the cached awards-given count from the latest wiki page
    // if it doesn't exist yet.
    const getOrInitializeAwardsGiven = async (
        username: string
    ): Promise<number> => {
        const redisKey = `awardsGiven:${username}`;
        const cached = await redis.get(redisKey);

        if (cached && cached !== null && cached !== "") {
            const parsed = Number.parseInt(cached, 10);
            return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
        }

        let count = 0;
        const latestPage = await getStoredLatestPage(username);

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

        await redis.set(redisKey, count.toString());
        return count;
    };

    // The awarder gets credit for this award:
    // - If their cache already exists, increment it.
    // - Otherwise initialize it from their wiki without incrementing it.
    const awarderAwardsGivenKey = `awardsGiven:${awarder}`;
    const cachedAwarderCount = await redis.get(awarderAwardsGivenKey);

    if (
        cachedAwarderCount &&
        cachedAwarderCount !== null &&
        cachedAwarderCount !== ""
    ) {
        const parsed = Number.parseInt(cachedAwarderCount, 10);
        const currentCount =
            Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;

        await redis.set(awarderAwardsGivenKey, (currentCount + 1).toString());
    } else {
        await getOrInitializeAwardsGiven(awarder);
    }

    // Get the received-points leaderboard once for both users.
    const leaderboard = await redis.zRange(POINTS_STORE_KEY, 0, -1, {
        by: "rank",
        reverse: true,
    });

    // If both names are the same, only update that user once.
    const usernames = [...new Set([awarder, awardee])];

    for (const username of usernames) {
        try {
            // Respect each user's own flair opt-out.
            const flairDisabled = await redis.exists(`flairToggle:${username}`);

            if (flairDisabled) {
                logger.info("Skipping flair update because user opted out", {
                    username,
                });
                continue;
            }

            // Received-points total and leaderboard position.
            const score = (await redis.zScore(POINTS_STORE_KEY, username)) ?? 0;

            const index = leaderboard.findIndex(
                (member: { member: string; score: number }) =>
                    member.member === username
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

            if (!flairText) {
                logger.error(`Couldn't retrieve flair text, returning`);
                return;
            }

            for (const [placeholder, value] of Object.entries(replacements)) {
                flairText = flairText.replaceAll(placeholder, value);
            }

            // A flair template ID takes precedence over the CSS class.
            if (flairTemplate) {
                cssClass = undefined;
            }

            await reddit.setUserFlair({
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
    const settingPointName = await settings.get<string>("pointName");
    const settingExistingFlairHandling = await settings.get<string>(
        "existingFlairHandling"
    );

    await redis.zAdd(POINTS_STORE_KEY, {
        member: awardee,
        score: newScore.score,
    });

    logger.debug("Saved user score", {
        awardee,
        score: newScore.score,
    });

    // Queue cleanup checks for both users.
    await setCleanupForUsers([awardee, awarder]);

    // Queue a leaderboard update.

    if (!(await redis.get(`awardsGiven:${awarder}`))) {
        const safeWiki = new SafeWikiClient(reddit);
        const subredditName = await getSubredditName(context);
        const latestPage = await discoverLatestPage(
            subredditName,
            awarder,
            safeWiki
        );
        const pointName = settingPointName ?? "point";
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
                await redis.set(`awardsGiven:${awarder}`, awardsGiven);
            } else {
                await redis.set(`awardsGiven:${awarder}`, "1");
            }
        }
    }

    const awarderScore = (await redis.get(`awardsGiven:${awarder}`)) ?? "0";

    await scheduler.runJob({
        name: UPDATE_LEADERBOARD_JOB,
        runAt: new Date(),
        data: {
            reason: `Updated score for ${awardee} and ${awarder}. Awardee Score: ${newScore.score}. Awarder Score: ${awarderScore}.`,
        },
    });

    // Respect the configured existing-flair overwrite behavior.

    let shouldSetUserFlair: boolean;

    if (
        settingExistingFlairHandling === "overwritenumericsymbol" ||
        settingExistingFlairHandling === "overwritenumeric"
    ) {
        shouldSetUserFlair = true;
    } else if (settingExistingFlairHandling === "neverset") {
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
                existingFlairOverwriteHandling: settingExistingFlairHandling,
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

    // Set the recipient's flair using values fetched individually from Devvit Web settings.
    await setFlairForUser(context, awarder, awardee);
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

    const settingPointName = await settings.get<string>("pointName");
    const settingNotifyOnPostAuthorAward = await settings.get<string>(
        "notifyOnPostAuthorAward"
    );
    const settingPostAuthorAwardMessage =
        (await settings.get<string>("postAuthorAwardMessage")) ?? "";
    const settingModAwardCommandFail =
        (await settings.get<string>("modAwardCommandFail")) ?? "";
    const awarder = event.author.name;
    const commentBody = event.comment.body.toLowerCase();
    const triggers = await getTriggers(devvitContext);
    const triggerUsed = triggers.find((t) => commentBody.includes(t));
    const pointName = (settingPointName as string) ?? "point";
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
        devvitContext
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

    await unflairedPostLogic(event, devvitContext, awarder);

    await flairTextNotAllowedLogic(
        event,
        devvitContext,
        awarder,
        commentBody,
        triggerUsed
    );

    await selfAwardAttemptLogic(event, devvitContext, awarder, awardee);

    await recipientIsBot(event, devvitContext, awarder, awardee);

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
                const notifyMode = settingNotifyOnPostAuthorAward;
                const formattedPostAuthorAwardMessage = formatMessage(
                    event,
                    settingPostAuthorAwardMessage,
                    { name: pointName }
                );

                if (notifyMode === "replybycomment") {
                    const postAuthorAwardComment =
                        await devvitContext.reddit.submitComment({
                            id: event.comment.id,
                            text: formattedPostAuthorAwardMessage,
                        });
                    postAuthorAwardComment.distinguish();
                } else if (notifyMode === "replybypm") {
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
                settingModAwardCommandFail,
                {
                    awarder,
                    awardee,
                    command,
                }
            );

            const settingNotifyOnModAwardFail = await settings.get<string>(
                "notifyOnModAwardFail"
            );
            const notify = (settingNotifyOnModAwardFail ?? ["none"])[0];

            if (notify === "replybypm") {
                await devvitContext.reddit.sendPrivateMessage({
                    to: awarder,
                    text: modAwardFailMsg,
                    subject: "Unsuccessful Award",
                });
            } else if (notify === "replybycomment") {
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
    awarder: string
) {
    const settingAllowUnflairedPosts = await settings.get<boolean>(
        "allowUnflairedPosts"
    );
    const settingUnflairedPostMessage = await settings.get<string>(
        "unflairedPostMessage"
    );

    if (!event.post || !event.comment || !event.author || !event.subreddit)
        return;

    const allowUnflairedPosts = settingAllowUnflairedPosts ?? true;

    const unflairedMessage = settingUnflairedPostMessage ?? "";

    const settingNotifyOnUnflairedPost = await settings.get<string>(
        "notifyOnUnflairedPost"
    );
    const notifyUnflaired = (settingNotifyOnUnflairedPost ?? ["none"])[0];

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

        if (await redis.exists(responseKey)) {
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
            if (notifyUnflaired === "replybypm") {
                await reddit.sendPrivateMessage({
                    to: awarder,
                    subject: `Awards disabled for unflaired posts`,
                    text: unflairedMessage,
                });
            } else if (notifyUnflaired === "replybycomment") {
                const unflairedPostMessage = await reddit.submitComment({
                    id: event.comment.id as `t1_${string}`,
                    text: unflairedMessage,
                });
                await unflairedPostMessage.distinguish();
            }
        } catch (err) {
            logger.error(
                "❌ Failed to notify user about unflaired post restriction",
                { awarder, commentId: event.comment.id, err }
            );
        }

        await redis.set(responseKey, "1");
        return; // ⛔ Stop award flow ONLY for unflaired posts
    }
}

export async function flairTextNotAllowedLogic(
    event: CommentSubmit | CommentUpdate,
    context: TriggerContext,
    awarder: string,
    commentBody: string,
    triggerUsed: string
) {
    const settingDisallowedFlairMessage = await settings.get<string>(
        "disallowedFlairMessage"
    );
    const settingDisallowedFlairs = await settings.get<string>(
        "disallowedFlairs"
    );
    const settingPointName = await settings.get<string>("pointName");

    if (!event.post || !event.comment || !event.author) return;
    const pointName = settingPointName ?? "point";
    const flairTextDisallowedMessage = formatMessage(
        event,
        settingDisallowedFlairMessage ?? "",
        { name: pointName }
    );
    const postFlairText = event.post.linkFlair?.text?.trim();

    const settingNotifyOnDisallowedFlair = await settings.get<string>(
        "notifyOnDisallowedFlair"
    );
    const notifyFlairIgnored = (settingNotifyOnDisallowedFlair ?? ["none"])[0];

    // ─────────────────────────────────────────────
    // Disallowed flair guard (non-terminating)
    // ─────────────────────────────────────────────

    if (!settingDisallowedFlairs) {
        logger.error(`Disallowed flairs setting doesn't exist, returning`);
        return;
    }
    if (settingDisallowedFlairs.includes(postFlairText ?? "")) {
        logger.error(
            `User attempted to award points on flair-disallowed post, but it's not allowed`,
            { linkFlair: event.post.linkFlair }
        );
        return;
    }

    if (!postFlairText) return;

    const rawDisallowedFlairs = settingDisallowedFlairs ?? "";

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

        if (await redis.exists(responseKey)) {
            logger.debug(
                "♻️ Disallowed flair already handled for this comment",
                {
                    commentId: event.comment.id,
                }
            );
            return;
        }

        // Mark handled BEFORE replying
        await redis.set(responseKey, "1");

        logger.info("🚫 Award blocked due to disallowed flair", {
            postFlair: postFlairText,
        });

        if (notifyFlairIgnored === "replybypm") {
            await reddit.sendPrivateMessage({
                to: awarder,
                subject: `${pointName}s cannot be awarded on ${event.post.title}`,
                text: flairTextDisallowedMessage,
            });
        } else if (notifyFlairIgnored === "replybycomment") {
            const disallowedFlairMessage = await reddit.submitComment({
                id: event.comment.id as `t1_${string}`,
                text: flairTextDisallowedMessage,
            });
            await disallowedFlairMessage.distinguish();
        }
        return; // ⛔ block award
    }
}

export async function selfAwardAttemptLogic(
    event: CommentSubmit | CommentUpdate,
    _: TriggerContext,
    awarder: string,
    recipient: string
) {
    const settingPointName = await settings.get<string>("pointName");
    const settingSelfAwardMessage = await settings.get<string>(
        "selfAwardMessage"
    );

    if (!event.comment || !event.author) return;
    const pointName = settingPointName ?? "point";
    const selfMsgTemplate = settingSelfAwardMessage ?? "";
    const settingNotifyOnSelfAward = await settings.get<string>(
        "notifyOnSelfAward"
    );
    const notifySelf = (settingNotifyOnSelfAward ?? ["none"])[0];
    if (awarder === recipient) {
        const selfText = formatMessage(event, selfMsgTemplate, {
            awarder,
            name: pointName,
        });
        if (notifySelf === "replybycomment") {
            const selfAwardMessage = await reddit.submitComment({
                id: event.comment.id as `t1_${string}`,
                text: selfText,
            });
            await selfAwardMessage.distinguish();
        } else if (notifySelf === "replybypm") {
            await reddit.sendPrivateMessage({
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
    if (await redis.exists(responseKey)) {
        logger.debug("♻️ replyToUser: response already sent", {
            commentId,
            notifyMode,
        });
        return;
    }

    try {
        if (notifyMode === "replybypm") {
            await reddit.sendPrivateMessage({
                to: recipient,
                subject: "Award not allowed",
                text: message,
            });

            logger.info("📬 replyToUser: sent PM", {
                recipient,
                commentId,
            });
        } else if (notifyMode === "replybycomment") {
            const reply = await reddit.submitComment({
                id: commentId as `t1_${string}`,
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
        await redis.set(responseKey, "1");
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
    devvitContext: TriggerContext
): Promise<boolean> {
    const settingPointName = await settings.get<string>("pointName");

    if (!event.post || !event.comment) return false;

    const pointName = settingPointName ?? "point";

    const isMod = commentTriggerContext.isMod;
    const isSuperUser = commentTriggerContext.isSuperUser;
    const isOP = awarderID === event.post.authorId;

    const settingAccessControl = await settings.get<string[]>("accessControl");
    const accessControl = settingAccessControl ?? ["everyone"];

    const hasPermission =
        accessControl.includes("everyone") ||
        (accessControl.includes("moderators-only") && isMod) ||
        (accessControl.includes("moderators-and-superusers") &&
            (isMod || isSuperUser)) ||
        (accessControl.includes("moderators-and-op") && (isMod || isOP)) ||
        (accessControl.includes("moderators-superusers-and-op") &&
            (isMod || isSuperUser || isOP));

    logger.debug("Permission check", {
        accessControl,
        isMod,
        isSuperUser,
        isOP,
        hasPermission,
    });

    logger.debug("Permission check", {
        accessControl,
        isMod,
        isSuperUser,
        isOP,
        hasPermission,
    });

    if (!hasPermission) {
        let denyMessageSetting: string | undefined;
        let notifyMode: string | undefined;

        // Read the exact setting names directly. Avoid computed appSettings keys,
        // which hide the actual Devvit Web setting names from type checking.
        switch (accessControl) {
            case ["moderators-only"]:
                denyMessageSetting = await settings.get<string>(
                    "modOnlyDisallowedMessage"
                );
                notifyMode = await settings.get<string>(
                    "notifyOnModOnlyDisallowed"
                );
                break;

            case ["moderators-and-superusers"]:
                denyMessageSetting = await settings.get<string>(
                    "approvedOnlyDisallowedMessage"
                );
                notifyMode = await settings.get<string>(
                    "notifyOnApprovedOnlyDisallowed"
                );
                break;

            case ["moderators-superusers-and-op"]:
                denyMessageSetting = await settings.get<string>(
                    "opOnlyDisallowedMessage"
                );
                notifyMode = await settings.get<string>(
                    "notifyOnOPOnlyDisallowed"
                );
                break;

            case ["moderators-and-op"]:
                denyMessageSetting = await settings.get<string>(
                    "modsAndPostAuthorDisallowedMessage"
                );
                notifyMode = await settings.get<string>(
                    "notifyOnModsAndPostAuthorDisallowed"
                );
                break;
            default:
                logger.warn("⚠️ Unknown accessControl value", {
                    accessControl,
                });
                return false;
        }

        const denyMsg = formatMessage(event, denyMessageSetting ?? "", {
            awarder: awarderID,
            name: pointName,
        });

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

export async function recipientIsBot(
    event: CommentSubmit | CommentUpdate,
    devvitContext: TriggerContext,
    awarder: string,
    recipient: string
) {
    const settingBotAwardMessage = await settings.get<string>(
        "botAwardMessage"
    );
    const settingPointName = await settings.get<string>("pointName");

    if (!event.comment) return;
    const pointName = settingPointName ?? "point";
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
            settingBotAwardMessage ?? "",
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
    _: TriggerContext,
    trigger: string
): Promise<void> {
    if (!event.comment || !event.author || !event.subreddit) return;

    const body = (event.comment.body ?? "").toLowerCase();
    const ignoredType = getIgnoredContextType(body, trigger);
    if (!ignoredType) return;

    const ignoreKey = `normalCommandIgnoreDM:${event.author.name.toLowerCase()}:${ignoredType}`;
    const alreadyConfirmed = await redis.exists(ignoreKey);

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

    await reddit.sendPrivateMessage({
        to: event.author.name,
        subject: `Your ${trigger} command was ignored`,
        text: dmText,
    });

    await redis.set(
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
    _: TriggerContext,
    trigger: string
): Promise<boolean> {
    if (!event.comment || !event.author || !event.subreddit) return false;

    const body = (event.comment.body ?? "").toLowerCase();
    const ignoredType = getIgnoredContextType(body, trigger);
    if (!ignoredType) return false;

    const ignoreKey = `normalCommandIgnoreDM:${event.author.name.toLowerCase()}:${ignoredType}`;
    const alreadyConfirmed = await redis.exists(ignoreKey);

    if (alreadyConfirmed) return true;

    return false;
}
