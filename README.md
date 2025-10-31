RepBot is an app that allows users to award reputation points if a user has been helpful. Its main use case is for help and advice subreddits to help indicate users who have a track record of providing useful solutions.

It allows the OP of a post, a mod, or a trusted user to reply to a user and award them a point using a bot command, which will be stored as their user flair (optional) and stored in a data store. The command can be customisable (by default it is `!award` and `.award`).

The app gets triggered when a comment is posted or edited, but only never award points twice per comment. It triggers on edit to give the user chance to amend a comment to add the "thanks" command if they forget initially.

You can also set an optional post flair if a point is awarded, such as to mark the question as "Resolved".

## Limitations

* The optional leaderboard will not pull in points for users until this app awards one. If you have previously used /u/Clippy_Office_Asst or a similar bot to award reputation points in the past, this will make the leaderboard misleading unless you restore from a backup.
* For flair setting options, if you specify both a CSS class and a flair template, the flair template will be used.

## Suggestions

You may wish to create an automod rule that detects phrases like "thank you" and similar in comments that do not have the trigger command, and reply suggesting that they use the command.

I strongly recommend using a command that is not going to be used in "normal" comments, to avoid awarding points accidentally. If you use a prefix e.g. !award or /award, you will reduce the risk of accidental points awarding.

I recommend testing settings out on a test subreddit before deploying to a real subreddit for the first time.

## Data Stored

This application stores the reputation score awarded by the app for each user in a Redis data store and (if configured) as the user's flair. It also stores a record that a comment has had a point awarded on it for a period of a week after that point is awarded.

If the application is removed from a subreddit, all data is deleted although the flairs will remain. If the application is subsequently re-installed, the existing flairs will be used as a basis for new point awarding.

## Acknowledgements

[Code edited from u/fsv's reputatorbot](https://github.com/fsvreddit/reputatorbot).

## About

This app is open source and licensed under the BSD 3-Clause License. You can find the source code on GitHub [here](https://github.com/the-gdmo/TheRepBot).

NOTE: If you update settings, you will have to uninstall to be able to reimplement the content that you want in whatever you are editing.

## Version History
### 13.0.1
* Update help page to use the old reddit version of the page
### 13.0.0
* Make point setting actually update the redisKey for the user so that their score is actually updated instead of just saying it is
### 12.3.0
* Make it so users are informed in private messages if they use alt text (`this`), spoiler text(>!this!<), or quote text(> this) when using an award command
* Make it so users can stop the bot from informing them of using these spoiler types (must be done on individual types as they are used)
### 12.2.0
* Made leaderboard links using the {{scoreboard}} placeholder link to the Old Reddit version of that link (New Reddit can be weird with wiki pages not being created or displayed)
* Simplify leaderboard logic
### 12.1.0
* Make it so users can use a link to their subreddit's discord
* Simplify wiki page declaration for specifying what page explains the point system (no longer requires full link)
* Add setting to set a default message to send on OP's first post if point awarding is required for OPs (cannot be empty even if point awarding isn't required)
* If point awarding is required, the above message will be pinned on OP's post
### 13.0.0
* Reimplement code to properly edit the leaderboard wiki page
### 12.0.0
* Remove {{flair}} placeholder from being usable in the award requirement message
### 11.0.0
* Make it so that it can be toggled whether or not mods have the award requirement associated with them if point awarding is required
### 10.0.0
* Make it so that a user's flair can be set to force them to award points on their own post before being allowed to make new posts
* Add a toggle for whether or not to enable the feature mentioned above
* Make it possible to permalink to the author's most recent valid post
* Make it possible for moderators to remove the post restriction from a user
* Allow a template to tell the user they must award points on their most recent valid post to remove the restricted posting flair
* Make a customizable message that the bot will send on new posts to inform users of how the restriction system works
### 9.0.0
* Make it so a user can only receive a point once per comment
### 8.0.0
* Make it so a user's score can be set to 0
* Update code so that the leaderboard will be set and updated when a user receives a point or their score is manually updated
### 7.0.1
* Forgot to save README (oops!)
### 7.0.0
* Make it so the comment made by the bot on the custom post can be locked or unlocked by the person making the post in the post UI
### 6.0.0
* Lock the comment made by the bot on the leaderboard custom post
### 5.0.0
* Make it possible to create a leaderboard post that can be refreshed by anyone at any time if a user presses the refresh button
* Append a message to leaderboard custom post that informs the user how to refresh the data if it doesn't appear for them
### 4.0.0
* Make it so comments with trigger commands that are in spoiler text won't trigger
### 3.0.0
* Make it so comments with trigger commands that are in a quote or alt text block won't trigger
### 2.0.0
* Make it so non-trigger comments won't trigger the bot's responses
### 0.0.28
* Make it so the bot doesn't lock its comments on responses
### 0.0.27
* Fix formatting with where the "how to award points" message appears
### 0.0.26
* Move "how to award points" message to top of leaderboard wiki page
### 0.0.25
* Make it so that leaderboard will dynamically update if a user's score changes
* Put in the above patch note for 0.0.24
### 0.0.23
* Properly implement manual score setting
### 0.0.22
* Remove deny command (can't get it to work)
### 0.0.21
* Update to most recent devvit version
### 0.0.20
* Update to try and publish publicly
* Remove unnecessary/unused files
### 0.0.19
* Remove manual point setting (can't get it to work)
### 0.0.18
* Make it so that backup and restore methods aren't available to mods
### 0.0.17
* Remove unused code
* Remove incorrect information from README
### 0.0.15
* Add and implement various components to further expand on what the bot can do
* Make it so the bot can't be awarded
* Make it so non-superusers and non-mods can't use the mod award command
* Remove leaderboard post (can't get it to accurately display users' scores)
### 0.0.14
* Try to make the leaderboard post accurately display the top scoring users
### 0.0.13
* Make it so only the all time leaderboard appears (can't figure out how to do every leaderboard)
* Make it so that flair is properly set
* Make it so that leaderboard doesn't link to individual user pages anymore
* Leaderboard now uses user flair to update the leaderboard
### 0.0.12
* Update README to be more accurate
### 0.0.11
* Fix incorrect version number for 0.0.10
### 0.0.10
* Remove daily, weekly, monthly, and yearly leaderboards for now to try and fix it.
### 0.0.9
* Make it so that users can select if they use an all-time leaderboard only or daily, weekly, monthly, yearly, and all-time leaderboards (this part is a WIP).
### 0.0.8
* Make it so the bot can actually send the user messages
* Improve code for functionality
* Make it so the symbol can be added to a user's flair if a symbol is specified
### 0.0.7
* Fixed a typo in v0.0.6 (used TheRepBot instead of reputatorbot in acknowledgements)
### 0.0.6
* Kept bits of code from TheRepBot while implementing custom code
* Set up a baseline for what should be used
* Implemented daily, weekly, monthly, yearly, and alltime leaderboards
* Made code work as intended as much as possible
* Note that this bot's source code has changed since this README/project was first created and is why these notes may seem weird with what the code shows
### 0.0.5
* Add more customizability to various messages
* Allow awards to be allowed/not on unflaired posts as specified by app 
* Add more options to customizability
* Make it so that various placeholders work and the scoreboard appears as intended
* NOTE: THE SCOREBOARD IS BUGGY AND STILL A WORK-IN-PROGRESS
### 0.0.2
* Improved text explanations for what various entries are for
### 0.0.1
* Getting base code out