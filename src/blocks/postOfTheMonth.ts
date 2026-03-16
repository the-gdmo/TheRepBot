import { Post, TriggerContext } from "@devvit/public-api";
import { logger } from "./logger";
import { AppSetting } from "./settings";

export async function addPostOfTheMonthFlair(
    _: unknown,
    context: TriggerContext
): Promise<void> {
    const settings = await context.settings.getAll();

    const enablePostOfTheMonth =
        (settings[AppSetting.EnablePostOfTheMonth] as boolean) ?? false;

    if (!enablePostOfTheMonth) {
        logger.error(`Post Of The Month is not enabled`);
        return;
    }

    // const trackingPage =
    //     (settings[AppSetting.PostOfTheMonthPage] as string) ??
    //     "therepbot/postqualitytracker";

    const postOfTheMonthFlairText =
        (settings[AppSetting.PostOfTheMonthFlairText] as string) ?? "";

    let postOfTheMonthCSSClass =
        (settings[AppSetting.PostOfTheMonthFlairCSSClass] as string) ?? "";
    const postOfTheMonthFlairTemplate =
        (settings[AppSetting.PostOfTheMonthFlairTemplate] as string) ?? "";

    if (postOfTheMonthFlairTemplate) postOfTheMonthCSSClass = "";

    if (!postOfTheMonthFlairText) {
        logger.warn("❌ No Post of the Month flair configuration set");
        return;
    }

    const subreddit = await context.reddit.getCurrentSubreddit();
    const subredditName = subreddit.name;

    // const safeWiki = new SafeWikiClient(context.reddit);

    // let existingPage;
    // try {
    //     existingPage = await safeWiki.getWikiPage(subredditName, trackingPage);
    // } catch {
    //     existingPage = undefined;
    // }

    // const initialContent = `# `;
    // if (!existingPage) {
    //     await safeWiki.createWikiPage({
    //         subredditName,
    //         page: trackingPage,
    //         content: initialContent,
    //         reason: "Creating initial wiki page for Post Of The Month",
    //     });
    //     logger.info(`Created initial tracking page`, { trackingPage });
    // }

    // let content = existingPage?.contentMd?.trim() ?? "#";
    // if (!content || content === "# ") {
    //     logger.info("ℹ️ Post of the Month tracker is empty");
    //     content = "| Date | Post | Author |\n|--------|------|------|\n";
    // }

    // ──────────────── FETCH TOP POSTS THIS MONTH ────────────────
    const topPostsListing = context.reddit.getTopPosts({
        timeframe: "month",
        subredditName,
        limit: 50,
    });

    if (!topPostsListing) {
        logger.info("ℹ️ No posts found in the top monthly filter");
        return;
    }

    // Get all posts from the Listing
    const allPosts: Post[] = await topPostsListing.all();

    if (!allPosts || allPosts.length === 0) {
        logger.info("ℹ️ No posts available in top monthly listing");
        return;
    }

    // ──────────────── LOG NEW POSTS ────────────────
    // for (const post of allPosts) {
    //     const seenKey = `potm:seen-posts:${post.id}`;
    //     const alreadySeen = await context.redis.exists(seenKey);
    //     if (!alreadySeen) {
    //         await context.redis.set(seenKey, "1");
    //         logger.info("🆕 New Post of the Month entry detected", {
    //             postId: post.id,
    //             score: post.score,
    //             author: post.authorName,
    //         });
    //     }
    // }

    // if (allPosts.length === 0) {
    //     logger.info("ℹ️ No new posts to add to the Post of the Month table");
    // }

    // ──────────────── PICK WINNER BY HIGHEST SCORE ────────────────
    const winnerPost = allPosts.reduce((prev, curr) =>
        curr.score > prev.score ? curr : prev
    );

    logger.info("🏆 Post of the Month selected based on upvotes", {
        postId: winnerPost.id,
        permalink: winnerPost.permalink,
        score: winnerPost.score,
    });

    // Apply flair
    await context.reddit.setPostFlair({
        subredditName,
        postId: winnerPost.id,
        text: postOfTheMonthFlairText,
        cssClass: postOfTheMonthCSSClass,
        flairTemplateId: postOfTheMonthFlairTemplate,
    });

    logger.info("🏷️ Post of the Month flair applied", {
        postId: winnerPost.id,
        postOfTheMonthFlairText,
        postOfTheMonthFlairTemplate,
        cssClass: postOfTheMonthCSSClass,
    });

    // TODO: FIX THIS IF IT SEEMS NECESSARY TO DO SO
    // // ──────────────── APPEND NEW POSTS TO WIKI TABLE ────────────────
    // for (const post of allPosts) {
    //     const now = new Date();
    //     const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    //     const day = String(now.getUTCDate()).padStart(2, "0");
    //     const year = now.getUTCFullYear();
    //     const date = `${month}-${day}-${year}`; // MM-DD-YYYY

    //     const postLink = `https://reddit.com${post.permalink}`;
    //     const authorName = post.authorName;

    //     // content += `| ${date} | [${post.title}](${postLink}) | /u/${authorName} |\n`;
    //     content += `| 02-05-2026 | test2 | /u/${authorName} |\n`;
    // }

    // // ──────────────── CREATE OR UPDATE WIKI PAGE ────────────────
    // try {
    //     if (!existingPage) {
    //         await safeWiki.createWikiPage({
    //             subredditName,
    //             page: trackingPage,
    //             content,
    //             reason: "Initial Post of the Month wiki page setup",
    //         });
    //         logger.info("✅ Created Post of the Month wiki page", {
    //             trackingPage,
    //         });
    //     } else {
    //         await context.reddit.updateWikiPage({
    //             subredditName,
    //             page: trackingPage,
    //             content,
    //             reason: `Append new Post of the Month entry`,
    //         });
    //         logger.info("✅ Post of the Month wiki page updated", {
    //             trackingPage,
    //             newPosts: allPosts.map(p => p.id),
    //         });
    //     }
    // } catch (err) {
    //     logger.error("❌ Failed to create/update Post of the Month wiki page", {
    //         trackingPage,
    //         error: String(err),
    //     });
    // }
}
