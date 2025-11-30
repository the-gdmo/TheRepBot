import {
    JSONObject,
    ScheduledJobEvent,
    SettingsFormField,
    SettingsFormFieldValidatorEvent,
    TriggerContext,
} from "@devvit/public-api";
import { VALIDATE_REGEX_JOB } from "./constants.js";
import { selectorFromJSON } from "@devvit/protos/types/devvit/options/options.js";

export enum ExistingFlairOverwriteHandling {
    OverwriteNumericSymbol = "overwritenumericsymbol",
    OverwriteNumeric = "overwritenumeric",
    NeverSet = "neverset",
}

export enum LeaderboardMode {
    Off = "off",
    ModOnly = "modonly",
    Public = "public",
}

export enum AppSetting {
    AlternatePointCommandUsers = "alternatePointCommandUsers",
    AwardsRequiredToCreateNewPosts = "awardsRequiredToCreateNewPosts",
    NotifyOnRestorePoints = "notifyOnRestorePoints",
    RestorePointsCommand = "restorePointsCommand",
    PointsRestoredMessage = "pointsRestoredMessage",
    NotifyOnSelfAward = "notifyOnSelfAward",
    NotifyUsersWhenAPointIsAwarded = "notifyUsersWhenAPointIsAwarded",
    UsersWhoCannotAwardPointsMessage = "usersWhoCannotAwardPointsMessage",
    ThanksCommandUsesRegex = "thanksCommandUsesRegex",
    ModAwardCommand = "approveCommand",
    SuperUsers = "superUsers",
    AutoSuperuserThreshold = "autoSuperuserThreshold",
    NotifyOnAutoSuperuser = "notifyOnAutoSuperuser",
    NotifyOnAutoSuperuserTemplate = "notifyOnAutoSuperuserTemplate",
    NotifyUsersWhoCannotAwardPoints = "notifyUsersWhoCannotAwardPoints",
    UsersWhoCannotAwardPoints = "usersWhoCantAwardPoints",
    ExistingFlairHandling = "existingFlairHandling",
    ExistingFlairCosmeticHandling = "existingFlairCosmeticHandling",
    CSSClass = "thanksCSSClass",
    FlairTemplate = "thanksFlairTemplate",
    NotifyOnSuccess = "notifyOnSuccess",
    NotifyOnSuccessTemplate = "notifyOnSuccessTemplate",
    SetPostFlairOnThanks = "setPostFlairOnThanks",
    SetPostFlairText = "setPostFlairOnThanksText",
    SetPostFlairCSSClass = "setPostFlairOnThanksCSSClass",
    SetPostFlairTemplate = "setPostFlairOnThanksTemplate",
    LeaderboardMode = "leaderboardMode",
    LeaderboardName = "leaderboardName",
    LeaderboardSize = "leaderboardSize",
    PointSystemHelpPage = "pointSystemHelpPage",
    PostFlairTextToIgnore = "postFlairTextToIgnore",
    PrioritiseScoreFromFlair = "prioritiseScoreFromFlair",
    PointTriggerWords = "pointTriggerWords",
    SuccessMessage = "successMessage",
    SelfAwardMessage = "selfAwardMessage",
    DuplicateAwardMessage = "duplicateAwardMessage",
    BotAwardMessage = "botAwardMessage",
    PointName = "pointName",
    DisallowedFlairs = "disallowedFlairs",
    DisallowedFlairMessage = "disallowedFlairMessage",
    InvalidPostMessage = "invalidPostMessage",
    ApproveMessage = "approveMessage",
    PointSymbol = "pointSymbol",
    AccessControl = "accessControl",
    ModOnlyDisallowedMessage = "modOnlyDisallowedMessage",
    ApprovedOnlyDisallowedMessage = "approvedOnlyDisallowedMessage",
    AllowUnflairedPosts = "allowUnflairedPosts",
    UnflairedPostMessage = "unflairedPostMessage",
    OPOnlyDisallowedMessage = "opOnlyDisallowedMessage",
    NotifyOnPointAlreadyAwarded = "notifyOnPointAlreadyAwarded",
    NotifyOnDuplicateAward = "notifyOnDuplicateAward",
    NotifyOnBotAward = "notifyOnBotAward",
    NotifyOnApprove = "notifyOnApprove",
    NotifyOnModOnlyDisallowed = "notifyOnModOnlyDisallowed",
    NotifyOnApprovedOnlyDisallowed = "notifyOnApprovedOnlyDisallowed",
    NotifyOnOPOnlyDisallowed = "notifyOnOPOnlyDisallowed",
    NotifyOnDisallowedFlair = "notifyOnDisallowedFlair",
    NotifyOnUnflairedPost = "notifyOnUnflairedPost",
    ModeratorsExempt = "moderatorsExempt",
    MessageToRestrictedUsers = "messageToRestrictedUsers",
    DiscordServerLink = "discordServerLink",
    AlternateCommandSuccessMessage = "alternateCommandSuccessMessage",
    AlternateCommandFailMessage = "AlternateCommandFailMessage",
    NotifyOnAlternateCommandFail = "notifyOnAlternateCommandFail",
    NotifyOnAlternateCommandSuccess = "notifyOnAlternateCommandSuccessMessage",
    NotifyOnPointAlreadyAwardedToUser = "notifyOnPointAlreadyAwardedToUser",
    PointAlreadyAwardedToUserMessage = "notifyOnPointAlreadyAwardedToUserMessage",
    SubsequentPostRestrictionMessage = "subsequentPostRestrictionMessage",
    ModAwardCommandSuccess = "modAwardCommandSuccess",
    ModAwardCommandFail = "modAwardCommandFail",
    NotifyOnModAwardSuccess = "notifyOnModAwardSuccess",
    NotifyOnModAwardFail = "notifyOnModAwardFail",
    ModAwardAlreadyGiven = "modAwardAlreadyGiven",
    UsernameLengthMessage = "usernameLengthMessage",
    NoUsernameMentionMessage = "noUsernameMentionMessage",
    RestrictionRemovedMessage = "restrictionRemovedMessage",
    NotifyOnRestrictionLifted = "notifyOnRestrictionLifted",
    InvalidUsernameMessage = "invalidUsernameMessage",
}

