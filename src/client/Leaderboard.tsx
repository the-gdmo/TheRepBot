import "./index.css";

import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import pluralize from "pluralize";
import { navigateTo } from "@devvit/web/client";
import type { ApiResponse, LeaderboardData } from "../shared/api";
import { LeaderboardRow } from "./LeaderboardRow";

const PAGE_SIZE = 5;

const capitalize = (word: string): string =>
    word.charAt(0).toUpperCase() + word.slice(1);

export const Leaderboard = () => {
    const [data, setData] = useState<LeaderboardData | undefined>();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string>();
    const [page, setPage] = useState(1);
    const [refreshKey, setRefreshKey] = useState(0);
    const [positionMessage, setPositionMessage] = useState<string>();

    useEffect(() => {
        const controller = new AbortController();

        const refreshLeaderboard = async () => {
            setLoading(true);
            setError(undefined);
            try {
                const response = await fetch("/api/getLeaderboard", {
                    signal: controller.signal,
                    headers: { Accept: "application/json" },
                });
                if (!response.ok) {
                    throw new Error(
                        `The leaderboard request failed (${response.status}).`
                    );
                }

                const result: ApiResponse<LeaderboardData> =
                    await response.json();
                if (result.status !== "ok" || !result.data) {
                    throw new Error(
                        result.message || "Could not load leaderboard data."
                    );
                }
                setData(result.data);
                setPage(1);
                setPositionMessage(undefined);
            } catch (caught) {
                if (caught instanceof Error && caught.name === "AbortError")
                    return;
                setError(
                    caught instanceof Error
                        ? caught.message
                        : "Something went wrong while loading the leaderboard."
                );
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        };

        void refreshLeaderboard();
        return () => controller.abort();
    }, [refreshKey]);

    const entries = data?.entries ?? [];
    const maxPage = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
    const safePage = Math.min(page, maxPage);
    const visibleEntries = useMemo(() => {
        const start = (safePage - 1) * PAGE_SIZE;
        return entries.slice(start, start + PAGE_SIZE);
    }, [entries, safePage]);

    const goToPage = useCallback(
        (nextPage: number) => {
            setPage(Math.max(1, Math.min(maxPage, nextPage)));
        },
        [maxPage]
    );

    const currentUsername = data?.currentUsername?.replace(/^u\//i, "").trim();
    const currentUserIndex = currentUsername
        ? entries.findIndex(
              (entry) =>
                  entry.username.replace(/^u\//i, "").trim().toLowerCase() ===
                  currentUsername.toLowerCase()
          )
        : -1;
    const currentUserRank =
        currentUserIndex >= 0 ? currentUserIndex + 1 : undefined;
    const pointName = capitalize(data?.pointName || "point");
    const helpUrl = data?.helpUrl;
    const firstRank = entries.length ? (safePage - 1) * PAGE_SIZE + 1 : 0;
    const lastRank = Math.min(safePage * PAGE_SIZE, entries.length);

    const seeMyPosition = useCallback(() => {
        if (!currentUsername) {
            setPositionMessage(
                "We couldn't identify your Reddit account. Make sure you're signed in, then refresh the leaderboard."
            );
            return;
        }
        if (currentUserRank === undefined) {
            setPositionMessage(
                `u/${currentUsername} doesn't currently have an entry in the points leaderboard.`
            );
            return;
        }
        setPage(Math.ceil(currentUserRank / PAGE_SIZE));
        setPositionMessage(
            `Your rank is #${currentUserRank} of ${entries.length} users.`
        );
    }, [currentUsername, currentUserRank, entries.length]);

    // Only render a small window of page links, even when there are thousands of pages.
    const pageNumbers = useMemo(() => {
        const candidates = new Set<number>([1, maxPage]);
        for (
            let number = Math.max(1, safePage - 1);
            number <= Math.min(maxPage, safePage + 1);
            number += 1
        ) {
            candidates.add(number);
        }
        const sorted = [...candidates].sort((a, b) => a - b);
        return sorted.reduce<(number | "ellipsis")[]>(
            (result, number, index) => {
                const previous = index > 0 ? sorted[index - 1] : undefined;
                if (previous !== undefined && number - previous > 1)
                    result.push("ellipsis");
                result.push(number);
                return result;
            },
            []
        );
    }, [maxPage, safePage]);

    return (
        <main className="leaderboard-shell">
            <section
                className="leaderboard-card"
                aria-labelledby="leaderboard-title"
            >
                <header className="leaderboard-header">
                    <div className="brand-mark" aria-hidden="true">
                        <img src="/podium.png" alt="" width={48} height={48} />
                    </div>
                    <div className="header-copy">
                        <p className="eyebrow">COMMUNITY STANDINGS</p>
                        <h1 id="leaderboard-title">RepBot Leaderboard</h1>
                        <p className="header-subtitle">
                            Celebrating the community's top contributors via u/therepbot.
                        </p>
                    </div>
                    {helpUrl && (
                        <button
                            className="help-button"
                            onClick={() => navigateTo(helpUrl)}
                        >
                            <span aria-hidden="true">?</span> Help
                        </button>
                    )}
                </header>

                {loading && !data ? (
                    <div className="state-panel" role="status">
                        <span className="loading-spinner" aria-hidden="true" />
                        <strong>Loading leaderboard</strong>
                        <span>Gathering the latest community scores…</span>
                    </div>
                ) : error && !data ? (
                    <div className="state-panel error-panel" role="alert">
                        <span className="state-icon" aria-hidden="true">
                            !
                        </span>
                        <strong>Couldn't load the leaderboard</strong>
                        <span>{error}</span>
                        <button
                            className="primary-button"
                            onClick={() => setRefreshKey((key) => key + 1)}
                        >
                            Try again
                        </button>
                    </div>
                ) : entries.length === 0 ? (
                    <div className="state-panel">
                        <span className="state-icon" aria-hidden="true">
                            ☆
                        </span>
                        <strong>No scores yet</strong>
                        <span>
                            When community members earn points, they'll appear
                            here.
                        </span>
                        <button
                            className="secondary-button"
                            onClick={() => setRefreshKey((key) => key + 1)}
                        >
                            Refresh leaderboard
                        </button>
                    </div>
                ) : (
                    <>
                        <div className="leaderboard-toolbar">
                            <div>
                                <p className="section-label">
                                    ALL-TIME RANKINGS
                                </p>
                                <p className="results-count">
                                    Showing{" "}
                                    <strong>
                                        {firstRank}–{lastRank}
                                    </strong>{" "}
                                    of <strong>{entries.length}</strong> users
                                </p>
                            </div>
                            <div className="toolbar-actions">
                                <button
                                    className="primary-button position-button"
                                    onClick={seeMyPosition}
                                    disabled={loading}
                                >
                                    <span aria-hidden="true">⌖</span> See My
                                    Position
                                </button>
                                <button
                                    className="secondary-button refresh-button"
                                    onClick={() =>
                                        setRefreshKey((key) => key + 1)
                                    }
                                    disabled={loading}
                                    aria-label="Refresh leaderboard"
                                >
                                    <span
                                        className={
                                            loading
                                                ? "refresh-icon spinning"
                                                : "refresh-icon"
                                        }
                                        aria-hidden="true"
                                    >
                                        ↻
                                    </span>
                                    {loading ? "Refreshing…" : "Refresh"}
                                </button>
                            </div>
                        </div>
                        {positionMessage && (
                            <p
                                className={`position-message${
                                    currentUserRank !== undefined &&
                                    positionMessage.startsWith("Your rank")
                                        ? " position-message-success"
                                        : ""
                                }`}
                                role="status"
                            >
                                {positionMessage}
                            </p>
                        )}

                        <div className="table-heading" aria-hidden="true">
                            <span>RANK</span>
                            <span>CONTRIBUTOR</span>
                            <span className="score-heading">SCORE</span>
                        </div>

                        <ol
                            className="leaderboard-list"
                            aria-label="Leaderboard rankings"
                        >
                            {visibleEntries.map((entry, index) => {
                                const rank =
                                    (safePage - 1) * PAGE_SIZE + index + 1;
                                return (
                                    <LeaderboardRow
                                        key={entry.username}
                                        rank={rank}
                                        username={entry.username}
                                        score={entry.score}
                                        pointName={capitalize(
                                            pluralize(
                                                data?.pointName || "point",
                                                entry.score
                                            )
                                        )}
                                        isCurrentUser={
                                            currentUserIndex ===
                                            (safePage - 1) * PAGE_SIZE + index
                                        }
                                    />
                                );
                            })}
                        </ol>

                        <footer className="pagination-footer">
                            <span className="page-summary">
                                Page <strong>{safePage}</strong> of{" "}
                                <strong>{maxPage}</strong>
                            </span>
                            <nav
                                className="pagination-controls"
                                aria-label="Leaderboard pages"
                            >
                                <button
                                    className="page-button page-arrow"
                                    onClick={() => goToPage(safePage - 1)}
                                    disabled={safePage === 1}
                                    aria-label="Previous page"
                                >
                                    <span aria-hidden="true">←</span>
                                    <span className="arrow-label">
                                        Previous
                                    </span>
                                </button>
                                <div className="page-numbers">
                                    {pageNumbers.map((number, index) =>
                                        number === "ellipsis" ? (
                                            <span
                                                className="page-ellipsis"
                                                key={`ellipsis-${index}`}
                                                aria-hidden="true"
                                            >
                                                …
                                            </span>
                                        ) : (
                                            <button
                                                key={number}
                                                className={`page-button ${
                                                    number === safePage
                                                        ? "active"
                                                        : ""
                                                }`}
                                                onClick={() => goToPage(number)}
                                                aria-label={`Page ${number}`}
                                                aria-current={
                                                    number === safePage
                                                        ? "page"
                                                        : undefined
                                                }
                                            >
                                                {number}
                                            </button>
                                        )
                                    )}
                                </div>
                                <button
                                    className="page-button page-arrow"
                                    onClick={() => goToPage(safePage + 1)}
                                    disabled={safePage === maxPage}
                                    aria-label="Next page"
                                >
                                    <span className="arrow-label">Next</span>
                                    <span aria-hidden="true">→</span>
                                </button>
                            </nav>
                        </footer>
                    </>
                )}

                <div className="leaderboard-bottom-note">
                    <span className="status-dot" aria-hidden="true" />
                    Scores are ranked from highest to lowest
                    {data?.pointName ? (
                        <span className="point-name-note">
                            {" "}
                            · Points: {pointName}
                        </span>
                    ) : null}
                </div>
            </section>
        </main>
    );
};

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <Leaderboard />
    </StrictMode>
);
