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

export const LeaderboardRow = ({ rank, username, score, pointName, isCurrentUser = false }: LeaderboardRowProps) => {
    const rankClass = rank <= 3 ? `rank-${rank}` : "rank-default";

    return (
        <li className={`leaderboard-row ${rankClass}${isCurrentUser ? " is-current-user" : ""}`} aria-current={isCurrentUser ? "true" : undefined}>
            <div className="rank-cell">
                <span className="rank-medallion" aria-label={rankLabel(rank)}>
                    {rank === 1 ? "♛" : rank === 2 ? "◆" : rank === 3 ? "▲" : rank}
                </span>
            </div>
            <button
                className="contributor-button"
                onClick={() => navigateTo(`https://www.reddit.com/user/${encodeURIComponent(username)}/`)}
                aria-label={`Open Reddit profile for ${username}, ${rankLabel(rank)}`}
            >
                <span className="avatar-placeholder" aria-hidden="true">{username.replace(/^u\//, "").charAt(0).toUpperCase() || "?"}</span>
                <span className="contributor-details">
                    <span className="contributor-name">{username.replace(/^u\//, "")}</span>
                    <span className="contributor-rank-label">{isCurrentUser ? "Your position" : rankLabel(rank)}</span>
                </span>
                <span className="profile-arrow" aria-hidden="true">↗</span>
            </button>
            <div className="score-cell">
                <span className="score-value">{score.toLocaleString()}</span>
                <span className="score-unit">{pointName}</span>
            </div>
        </li>
    );
};
