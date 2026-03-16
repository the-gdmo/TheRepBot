RepBot is an app that allows users to award reputation points if a user has been helpful. Its main use case is for help and advice subreddits to help indicate users who have a track record of providing useful solutions.

It allows the OP of a post, a mod, or a trusted user to reply to a user and award them a point using a bot command, which will be stored as their user flair (optional) and stored in a data store. The command can be customisable (by default it is `!award` and `.award`).

The app gets triggered when a comment is posted or edited, but only never award points twice per comment. It triggers on edit to give the user chance to amend a comment to add the "thanks" command if they forget initially.

You can also set an optional post flair if a point is awarded, such as to mark the question as "Resolved".

## Limitations

* The optional leaderboard will not pull in points for users until this app awards one. If you have previously used /u/Clippy_Office_Asst or a similar bot to award reputation points in the past, this will make the leaderboard misleading.
* For flair setting options, if you specify both a CSS class and a flair template, the flair template will be used.

## Suggestions

You may wish to create an automod rule that detects phrases like "thank you" and similar in comments that do not have the trigger command, and reply suggesting that they use the command.

I strongly recommend using a command that is not going to be used in "normal" comments, to avoid awarding points accidentally. If you use a prefix e.g. !award or /award, you will reduce the risk of accidental points awarding.

I recommend testing settings out on a test subreddit before deploying to a real subreddit for the first time.

## Supported Placeholders
* `{{author}}`: The username of the poster. Will not contain 'u/'.
* `{{requirement}}`: The amount of points required before a posting restriction is lifted.
* `{{name}}`: The name of points. Specified in 'Point Name'.
* `{{permalink}}`: Link to the most recent valid post by the poster.
* `{{title}}`: The title of the most recent valid post by the poster.
* `{{symbol}}`: The symbol associated with your subreddit installation. Specified in 'Point Symbol'.
* `{{awardee}}`: The user being awarded. Will not contain 'u/'.
* `{{awarder}}`: The user giving the award. Will not contain 'u/'.
* `{{total}}`: The total amount of points a user has.
* `{{helpPage}}`: Link to a page explaining how to use the bot. Uses the Old Reddit version of this page.
* `{{leaderboard}}`: Link to a page of the subreddit's leaderboard. Uses the Old Reddit version of this page.
* `{{threshold}}`: Threshold to become a superuser. Specified in 'Auto Superuser Threshold'.
* `{{command}}`: Notifies the user who has reached the threshold of a special command they can use. Specified in 'Superuser/Mod award command'.
* `{{commands}}`: Lists all valid non-superuser/non-mod command(s) (comma-separated list (if more than 1)). Specified in 'Trigger Words'. 
* `{{markdown_guide}}`: Link to Reddit's Markdown Guide.
* `{{user}}`: The username of the person being awarded. Used in 'Alternate Award Command'.
* `{{altCommand}}`: Alternate command to directly award users. Used in 'Alternate Command Success/Fail Message'.
* `{{subreddit}}`: Get the name of the subreddit. Will not contain 'r/'.
* `{{awardeePage}}`: Link to a recipient's individual page. Logs all points received and given that are not alternate commands.
* `{{awarderPage}}`: Link to an awarder's individual page. Logs all points received and given that are not alternate commands.

## Data Stored

This application stores the reputation score awarded by the app for each user in a Redis data store and (if configured) as the user's flair. It also stores a record that a comment has had a point awarded on it for a period of a week after that point is awarded.

If the application is removed from a subreddit, all data is deleted although the flairs will remain. If the application is subsequently re-installed, the existing flairs will be used as a basis for new point awarding.

## Acknowledgements

[Code edited from u/fsv's reputatorbot](https://github.com/fsvreddit/reputatorbot).

## About

This app is open source and licensed under the BSD 3-Clause License. You can find the source code on GitHub [here](https://github.com/the-gdmo/TheRepBot).

NOTE: If you remove the app from your subreddit, it will delete all data and you will have to manually restore it to users. 

## Version History
### 24.0.0
* Massive refactoring of code and custom post to work with Devvit Web with help from u/Beach-Brews
### 23.0.0
* Fix trigger calls so that new comments will be registered by thanks event (doesn't work correctly USE 24.0.0 or later)
### 22.1.0
* Make it so mods can only make the leaderboard post if the users displayed is 20 or less
* Make sure that RepBot can't be restricted by new leaderboard posts regardless of whether or not mods are exempt from awarding
### 22.0.0
* Update to latest devvit version
### 21.0.1
* Separate mod award logic from trusted user so people can tell whether it is a mod or superuser using the mod/trusted user award command
* Add settings to supplement this
### 20.0.1
* Update to latest devvit version
* Lock all comments related to the awarding process (ie awarder's comment, comment being awarded, and the bot's response)
### 19.2.0
* Fix dming logic (previous would infinitely loop even if you confirmed your intent)