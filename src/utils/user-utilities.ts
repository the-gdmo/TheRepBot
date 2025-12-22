import { TriggerContext, User } from "@devvit/public-api";
import { AppSetting } from "../settings.js";
import { getCurrentScore } from "../thanksPoints.js";

export const isModerator = async (
    devvitContext: TriggerContext,
    subName: string,
    awarder: string
) => {
    const filteredModeratorList = await devvitContext.reddit
        .getModerators({ subredditName: subName, username: awarder })
        .all();
    return filteredModeratorList.length > 0;
};

export const getUserCanAward = async (
    devvitContext: TriggerContext,
    awarder: string
) => {
    // UsersWhoCannotAwardPoints
    const settings = await devvitContext.settings.getAll();

    const usersWhoCannotAwardSetting =
        (settings[AppSetting.UsersWhoCannotAwardPoints] as string | undefined) ?? "";
    const UsersWhoCannotAwardPoints = usersWhoCannotAwardSetting
        .split(",")
        .map((user) => user.trim().toLowerCase());

    if (UsersWhoCannotAwardPoints.includes(awarder.toLowerCase())) {
        return false;
    }

    return true;
};

export const getUserIsSuperuser = async (
    devvitContext: TriggerContext,
    awarder: string
) => {
    const settings = await devvitContext.settings.getAll();

    const superUserSetting =
        (settings[AppSetting.SuperUsers] as string | undefined) ?? "";
    const superUsers = superUserSetting
        .split(",")
        .map((user) => user.trim().toLowerCase());

    if (superUsers.includes(awarder.toLowerCase())) {
        return true;
    }

    const autoSuperuserThreshold =
        (settings[AppSetting.AutoSuperuserThreshold] as number | undefined) ??
        0;

    if (autoSuperuserThreshold) {
        let user: User | undefined;
        try {
            user = await devvitContext.reddit.getUserByUsername(awarder);
        } catch {
            return false;
        }
        if (!user) {
            return false;
        }
        const { currentScore } = await getCurrentScore(
            user,
            devvitContext,
            settings
        );
        return currentScore >= autoSuperuserThreshold;
    } else {
        return false;
    }
};

export const getUserIsAltUser = async (
    devvitContext: TriggerContext,
    awarder: string
) => {
    const settings = await devvitContext.settings.getAll();

    const altUserSetting =
        (settings[AppSetting.AlternatePointCommandUsers] as
            | string
            | undefined) ?? "";
    const altUsers = altUserSetting
        .split(",")
        .map((user) => user.trim().toLowerCase());

    if (altUsers.includes(awarder.toLowerCase())) {
        return true;
    } else {
        return false;
    }
};
