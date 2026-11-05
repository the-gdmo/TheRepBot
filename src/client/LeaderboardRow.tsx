import { navigateTo } from "@devvit/web/client";

interface LeaderboardRowProps {
    rank: number;
    username: string;
    score: number;
    pointName: string;
    isCurrentUser?: boolean;
}

const rankLabel = (rank: number): string => {
    if (rank === 1) return "1st place";
    if (rank === 2) return "2nd place";
    if (rank === 3) return "3rd place";
    return `Rank ${rank}`;
};

export const LeaderboardRow = ({
    rank,
    username,
    score,
    pointName,
    isCurrentUser = false,
}: LeaderboardRowProps) => {
    const rankClass = rank <= 3 ? `rank-${rank}` : "rank-default";

    // Remove the Reddit username prefix if it is present.
    const cleanUsername = username.replace(/^u\//i, "");

    // Apply podium colors directly to the score.
    const scoreColor =
        rank === 1
            ? "#ffdb83"
            : rank === 2
            ? "#dce7f8"
            : rank === 3
            ? "#eab28d"
            : undefined;

    return (
        <li
            className={`leaderboard-row ${rankClass}${
                isCurrentUser ? " is-current-user" : ""
            }`}
            aria-current={isCurrentUser ? "true" : undefined}
        >
            <div className="rank-cell">
                <span className="rank-medallion" aria-label={rankLabel(rank)}>
                    {rank === 1
                        ? "♛"
                        : rank === 2
                        ? "◆"
                        : rank === 3
                        ? "▲"
                        : rank}
                </span>
            </div>

            <button
                className="contributor-button"
                onClick={() =>
                    navigateTo(
                        `https://www.reddit.com/user/${encodeURIComponent(
                            cleanUsername
                        )}/`
                    )
                }
                aria-label={`Open Reddit profile for ${cleanUsername}, ${rankLabel(
                    rank
                )}`}
            >
                <span className="avatar-placeholder" aria-hidden="true">
                    {cleanUsername.charAt(0).toUpperCase() || "?"}
                </span>

                <span className="contributor-details">
                    <span className="contributor-name">{cleanUsername}</span>

                    <span className="contributor-rank-label">
                        {isCurrentUser ? "Your position" : rankLabel(rank)}
                    </span>
                </span>

                <span className="profile-arrow" aria-hidden="true">
                    ↗
                </span>
            </button>

            <div className="score-cell">
                <span className="score-value" style={{ color: scoreColor }}>
                    {score.toLocaleString()}
                </span>

                <span className="score-unit">{pointName}</span>
            </div>
        </li>
    );
};
