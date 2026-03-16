import {navigateTo} from "@devvit/web/client";

interface LeaderboardRowProps {
    username: string;
    score: number;
    pointName: string;
}

export const LeaderboardRow = (props: LeaderboardRowProps) => (
    <div className="w-full flex justify-between rounded-1 gap-2 my-2">
        <button className="w-1/2 text-left" onClick={() => navigateTo(`https://reddit.com/u/${props.username}`)}>{props.username}</button>
        <div className="w-1/2 text-left">{props.score} {props.pointName}</div>
    </div>
);