export enum TemplateDefaults {
    SubsequentPostRestrictionMessage = "***ATTENTION to OP:*** You must award {{name}}s by replying to the successful comments. Before you can create new posts, you must award **{{requirement}}** {{name}}s to users who respond on [{{title}}]({{permalink}}).",
    UnflairedPostMessage = "Points cannot be awarded on posts without flair. Please award only on flaired posts.",
    OPOnlyDisallowedMessage = "Only moderators, approved users, and Post Authors (OPs) can award {{name}}s.",
    LeaderboardHelpPageMessage = "[How to award points with RepBot.]({{helpPage}})",
    DisallowedFlairMessage = "Points cannot be awarded on posts with this flair. Please choose another post.",
    UsersWhoCannotAwardPointsMessage = "You do not have permission to award {{name}}s.",
    ModOnlyDisallowedMessage = "Only moderators are allowed to award points.",
    ApprovedOnlyDisallowedMessage = "Only moderators and approved users can award points.",
    DuplicateAwardMessage = "This comment has already been awarded a {{name}}.",
    SelfAwardMessage = "You can't award yourself a {{name}}.",
    BotAwardMessage = "You can't award u/TheRepBot a {{name}}.",
    InvalidPostMessage = "Points cannot be awarded on this post because the recipient is suspended or shadowbanned.",
    NotifyOnSelfAwardTemplate = "Hello {{awarder}}, you cannot award a {{name}} to yourself.",
    NotifyOnSuccessTemplate = "+1 {{name}} awarded to u/{{awardee}} by u/{{awarder}}. Total: {{total}}{{symbol}}. {{awardee}}'s user page is located [here]({{awardeePage}}). Leaderboard is located [here]({{leaderboard}}).",
    NotifyOnSuperuserTemplate = 'Hello {{awardee}},\n\nNow that you have reached {{threshold}} points you can now award points yourself, even if normal users do not have permission to. Please use the command "{{command}}" if you\'d like to do this.',
    MessageToRestrictedUsers = "***ATTENTION to OP: You must award {{name}}s by replying to the successful comments. Valid command(s) are **{{commands}}**. Failure to do so may result in a ban.***\n\n***Commenters MUST put the location in spoiler tags.***\n\n*To hide text, write it like this `>!Text goes here!<` = >!Text goes here!<. [Reddit Markdown Guide]({{markdown_guide}})*.",
    AlternateCommandSuccessMessage = "+1 {{name}} awarded to u/{{awardee}} [{{total}}{{symbol}}]. {{awardee}}'s user page is located [here]({{awardeePage}}). Leaderboard is located [here]({{leaderboard}}).",
    AlternateCommandFailMessage = "You do not have permission to use **{{altCommand}}** on specific users.",
    PointAlreadyAwardedToUserMessage = "{{awardee}} has already received a {{name}} for this post.",
    ModAwardCommandSuccessMessage = "Moderator u/{{awarder}} gave an award! u/{{awardee}} now has {{total}}{{symbol}} {{name}}s. {{awardee}}'s user page is located [here]({{awardeePage}}). Leaderboard is located [here]({{leaderboard}}).",
    ModAwardCommandFailMessage = "Hello {{awarder}}. You must be a moderator or trusted user to use {{command}}.",
    ModAwardAlreadyGivenMessage = "{{awardee}} has already received a mod award for this comment.",
    UsernameLengthMessage = "***{{awardee}}*** is not valid. Reddit usernames are between 3 and 21 characters long.",
    InvalidUsernameMessage = "Your target is not valid. Reddit usernames contain only letters, numbers, hyphens, and underscores.",
    NoUsernameMentionMessage = "You must mention a user (eg u/{{awardee}}) to award specific users.",
    RestrictionRemovedMessage = "Your posting restriction has been removed. You now have permission to make a post again!",
}

