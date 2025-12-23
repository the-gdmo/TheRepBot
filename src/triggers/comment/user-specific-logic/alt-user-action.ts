import { CommentSubmit, CommentUpdate } from "@devvit/protos";
import { TriggerContext } from "@devvit/public-api";
import {
    escapeForRegex,
    formatMessage,
    modCommandValue,
    triggerUsed,
    userCommandValues,
} from "../../../utils/common-utilities.js";
import {
    CommentTriggerContext,
    parentComment,
} from "../comment-trigger-context.js";
import { logger } from "../../../logger.js";
import { AppSetting, TemplateDefaults } from "../../../settings.js";

export async function commentContainsAltCommand(
    event: CommentSubmit | CommentUpdate,
    devvitContext: TriggerContext,
    commentId: string
): Promise<boolean> {
    if (!event.comment) return false;

    const commentBodyRaw = event.comment.body ?? "";
    const commentBody = commentBodyRaw.toLowerCase();

    logger.info(`Comment registered in commentContainsAltCommand()`, {
        commentId,
    });
    const triggerUsedInCommand = await triggerUsed(devvitContext, commentId);
    if (!triggerUsedInCommand) {
        logger.info(`❌ No valid award command found.`);
        return false;
    }

    const altCommandMatch = commentBody.match(
        new RegExp(`${triggerUsed}\\s+(\\S+)`, "i")
    );

    logger.info(`altCommandMatch:`, {
        altCommandMatch,
    });

    if (altCommandMatch) {
        return true;
    } else {
        return false;
    }
}

export async function altUsernameLengthInvalid(
    event: CommentSubmit | CommentUpdate,
    devvitContext: TriggerContext,
    commentId: string,
    awarder: string,
) {
    const context = new CommentTriggerContext();
    await context.init(event, devvitContext);

    const usedTrigger = await triggerUsed(devvitContext, commentId);
    const userCommands = await userCommandValues(devvitContext);
    const modCommand = await modCommandValue(devvitContext);

    let mentionedUsername: string | undefined;
    if (!usedTrigger) return;
    if (!event.comment) return;

    const commentBodyRaw = event.comment.body ?? "";
    const commentBody = commentBodyRaw.toLowerCase();

    const settings = await devvitContext.settings.getAll();
    // Only run ALT flow if user is an ALT user
    if (
        userCommands.includes(usedTrigger) ||
        modCommand.includes(usedTrigger)
    ) {
        // Regex: match valid ALT username with space + u/
        const validMatch = commentBody.match(
            new RegExp(
                `${escapeForRegex(usedTrigger)}\s+u\/([a-z0-9_-]{3,21})`,
                "i"
            )
        );

        logger.debug(`🧩 usedTrigger/validMatch:`, { usedTrigger, validMatch });

        if (validMatch) {
            mentionedUsername = validMatch[1];
            const mentionUsername = mentionedUsername.slice(2);

            // Validate username length explicitly (3–21 chars)
            if (mentionUsername.length < 3 || mentionUsername.length > 21) {
                const lengthMessage = formatMessage(
                    (settings[AppSetting.UsernameLengthMessage] as string) ??
                        TemplateDefaults.UsernameLengthMessage,
                    { awarder, awardee: mentionUsername }
                );

                const reply = await devvitContext.reddit.submitComment({
                    id: event.comment.id,
                    text: lengthMessage,
                });
                await reply.distinguish();

                logger.warn("❌ ALT username length invalid", {
                    awarder,
                    mentionUsername,
                    mentionedUsername,
                });
                return;
            }
        }
    }
}

