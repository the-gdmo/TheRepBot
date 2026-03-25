import "./index.css";

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { LeaderboardRow } from "./LeaderboardRow";
import pluralize from "pluralize";
import { navigateTo } from "@devvit/web/client";
import { ApiResponse, LeaderboardData } from "../shared/api";

const capitalize = (word: string): string => {
    return word.charAt(0).toUpperCase() + word.slice(1);
};

export const Leaderboard = () => {
    const [data, setData] = useState<LeaderboardData | undefined>(undefined);
    const [page, setPage] = useState(1);

    // load saved perPage or default to 5
    const [perPage, setPerPage] = useState<number>(() => {
        const saved = localStorage.getItem("leaderboard_perPage");
        return saved ? Number(saved) : 5;
    });

    useEffect(() => {
        if (data) return;

        const refreshLeaderboard = async () => {
            const res = await fetch("/api/getLeaderboard");
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const resJson: ApiResponse<LeaderboardData> = await res.json();
            setData(resJson.data);
        };

        void refreshLeaderboard();
    }, [data]);

    // persist perPage
    useEffect(() => {
        localStorage.setItem("leaderboard_perPage", perPage.toString());
    }, [perPage]);

    if (!data) {
        return <div className="w-full h-full flex">Loading...</div>;
    }

    const { helpUrl, pointName, entries } = data;

    const maxPage = Math.ceil(entries.length / perPage);
    const start = (page - 1) * perPage;
    const visibleEntries = entries.slice(start, start + perPage);

    return (
        <div className="bg-gray-900 text-gray-100 p-4 rounded-xl shadow-lg">
            <div className="w-full h-full flex flex-col">
                <div className="w-full flex justify-center items-center gap-4 p-2 border-2">
                    <img alt="podium" width={48} height={48} src="podium.png" />
                    <div className="text-lg font-bold">Top scoring users</div>
                    {helpUrl ? (
                        <button onClick={() => navigateTo(helpUrl)}>
                            Help
                        </button>
                    ) : (
                        <img
                            alt="podium"
                            width={48}
                            height={48}
                            src="podium.png"
                        />
                    )}
                </div>

                <div className="flex justify-center items-center gap-4 p-2">
                    <button onClick={() => setData(undefined)}>
                        Refresh Leaderboard
                    </button>

                    {/* users per page selector */}
                    <select
                        value={perPage}
                        onChange={(e) => {
                            const value = Number(e.target.value);
                            setPerPage(value);
                            setPage(1);
                        }}
                    >
                        <option value={1}>1 Per Page</option>
                        <option value={2}>2 Per Page</option>
                        <option value={3}>3 Per Page</option>
                        <option value={4}>4 Per Page</option>
                        <option value={5}>5 Per Page</option>
                        <option value={6}>6 Per Page</option>
                    </select>
                </div>

                <div className="flex flex-col p-2 gap-2 w-full">
                    <div className="w-full flex flex-col gap-2">
                        {visibleEntries.map((entry, i) => (
                            <LeaderboardRow
                                key={i}
                                pointName={capitalize(
                                    pluralize(
                                        pointName || "point",
                                        entry.score,
                                    ),
                                )}
                                username={entry.username}
                                score={entry.score}
                            />
                        ))}
                    </div>

                    {/* pagination */}
                    <div className="flex justify-center items-center gap-4 pt-4">
                        <button
                            disabled={page === 1}
                            onClick={() => setPage((p) => p - 1)}
                        >
                            Prev
                        </button>

                        <span>
                            Page {page} / {maxPage}
                        </span>

                        <button
                            disabled={page === maxPage}
                            onClick={() => setPage((p) => p + 1)}
                        >
                            Next
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <Leaderboard />
    </StrictMode>,
);