export enum AutoSuperuserReplyOptions {
    NoReply = "none",
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

export enum NotifyOpOnPostRestrictionReplyOptions {
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

export enum NotifyOnPointAlreadyAwardedReplyOptions {
    NoReply = "none",
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

export enum NotifyOnModApproveReplyOptions {
    NoReply = "none",
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

export enum NotifyOnModOnlyDisallowedReplyOptions {
    NoReply = "none",
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

export enum NotifyOnRestrictionLiftedReplyOptions {
    NoReply = "none",
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

export enum NotifyOnApprovedOnlyDisallowedReplyOptions {
    NoReply = "none",
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

export enum NotifyOnOPOnlyDisallowedReplyOptions {
    NoReply = "none",
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

export enum NotifyOnDisallowedFlairReplyOptions {
    NoReply = "none",
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

export enum NotifyOnInvalidPostReplyOptions {
    NoReply = "none",
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

export enum NotifyOnUnflairedPostReplyOptions {
    NoReply = "none",
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

export enum NotifyOnSuccessReplyOptions {
    NoReply = "none",
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

export enum NotifyOnAlternateCommandFailReplyOptions {
    NoReply = "none",
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

export enum NotifyOnAlternateCommandSuccessReplyOptions {
    NoReply = "none",
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

export enum PointAwardedReplyOptions {
    NoReply = "none",
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

export enum NotifyOnSelfAwardReplyOptions {
    NoReply = "none",
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

export enum NotifyUsersWhoCannotAwardPointsReplyOptions {
    NoReply = "none",
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

export enum NotifyOnBotAwardReplyOptions {
    NoReply = "none",
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

const NotifyOnPointAlreadyAwardedReplyOptionChoices = [
    {
        label: "No Notification",
        value: NotifyOnPointAlreadyAwardedReplyOptions.NoReply,
    },
    {
        label: "Send user a private message",
        value: NotifyOnPointAlreadyAwardedReplyOptions.ReplyByPM,
    },
    {
        label: "Reply as comment",
        value: NotifyOnPointAlreadyAwardedReplyOptions.ReplyAsComment,
    },
];

export const NotifyOnRestrictionLiftedReplyOptionChoices = [
    {
        label: "No Notification",
        value: NotifyOnRestrictionLiftedReplyOptions.NoReply,
    },
    {
        label: "Send user a private message",
        value: NotifyOnRestrictionLiftedReplyOptions.ReplyByPM,
    },
    {
        label: "Reply as comment",
        value: NotifyOnRestrictionLiftedReplyOptions.ReplyAsComment,
    },
];

const NotifyUsersWhoCannotAwardPointsReplyOptionChoices = [
    {
        label: "No Notification",
        value: NotifyUsersWhoCannotAwardPointsReplyOptions.NoReply,
    },
    {
        label: "Send user a private message",
        value: NotifyUsersWhoCannotAwardPointsReplyOptions.ReplyByPM,
    },
    {
        label: "Reply as comment",
        value: NotifyUsersWhoCannotAwardPointsReplyOptions.ReplyAsComment,
    },
];

const NotifyOnBotAwardReplyOptionChoices = [
    {
        label: "Send user a private message",
        value: NotifyOnBotAwardReplyOptions.ReplyByPM,
    },
    {
        label: "Reply as comment",
        value: NotifyOnBotAwardReplyOptions.ReplyAsComment,
    },
];

const NotifyOnModApproveReplyOptionChoices = [
    { label: "No Notification", value: NotifyOnModApproveReplyOptions.NoReply },
    {
        label: "Send user a private message",
        value: NotifyOnModApproveReplyOptions.ReplyByPM,
    },
    {
        label: "Reply as comment",
        value: NotifyOnModApproveReplyOptions.ReplyAsComment,
    },
];

const NotifyOnModOnlyDisallowedReplyOptionChoices = [
    {
        label: "No Notification",
        value: NotifyOnModOnlyDisallowedReplyOptions.NoReply,
    },
    {
        label: "Send user a private message",
        value: NotifyOnModOnlyDisallowedReplyOptions.ReplyByPM,
    },
    {
        label: "Reply as comment",
        value: NotifyOnModOnlyDisallowedReplyOptions.ReplyAsComment,
    },
];

const NotifyOnApprovedOnlyDisallowedReplyOptionChoices = [
    {
        label: "No Notification",
        value: NotifyOnApprovedOnlyDisallowedReplyOptions.NoReply,
    },
    {
        label: "Send user a private message",
        value: NotifyOnApprovedOnlyDisallowedReplyOptions.ReplyByPM,
    },
    {
        label: "Reply as comment",
        value: NotifyOnApprovedOnlyDisallowedReplyOptions.ReplyAsComment,
    },
];

const NotifyOnOPOnlyDisallowedReplyOptionChoices = [
    {
        label: "No Notification",
        value: NotifyOnOPOnlyDisallowedReplyOptions.NoReply,
    },
    {
        label: "Send user a private message",
        value: NotifyOnOPOnlyDisallowedReplyOptions.ReplyByPM,
    },
    {
        label: "Reply as comment",
        value: NotifyOnOPOnlyDisallowedReplyOptions.ReplyAsComment,
    },
];

const NotifyOnDisallowedFlairReplyOptionChoices = [
    {
        label: "No Notification",
        value: NotifyOnDisallowedFlairReplyOptions.NoReply,
    },
    {
        label: "Send user a private message",
        value: NotifyOnDisallowedFlairReplyOptions.ReplyByPM,
    },
    {
        label: "Reply as comment",
        value: NotifyOnDisallowedFlairReplyOptions.ReplyAsComment,
    },
];

const NotifyOnUnflairedPostReplyOptionChoices = [
    {
        label: "No Notification",
        value: NotifyOnUnflairedPostReplyOptions.NoReply,
    },
    {
        label: "Send user a private message",
        value: NotifyOnUnflairedPostReplyOptions.ReplyByPM,
    },
    {
        label: "Reply as comment",
        value: NotifyOnUnflairedPostReplyOptions.ReplyAsComment,
    },
];

const NotifyOnSelfAwardReplyOptionChoices = [
    { label: "No Notification", value: NotifyOnSelfAwardReplyOptions.NoReply },
    {
        label: "Send user a private message",
        value: NotifyOnSelfAwardReplyOptions.ReplyByPM,
    },
    {
        label: "Reply as comment",
        value: NotifyOnSelfAwardReplyOptions.ReplyAsComment,
    },
];

const NotifyOnAlternateCommandFailReplyOptionChoices = [
    {
        label: "No Notification",
        value: NotifyOnAlternateCommandFailReplyOptions.NoReply,
    },
    {
        label: "Send user a private message",
        value: NotifyOnAlternateCommandFailReplyOptions.ReplyByPM,
    },
    {
        label: "Reply as comment",
        value: NotifyOnAlternateCommandFailReplyOptions.ReplyAsComment,
    },
];

const NotifyOnAlternateCommandSuccessReplyOptionChoices = [
    {
        label: "No Notification",
        value: NotifyOnAlternateCommandSuccessReplyOptions.NoReply,
    },
    {
        label: "Send user a private message",
        value: NotifyOnAlternateCommandSuccessReplyOptions.ReplyByPM,
    },
    {
        label: "Reply as comment",
        value: NotifyOnAlternateCommandSuccessReplyOptions.ReplyAsComment,
    },
];

const NotifyOnSuccessReplyOptionChoices = [
    { label: "No Notification", value: NotifyOnSuccessReplyOptions.NoReply },
    {
        label: "Send user a private message",
        value: NotifyOnSuccessReplyOptions.ReplyByPM,
    },
    {
        label: "Reply as comment",
        value: NotifyOnSuccessReplyOptions.ReplyAsComment,
    },
];

const AccessControlOptionChoices = [
    {
        label: "Moderators Only",
        value: "moderators-only",
    },
    {
        label: "Moderators and Approved Users",
        value: "moderators-and-superusers",
    },
    {
        label: "Moderators, Approved Users, and Post Author (OP)",
        value: "moderators-superusers-and-op",
    },
    {
        label: "Everyone",
        value: "everyone",
    },
];

const LeaderboardModeOptionChoices = [
    { label: "Off", value: LeaderboardMode.Off },
    { label: "Mod Only", value: LeaderboardMode.ModOnly },
    {
        label: "Default settings for wiki",
        value: LeaderboardMode.Public,
    },
];

export enum NotifyOnPointAlreadyAwardedToUserReplyOptions {
    NoReply = "none",
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

const NotifyOnPointAlreadyAwardedToUserOptionChoices = [
    {
        label: "No Notification",
        value: NotifyOnPointAlreadyAwardedToUserReplyOptions.NoReply,
    },
    {
        label: "Send user a private message",
        value: NotifyOnPointAlreadyAwardedToUserReplyOptions.ReplyByPM,
    },
    {
        label: "Reply as comment",
        value: NotifyOnPointAlreadyAwardedToUserReplyOptions.ReplyAsComment,
    },
];

export enum NotifyOnModAwardSuccessReplyOptions {
    NoReply = "none",
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

export enum NotifyOnModAwardFailReplyOptions {
    NoReply = "none",
    ReplyByPM = "replybypm",
    ReplyAsComment = "replybycomment",
}

const NotifyOnModAwardSuccessOptionChoices = [
    {
        label: "No Notification",
        value: NotifyOnModAwardSuccessReplyOptions.NoReply,
    },
    {
        label: "Send user a private message",
        value: NotifyOnModAwardSuccessReplyOptions.ReplyByPM,
    },
    {
        label: "Reply as comment",
        value: NotifyOnModAwardSuccessReplyOptions.ReplyAsComment,
    },
];

const NotifyOnModAwardFailOptionChoices = [
    {
        label: "No Notification",
        value: NotifyOnModAwardFailReplyOptions.NoReply,
    },
    {
        label: "Send user a private message",
        value: NotifyOnModAwardFailReplyOptions.ReplyByPM,
    },
    {
        label: "Reply as comment",
        value: NotifyOnModAwardFailReplyOptions.ReplyAsComment,
    },
];

const ExistingFlairHandlingOptionChoices = [
    {
        label: "Set flair to new score, if flair unset or flair is numeric (With Symbol)",
        value: ExistingFlairOverwriteHandling.OverwriteNumericSymbol,
    },
    {
        label: "Set flair to new score, if flair unset or flair is numeric (Without Symbol)",
        value: ExistingFlairOverwriteHandling.OverwriteNumeric,
    },
    {
        label: "Never set flair",
        value: ExistingFlairOverwriteHandling.NeverSet,
    },
];

const NotifyOnAutoSuperuserReplyOptionChoices = [
    { label: "No Notification", value: AutoSuperuserReplyOptions.NoReply },
    {
        label: "Send user a private message",
        value: AutoSuperuserReplyOptions.ReplyByPM,
    },
    {
        label: "Reply as comment",
        value: AutoSuperuserReplyOptions.ReplyAsComment,
    },
];

export const appSettings: SettingsFormField[] = [
    // === POINT SYSTEM ===
    {
        type: "group",
        label: "Post Management Settings",
        helpText:
            "Settings to force point awarding before OP can create new posts",
        fields: [
            {
                type: "number",
                name: AppSetting.AwardsRequiredToCreateNewPosts,
                label: "Awards required to create new posts",
                helpText:
                    "Amount of awarded points required before a user can make a new post. Set to 0 to disable.",
                defaultValue: 0,
                onValidate: numberFieldHasValidOption,
            },
            {
                type: "boolean",
                name: AppSetting.ModeratorsExempt,
                label: "Moderators Exempt",
                helpText:
                    "Decide whether or not point awarding is required for moderators as well",
                defaultValue: true,
            },
            {
                type: "paragraph",
                name: AppSetting.MessageToRestrictedUsers,
                label: "Initial Post Restriction Message",
                helpText:
                    "Sent on initial post. Required even if not used. Placeholders Supported: {{name}}, {{commands}}, {{markdown_guide}}, {{subreddit}}, {{helpPage}}, {{discord}}",
                defaultValue: TemplateDefaults.MessageToRestrictedUsers,
                onValidate: paragraphFieldContainsText,
            },
            {
                name: AppSetting.SubsequentPostRestrictionMessage,
                type: "paragraph",
                label: "Subsequent Post Restriction Message",
                helpText:
                    "Required even if not used. Message to send users when they try to post while restricted from posting. Placeholders supported: {{permalink}}, {{title}}, {{name}}, {{commands}}, {{helpPage}}",
                defaultValue: TemplateDefaults.SubsequentPostRestrictionMessage,
                onValidate: paragraphFieldContainsText,
            },
        ],
    },
    {
        type: "group",
        label: "Point System Settings",
        fields: [
            {
                type: "select",
                name: AppSetting.AccessControl,
                label: "Who can award points?",
                helpText: "Choose who is allowed to award points",
                options: AccessControlOptionChoices,
                defaultValue: ["moderators-superusers-and-op"],
                onValidate: selectFieldHasOptionChosen,
            },
            {
                type: "paragraph",
                name: AppSetting.PointTriggerWords,
                label: "Trigger Words",
                helpText:
                    "List of trigger words users can type to award points (e.g., !award, .point). Each command should be on a new line. If you want to use regex, enable the option below",
                defaultValue: "!award\n.award",
                onValidate: noValidTriggerWords,
            },
            {
                name: AppSetting.ThanksCommandUsesRegex,
                type: "boolean",
                label: "Treat user commands as regular expressions",
                defaultValue: false,
                onValidate: validateRegexes,
            },
            {
                name: AppSetting.NotifyOnRestrictionLifted,
                type: "select",
                label: "Notify on post restriction removal",
                helpText:
                    "Choose how the bot should notify users when their posting restriction is fully removed.",
                options: NotifyOnRestrictionLiftedReplyOptionChoices,
                multiSelect: false,
                defaultValue: [NotifyOnRestrictionLiftedReplyOptions.NoReply],
                onValidate: selectFieldHasOptionChosen,
            },
            {
                name: AppSetting.RestrictionRemovedMessage,
                type: "paragraph",
                label: "Message to send the user when their restriction is removed",
                helpText: "Required even if not used. Placeholders Supported: {{awarder}}, {{subreddit}}, {{requirement}}, {{name}}, {{helpPage}}, {{discord}}",
                defaultValue: TemplateDefaults.RestrictionRemovedMessage,
                onValidate: paragraphFieldContainsText,
            },
            {
                type: "string",
                name: AppSetting.PointName,
                label: "Point Name",
                helpText:
                    "Singular form of the name shown in award messages, like 'point', 'kudo', etc. Lowercase is recommended",
                defaultValue: "point",
            },
            {
                type: "string",
                name: AppSetting.PointSymbol,
                label: "Point Symbol",
                helpText:
                    "Optional emoji or character to show alongside point totals. Leave empty for no symbol",
            },
            {
                type: "select",
                name: AppSetting.NotifyOnModOnlyDisallowed,
                label: "Notify users when only moderators can award points",
                options: NotifyOnModOnlyDisallowedReplyOptionChoices,
                defaultValue: [NotifyOnModOnlyDisallowedReplyOptions.NoReply],
                onValidate: selectFieldHasOptionChosen,
            },
            {
                type: "paragraph",
                name: AppSetting.ModOnlyDisallowedMessage,
                label: "Mod Only Disallowed Message",
                helpText:
                    "Message shown when a user tries to award a point but only moderators can award points",
                defaultValue: TemplateDefaults.ModOnlyDisallowedMessage,
                onValidate: paragraphFieldContainsText,
            },
            {
                type: "select",
                name: AppSetting.NotifyOnApprovedOnlyDisallowed,
                label: "Notify users when only moderators and approved users can award points",
                options: NotifyOnApprovedOnlyDisallowedReplyOptionChoices,
                defaultValue: [
                    NotifyOnApprovedOnlyDisallowedReplyOptions.NoReply,
                ],
                onValidate: selectFieldHasOptionChosen,
            },
            {
                type: "paragraph",
                name: AppSetting.ApprovedOnlyDisallowedMessage,
                label: "Approved Only Disallowed Message",
                helpText:
                    "Message shown when a user tries to award a point but only mods and approved users can award points",
                defaultValue: TemplateDefaults.ApprovedOnlyDisallowedMessage,
                onValidate: paragraphFieldContainsText,
            },
            {
                type: "select",
                name: AppSetting.NotifyOnOPOnlyDisallowed,
                label: "Notify Users When Only OP, Approved Users, And Moderators Can Award Points",
                options: NotifyOnOPOnlyDisallowedReplyOptionChoices,
                defaultValue: [NotifyOnOPOnlyDisallowedReplyOptions.NoReply],
                onValidate: selectFieldHasOptionChosen,
            },
            {
                type: "paragraph",
                name: AppSetting.OPOnlyDisallowedMessage,
                label: "OP Only Disallowed Message",
                helpText:
                    "Message shown when a user tries to award a point but only mods, approved users, and Post Authors (OPs) can award points",
                defaultValue: TemplateDefaults.OPOnlyDisallowedMessage,
                onValidate: paragraphFieldContainsText,
            },
            {
                type: "select",
                name: AppSetting.NotifyOnDisallowedFlair,
                label: "Notify users when they try to award points on a post with a disallowed flair",
                options: NotifyOnDisallowedFlairReplyOptionChoices,
                defaultValue: [NotifyOnDisallowedFlairReplyOptions.NoReply],
                onValidate: selectFieldHasOptionChosen,
            },
            {
                type: "paragraph",
                name: AppSetting.DisallowedFlairs,
                label: "Disallowed Flairs",
                helpText:
                    "Flairs where points cannot be awarded. Each flair should be on a new line",
            },
            {
                type: "paragraph",
                name: AppSetting.DisallowedFlairMessage,
                label: "Disallowed Flair Message",
                helpText:
                    "Message shown when a user tries to award points on a post with a disallowed flair",
                defaultValue: TemplateDefaults.DisallowedFlairMessage,
                onValidate: paragraphFieldContainsText,
            },
        ],
    },
    {
        type: "group",
        label: "Moderator/Trusted User Settings",
        fields: [
            {
                type: "paragraph",
                name: AppSetting.SuperUsers,
                label: "A list of trusted users other than mods who can award points",
                helpText: "Each username should be on a new line",
            },
            {
                name: AppSetting.InvalidUsernameMessage,
                type: "paragraph",
                label: "Message to send the user if a username contains invalid characters",
                defaultValue: TemplateDefaults.InvalidUsernameMessage,
                onValidate: paragraphFieldContainsText,
            },
            {
                name: AppSetting.UsernameLengthMessage,
                type: "paragraph",
                label: "Message to send the user if a username is too short or long to be valid",
                helpText: "Placeholders Supported: {{awarder}}, {{awardee}}",
                defaultValue: TemplateDefaults.UsernameLengthMessage,
                onValidate: paragraphFieldContainsText,
            },
            {
                name: AppSetting.NoUsernameMentionMessage,
                type: "paragraph",
                label: "Message to send the user if there isn't a username mentioned (ie, contains a u/)",
                helpText: "Placeholders Supported: {{awarder}}, {{awardee}}",
                defaultValue: TemplateDefaults.NoUsernameMentionMessage,
                onValidate: paragraphFieldContainsText,
            },
            {
                type: "select",
                name: AppSetting.NotifyOnAutoSuperuser,
                label: "Notify users who reach the auto trusted user threshold",
                options: NotifyOnAutoSuperuserReplyOptionChoices,
                multiSelect: false,
                defaultValue: [AutoSuperuserReplyOptions.NoReply],
                onValidate: selectFieldHasOptionChosen,
            },
            {
                type: "number",
                name: AppSetting.AutoSuperuserThreshold,
                label: "Treat users with this many points as automatically a trusted user",
                helpText:
                    "If zero, only explicitly named users above will be treated as trusted users",
                onValidate: numberFieldHasValidOption,
            },
            {
                type: "paragraph",
                name: AppSetting.NotifyOnAutoSuperuserTemplate,
                label: "Message sent when a user reaches the trusted user threshold",
                helpText:
                    "Placeholders Supported: {{name}}, {{threshold}}, {{command}}",
                defaultValue: TemplateDefaults.NotifyOnSuperuserTemplate,
                onValidate: paragraphFieldContainsText,
            },
            {
                name: AppSetting.NotifyOnPointAlreadyAwardedToUser,
                type: "select",
                label: "Notify on point already awarded to user",
                helpText:
                    "How to notify the user when they try to use the alternate command on a user who has already received a point for that post",
                options: NotifyOnPointAlreadyAwardedToUserOptionChoices,
                defaultValue: [PointAwardedReplyOptions.NoReply],
                onValidate: selectFieldHasOptionChosen,
            },
            {
                name: AppSetting.PointAlreadyAwardedToUserMessage,
                type: "paragraph",
                label: "Message to send users when they use the Alternate Award Command, but the mentioned user has already received a point on the post",
                helpText: "Placeholders Supported: {{awardee}}, {{name}}",
                defaultValue: TemplateDefaults.PointAlreadyAwardedToUserMessage,
                onValidate: paragraphFieldContainsText,
            },
            {
                name: AppSetting.AlternatePointCommandUsers,
                type: "paragraph",
                label: "Alternate Award Command users",
                helpText:
                    "List of users who can use the 'Alternate Award Command'. Each username should be on a new line",
            },
            {
                name: AppSetting.NotifyOnAlternateCommandSuccess,
                type: "select",
                label: "Notify on alternate command success",
                helpText:
                    "How to notify users when they use the alternate command and it is successful",
                options: NotifyOnAlternateCommandSuccessReplyOptionChoices,
                defaultValue: [
                    NotifyOnAlternateCommandSuccessReplyOptions.ReplyAsComment,
                ],
                onValidate: selectFieldHasOptionChosen,
            },
            {
                name: AppSetting.AlternateCommandSuccessMessage,
                type: "paragraph",
                label: "Alternate Command Success Message",
                helpText:
                    "Message to send users when they use the Alternate Award Command and it is successful. Placeholders Supported: {{awardeePage}}, {{name}}, {{awardee}}, {{awarder}}, {{leaderboard}}, {{symbol}}, {{total}}",
                defaultValue: TemplateDefaults.AlternateCommandSuccessMessage,
                onValidate: paragraphFieldContainsText,
            },
            {
                name: AppSetting.NotifyOnAlternateCommandFail,
                type: "select",
                label: "Notify on alternate command fail",
                helpText:
                    "How to notify users when they use the alternate command and are not allowed to",
                options: NotifyOnAlternateCommandFailReplyOptionChoices,
                defaultValue: [
                    NotifyOnAlternateCommandFailReplyOptions.ReplyByPM,
                ],
                onValidate: selectFieldHasOptionChosen,
            },
            {
                name: AppSetting.AlternateCommandFailMessage,
                type: "paragraph",
                label: "Alternate Command Fail Message",
                helpText:
                    "Message to send users when they use the Alternate Award Command and are not allowed to. Placeholders Supported: {{altCommand}}, {{subreddit}}",
                defaultValue: TemplateDefaults.AlternateCommandFailMessage,
                onValidate: paragraphFieldContainsText,
            },
            {
                name: AppSetting.ModAwardCommand,
                type: "string",
                label: "Trusted User/Mod award command",
                helpText:
                    "Optional. Alternate command for mods and trusted users to award reputation points",
                defaultValue: "!modaward",
            },
            {
                name: AppSetting.NotifyOnModAwardSuccess,
                type: "select",
                label: "Notify on mod award success",
                helpText:
                    "How to notify users when a moderator or trusted user awards a point",
                options: NotifyOnModAwardSuccessOptionChoices,
                defaultValue: [NotifyOnModAwardSuccessReplyOptions.NoReply],
                onValidate: selectFieldHasOptionChosen,
            },
            {
                name: AppSetting.ModAwardCommandSuccess,
                type: "paragraph",
                label: "Mod Award Success Message",
                helpText: `Optional. Message to send users when they successfully award a message with the "Trusted User/Mod award command". Placeholders Supported: {{awardeePage}}, {{awardee}}, {{awarder}}, {{symbol}}, {{total}}, {{name}}, {{leaderboard}}`,
                defaultValue: TemplateDefaults.ModAwardCommandSuccessMessage,
                onValidate: paragraphFieldContainsText,
            },
            {
                name: AppSetting.NotifyOnModAwardFail,
                type: "select",
                label: "Notify on mod award fail",
                helpText: `Applicable to both "Mod Award Fail Message" and "Message to send user when the "Trusted User/Mod award command" has already been used on the comment."`,
                options: NotifyOnModAwardFailOptionChoices,
                onValidate: selectFieldHasOptionChosen,
            },
            {
                name: AppSetting.ModAwardCommandFail,
                type: "paragraph",
                label: "Mod Award Fail Message",
                helpText: `Optional. Message to send users when they aren't allowed to use the "Trusted User/Mod award command". Placeholders Supported: {{command}}, {{name}}, {{awarder}}`,
                defaultValue: TemplateDefaults.ModAwardCommandFailMessage,
                onValidate: paragraphFieldContainsText,
            },
            {
                name: AppSetting.ModAwardAlreadyGiven,
                type: "paragraph",
                label: `Message to send user when the "Trusted User/Mod award command" has already been used on the comment.`,
                helpText:
                    "Optional. Placeholders Supported: {{awardee}}, {{name}}",
                defaultValue: TemplateDefaults.ModAwardAlreadyGivenMessage,
                onValidate: paragraphFieldContainsText,
            },
        ],
    },
    {
        type: "group",
        label: "Points Setting Options",
        fields: [
            {
                name: AppSetting.ExistingFlairHandling,
                type: "select",
                label: "Flair setting option",
                helpText:
                    "If using a symbol, it must be set in the Point Symbol box",
                options: ExistingFlairHandlingOptionChoices,
                multiSelect: false,
                defaultValue: [ExistingFlairOverwriteHandling.OverwriteNumeric],
                onValidate: selectFieldHasOptionChosen,
            },
            {
                name: AppSetting.CSSClass,
                type: "string",
                label: "CSS class to use for points flairs",
                helpText:
                    "Optional. Please choose either a CSS class or flair template, not both",
            },
            {
                name: AppSetting.FlairTemplate,
                type: "string",
                label: "Flair template ID to use for points flairs",
                helpText:
                    "Optional. Please choose either a CSS class or flair template, not both",
            },
        ],
    },
    {
        type: "group",
        label: "Notification Settings",
        fields: [
            {
                type: "select",
                name: AppSetting.NotifyOnPointAlreadyAwarded,
                label: "Notify users when they try to award a comment they already awarded",
                options: NotifyOnPointAlreadyAwardedReplyOptionChoices,
                defaultValue: [NotifyOnPointAlreadyAwardedReplyOptions.NoReply],
                onValidate: selectFieldHasOptionChosen,
            },
            {
                type: "paragraph",
                name: AppSetting.DuplicateAwardMessage,
                label: "Point Already Awarded Message",
                helpText:
                    "Shown when a user tries to award a message they've already awarded. Placeholders Supported: {{name}}, {{awarder}}",
                defaultValue: TemplateDefaults.DuplicateAwardMessage,
                onValidate: paragraphFieldContainsText,
            },
            {
                type: "select",
                name: AppSetting.NotifyOnSelfAward,
                label: "Notify users when they try to award themselves",
                options: NotifyOnSelfAwardReplyOptionChoices,
                defaultValue: [NotifyOnSelfAwardReplyOptions.NoReply],
                onValidate: selectFieldHasOptionChosen,
            },
            {
                type: "paragraph",
                name: AppSetting.SelfAwardMessage,
                label: "Self Award Message",
                helpText:
                    "Shown when someone tries to award themselves. Placeholders Supported: {{name}}, {{awarder}}",
                defaultValue: TemplateDefaults.NotifyOnSelfAwardTemplate,
                onValidate: paragraphFieldContainsText,
            },
            {
                type: "select",
                name: AppSetting.NotifyOnSuccess,
                label: "Notify users when a point is awarded successfully",
                options: NotifyOnSuccessReplyOptionChoices,
                defaultValue: [NotifyOnSuccessReplyOptions.NoReply],
                onValidate: selectFieldHasOptionChosen,
            },
            {
                type: "paragraph",
                name: AppSetting.SuccessMessage,
                label: "Success Message",
                helpText:
                    "Message when a point is awarded. Placeholders Supported: {{awardeePage}}, {{awardee}}, {{awarder}}, {{symbol}}, {{total}}, {{name}}, {{leaderboard}}",
                defaultValue: TemplateDefaults.NotifyOnSuccessTemplate,
                onValidate: paragraphFieldContainsText,
            },
            {
                type: "select",
                name: AppSetting.NotifyUsersWhoCannotAwardPoints,
                label: "Notify a user if they are not allowed to award points",
                options: NotifyUsersWhoCannotAwardPointsReplyOptionChoices,
                defaultValue: [
                    NotifyUsersWhoCannotAwardPointsReplyOptions.NoReply,
                ],
                onValidate: selectFieldHasOptionChosen,
            },
            {
                type: "paragraph",
                name: AppSetting.UsersWhoCannotAwardPoints,
                label: "Users Who Cannot Award Points",
                helpText:
                    "List of usernames who cannot award points, even if they are mods or approved users. Each username should be on a new line",
            },
            {
                type: "paragraph",
                name: AppSetting.UsersWhoCannotAwardPointsMessage,
                label: "User Cannot Award Points Message",
                helpText: `Message shown when a user specified in the "Users Who Cannot Award Points" setting tries to award points but is not allowed to. Placeholders Supported: {{name}}`,
                defaultValue: TemplateDefaults.UsersWhoCannotAwardPointsMessage,
                onValidate: paragraphFieldContainsText,
            },
            {
                type: "select",
                name: AppSetting.NotifyOnBotAward,
                label: "Notify a user if they try to award the bot",
                options: NotifyOnBotAwardReplyOptionChoices,
                defaultValue: [NotifyOnBotAwardReplyOptions.NoReply],
                onValidate: selectFieldHasOptionChosen,
            },
            {
                type: "paragraph",
                name: AppSetting.BotAwardMessage,
                label: "Bot Award Message",
                helpText:
                    "Message shown when someone tries to award the bot. Placeholders Supported: {{name}}",
                defaultValue: TemplateDefaults.BotAwardMessage,
                onValidate: paragraphFieldContainsText,
            },
            {
                type: "select",
                name: AppSetting.NotifyOnApprove,
                label: "Notify a user when a point is awarded by a moderator",
                options: NotifyOnModApproveReplyOptionChoices,
                defaultValue: [NotifyOnModApproveReplyOptions.NoReply],
                onValidate: selectFieldHasOptionChosen,
            },
        ],
    },
    {
        type: "group",
        label: "Post Flair Setting Options",
        fields: [
            {
                name: AppSetting.SetPostFlairOnThanks,
                type: "boolean",
                label: "Set post flair when a reputation point is awarded",
                helpText:
                    "This can be used to mark a question as resolved, or answered",
                defaultValue: false,
            },
            {
                name: AppSetting.SetPostFlairText,
                type: "string",
                label: "Post Flair Text",
                helpText:
                    "Optional. Please enter the text to display for the post flair",
            },
            {
                name: AppSetting.SetPostFlairCSSClass,
                type: "string",
                label: "Post Flair CSS Class",
                helpText:
                    "Optional. Please choose either a CSS class or flair template, not both",
            },
            {
                name: AppSetting.SetPostFlairTemplate,
                type: "string",
                label: "Post Flair Template ID",
                helpText:
                    "Optional. Please choose either a CSS class or flair template, not both",
                onValidate: isFlairTemplateValid,
            },
        ],
    },
    {
        type: "group",
        label: "Misc Settings",
        fields: [
            {
                name: AppSetting.LeaderboardMode,
                type: "select",
                options: LeaderboardModeOptionChoices,
                label: "Wiki Leaderboard Mode",
                multiSelect: false,
                defaultValue: [LeaderboardMode.Off],
                onValidate: selectFieldHasOptionChosen,
            },
            {
                name: AppSetting.LeaderboardSize,
                type: "number",
                label: "Leaderboard Size",
                helpText: "Number of users to show on the leaderboard (1-100)",
                defaultValue: 50,
                onValidate: ({ value }) => {
                    if (value !== undefined && (value < 1 || value > 100)) {
                        return "Value should be between 1 and 100";
                    }
                },
            },
            {
                //DiscordServerLink
                name: AppSetting.DiscordServerLink,
                type: "string",
                label: "Discord Server Link",
                helpText:
                    "Optional. Link to your subreddit's discord server. A non-expiring link is recommended.",
            },
            {
                name: AppSetting.LeaderboardName,
                type: "string",
                label: "Leaderboard Wiki Name",
                helpText:
                    "Name of the wiki page for your subreddit's leaderboard (e.g. leaderboard). Singular form is recommended as there is only one leaderboard per subreddit",
                defaultValue: "leaderboard",
                onValidate: ({ value }) => {
                    if (!value || value.trim() === "") {
                        return "You must specify a wiki page name";
                    }
                },
            },
            {
                name: AppSetting.PointSystemHelpPage,
                type: "string",
                label: "Point System Help Page",
                helpText:
                    "Optional. Name of the wiki page for explaining your subreddit's point system (e.g. pointsystem).",
            },
            {
                type: "select",
                name: AppSetting.AllowUnflairedPosts,
                label: "Allow points on unflaired posts?",
                helpText: "Allow awarding on posts without flair?",
                options: [
                    { label: "Yes", value: "yes" },
                    { label: "No", value: "no" },
                ],
                defaultValue: ["no"],
                onValidate: selectFieldHasOptionChosen,
            },
            {
                type: "select",
                name: AppSetting.NotifyOnUnflairedPost,
                label: "Notify users when they try to award points on a post without flair if it's not allowed",
                options: NotifyOnUnflairedPostReplyOptionChoices,
                defaultValue: [NotifyOnUnflairedPostReplyOptions.NoReply],
                onValidate: selectFieldHasOptionChosen,
            },
            {
                type: "paragraph",
                name: AppSetting.UnflairedPostMessage,
                label: "Unflaired post message",
                helpText:
                    "Message shown when a user tries to award points on a post without flair. Placeholders Supported: {{name}}",
                defaultValue: TemplateDefaults.UnflairedPostMessage,
                onValidate: paragraphFieldContainsText,
            },
        ],
    },
    //TODO: try and make this work
    // {
    //     type: "group",
    //     label: "Backup and Restore",
    //     fields: [
    //         {
    //             name: AppSetting.EnableBackup,
    //             type: "boolean",
    //             label: "Enable Backup",
    //             defaultValue: true,
    //         },
    //         {
    //             name: AppSetting.EnableRestore,
    //             type: "boolean",
    //             label: "Enable Restore",
    //             helpText:
    //                 "This should be left disabled to prevent inadvertent score overwriting. Only enable during restore operations",
    //             defaultValue: false,
    //         },
    //     ],
    // },
];

function isFlairTemplateValid(event: SettingsFormFieldValidatorEvent<string>) {
    const flairTemplateRegex = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){4}[0-9a-f]{8}$/i;
    if (event.value && !flairTemplateRegex.test(event.value)) {
        return "Invalid flair template ID";
    }
}

function selectFieldHasOptionChosen(
    event: SettingsFormFieldValidatorEvent<string[]>
) {
    if (!event.value || event.value.length !== 1) {
        return "You must choose an option (even if this is an irrelevant setting)";
    }
}

function noValidTriggerWords(event: SettingsFormFieldValidatorEvent<string>) {
    if (!event.value || event.value.trim() === "") {
        return "You must specify at least one trigger word";
    }
    const lines = event.value.split("\n").map((line) => line.trim());
    if (lines.length === 0 || lines.some((line) => line === "")) {
        return "You must specify at least one trigger word";
    }
}

function alternateCommandInvalid(
    event: SettingsFormFieldValidatorEvent<string>
) {
    if (typeof event.value !== "string" || !event.value.includes("{{user}}")) {
        return "The Alternate Award Command must include the {{user}} placeholder (e.g., '!award {{user}}').";
    }
}

async function validateRegexes(
    event: SettingsFormFieldValidatorEvent<boolean>,
    context: TriggerContext
) {
    if (!event.value) {
        return;
    }

    const user = await context.reddit.getCurrentUser();
    if (!user) {
        return;
    }

    await context.scheduler.runJob({
        name: VALIDATE_REGEX_JOB,
        runAt: new Date(),
        data: { username: user.username },
    });
}

export async function validateRegexJobHandler(
    event: ScheduledJobEvent<JSONObject>,
    context: TriggerContext
) {
    const { username } = event.data as { username: string };
    const user = await context.reddit.getUserByUsername(username);
    if (!user) return;

    // Here you would perform regex validation on user commands.
    // This is an example: you can extend with actual validation logic.
    // For demo, just log.
    console.log(`Validating regex commands for user ${username}`);
}

// 🧮 Validate "Awards Required To Create New Posts"
export function numberFieldHasValidOption(
    event: SettingsFormFieldValidatorEvent<number>
) {
    if (typeof event.value !== "number" || isNaN(event.value)) {
        return "Value must be a number.";
    }

    if (event.value < 0) {
        return 'A non-negative number must be entered into the "Awards Required To Create New Posts" even if "Force Point Awarding" is disabled.';
    }
}

function paragraphFieldContainsText(
    event: SettingsFormFieldValidatorEvent<string>,
    context: TriggerContext
): string | void | Promise<string | void> {
    if (typeof event.value !== "string") {
        return "Value must be a string.";
    }

    if (event.value.length === 0) {
        return "Field cannot be empty (even if this is an irrelevant setting).";
    }
}