//TODO: IMPLEMENT INVALID USERNAME MENTION LOGIC, POINT ALREADY AWARDED TO USER WITH ALT COMMAND ON POST, NOTIFY IF USER BECOMES SUPERUSER FROM ALT COMMAND

        // Validate allowed characters (letters, numbers, hyphen, underscore)
        if (!/^[a-z0-9_-]+$/i.test(mentionUsername)) {
            const invalidCharMessage = formatMessage(
                (settings[AppSetting.InvalidUsernameMessage] as string) ??
                    TemplateDefaults.InvalidUsernameMessage,
                { awarder, awardee: mentionUsername }
            );

            const reply = await context.reddit.submitComment({
                id: event.comment.id,
                text: invalidCharMessage,
            });
            await reply.distinguish();

            logger.warn("❌ ALT command username contains invalid characters", {
                awarder,
                triggerUsed,
                mentionUsername,
                mentionedUsername,
            });
            return; // Stop ALT flow
        }
    } else {
        // User typed a word after trigger but missing u/ prefix
        const fallbackMatch = commentBody.match(
            new RegExp(`${triggerUsed}\\s+(\\S+)`, "i")
        );

        if (fallbackMatch) {
            const invalidMention = fallbackMatch[1];
            const invalidMentionUsername = invalidMention.slice(2);

            // Validate length
            if (
                invalidMentionUsername.length < 3 ||
                invalidMentionUsername.length > 21
            ) {
                const lengthMessage = formatMessage(
                    (settings[AppSetting.UsernameLengthMessage] as string) ??
                        TemplateDefaults.UsernameLengthMessage,
                    { awarder, awardee: invalidMention }
                );

                const reply = await context.reddit.submitComment({
                    id: event.comment.id,
                    text: lengthMessage,
                });
                await reply.distinguish();

                logger.warn("❌ ALT username length invalid", {
                    awarder,
                    invalidMention,
                    invalidMentionUsername,
                });
                return;
            }

            // Validate allowed characters
            if (!/^[a-z0-9_-]+$/i.test(invalidMentionUsername)) {
                const invalidCharMessage = formatMessage(
                    (settings[AppSetting.InvalidUsernameMessage] as string) ??
                        TemplateDefaults.InvalidUsernameMessage,
                    { awarder, awardee: invalidMention }
                );

                const reply = await context.reddit.submitComment({
                    id: event.comment.id,
                    text: invalidCharMessage,
                });
                await reply.distinguish();

                logger.warn(
                    "❌ ALT command username contains invalid characters",
                    {
                        awarder,
                        triggerUsed,
                        invalidMention,
                        invalidMentionUsername,
                    }
                );
                return; // Stop ALT flow
            }

            // Warn ALT user to use u/ prefix
            const noUMessage = formatMessage(
                (settings[AppSetting.NoUsernameMentionMessage] as string) ??
                    TemplateDefaults.NoUsernameMentionMessage,
                { awarder, awardee: invalidMention }
            );

            const reply = await context.reddit.submitComment({
                id: event.comment.id,
                text: noUMessage,
            });
            await reply.distinguish();

            logger.warn("❌ ALT command used without u/ prefix", {
                awarder,
                triggerUsed,
                invalidMention,
                invalidMentionUsername,
            });
        } else {
            logger.debug("❌ ALT command used but no username detected");
        }

        return; // Stop ALT flow if no valid username
    }

    // MAIN ALT FLOW
    const authorized = altCommandUsers.includes(awarder.toLowerCase());

    logger.debug(`🧩 authorizedVar Values:`, { awarder, authorized });

    if (!authorized) {
        const failMessage = formatMessage(altFailMessageTemplate, {
            altCommand: triggerUsed,
            subreddit: subredditName,
        });

        if (
            notifyAltFail ===
            NotifyOnAlternateCommandFailReplyOptions.ReplyAsComment
        ) {
            const failComment = await context.reddit.submitComment({
                id: event.comment.id,
                text: failMessage,
            });
            await failComment.distinguish();
        } else if (
            notifyAltFail === NotifyOnAlternateCommandFailReplyOptions.ReplyByPM
        ) {
            await context.reddit.sendPrivateMessage({
                to: awarder,
                subject: "Alternate Command Not Allowed",
                text: failMessage,
            });
        }

        logger.warn("🚫 Unauthorized ALT award attempt", {
            awarder,
            triggerUsed,
            mentionedUsername,
        });
        return;
    }

    // MAIN ALT FLOW
    logger.debug("🔎 ALT flow username probe", {
        extracted: mentionedUsername,
        triggerUsed,
    });

    // Duplicate-prevention for ALT flow: unique per post & target
    const altDupKey = `customAward-${event.post.id}-${mentionedUsername}`;
    if (await context.redis.exists(altDupKey)) {
        const dupMsg = formatMessage(
            (settings[AppSetting.PointAlreadyAwardedToUserMessage] as string) ??
                TemplateDefaults.PointAlreadyAwardedToUserMessage,
            { name: pointName, awardee: mentionedUsername }
        );

        const notify = ((settings[
            AppSetting.NotifyOnPointAlreadyAwardedToUser
        ] as string[]) ?? ["none"])[0];

        if (
            notify === NotifyOnPointAlreadyAwardedToUserReplyOptions.ReplyByPM
        ) {
            await context.reddit.sendPrivateMessage({
                to: awarder,
                subject: `You've already awarded this comment`,
                text: dupMsg,
            });
        } else if (
            notify ===
            NotifyOnPointAlreadyAwardedToUserReplyOptions.ReplyAsComment
        ) {
            const newComment = await context.reddit.submitComment({
                id: event.comment.id,
                text: dupMsg,
            });
            await newComment.distinguish();
        }

        logger.info("❌ Duplicate ALT award attempt", {
            awarder,
            mentionedUsername,
        });
        return;
    }

    await context.redis.set(altDupKey, "1");

    // Award (ALT)
    const newScore = await context.redis.zIncrBy(
        redisKey,
        mentionedUsername,
        1
    );

    // Leaderboard update
    await context.scheduler.runJob({
        name: "updateLeaderboard",
        runAt: new Date(),
        data: {
            reason: `Alternate award from ${awarder} to ${mentionedUsername} (new: ${newScore})`,
        },
    });

    // Notify success (ALT)
    const leaderboard = `https://old.reddit.com/r/${subredditName}/wiki/${
        settings[AppSetting.LeaderboardName] ?? "leaderboard"
    }`;
    const symbol = pointSymbol;
    const awardeePage = `https://old.reddit.com/r/${event.subreddit.name}/wiki/user/${mentionedUsername}`;

    const successMessage = formatMessage(altSuccessMessageTemplate, {
        name: pointName,
        awardee: mentionedUsername,
        awarder,
        total: newScore.toString(),
        symbol,
        leaderboard,
        awardeePage,
    });

    if (
        notifyAltSuccess ===
        NotifyOnAlternateCommandSuccessReplyOptions.ReplyAsComment
    ) {
        const newComment = await context.reddit.submitComment({
            id: event.comment.id,
            text: successMessage,
        });
        await newComment.distinguish();
    } else if (
        notifyAltSuccess ===
        NotifyOnAlternateCommandSuccessReplyOptions.ReplyByPM
    ) {
        await context.reddit.sendPrivateMessage({
            to: awarder,
            subject: "Alternate Command Successful",
            text: successMessage,
        });
    }

    // Flair update (ALT)
    try {
        const recipientUser = await context.reddit.getUserByUsername(
            mentionedUsername
        );
        if (recipientUser) {
            const { currentScore: recipientScore } = await getCurrentScore(
                recipientUser,
                context,
                settings
            );
            const zscore = await context.redis.zScore(
                redisKey,
                mentionedUsername
            );
            const recipientIsRestricted = await getUserIsRestricted(
                mentionedUsername,
                context
            );

            await updateAwardeeFlair(
                context,
                subredditName,
                mentionedUsername,
                (zscore ?? recipientScore) || 0,
                settings,
                recipientIsRestricted
            );
            logger.info("🎨 ALT flair updated", {
                mentionedUsername,
                score: zscore ?? recipientScore,
            });
        }
    } catch (err) {
        logger.error("❌ ALT flair update error", { err });
    }

    // Auto-superuser notification (ALT)
    await maybeNotifyAutoSuperuser(
        context,
        settings,
        mentionedUsername,
        event.comment.permalink,
        event.comment.id,
        newScore,
        modCommand
    );

    logger.info(
        `🏅 ALT award: ${awarder} → ${mentionedUsername} +1 ${pointName}`
    );

    // Update user wikis for the awarder + mentioned user
    try {
        const givenData = {
            postTitle: event.post.title,
            postUrl: event.post.permalink,
            recipient: mentionedUsername,
            commentUrl: event.comment.permalink,
        };
        await updateUserWiki(context, awarder, mentionedUsername, givenData);
    } catch (err) {
        logger.error("❌ Failed to update user wiki (ALT)", {
            awarder,
            mentionedUsername,
            err,
        });
    }

    return; // ALT path handled fully
}
