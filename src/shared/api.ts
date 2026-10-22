export type ApiResponse<T> = {
    status: 'error' | 'ok';
    message: string;
    data?: T;
};

export type LeaderboardEntry = {
    username: string;
    score: number;
};

export type LeaderboardData = {
    helpUrl: string | undefined;
    pointName: string | undefined;
    entries: LeaderboardEntry[];
    /** Current viewer username, when Devvit can resolve it. */
    currentUsername?: string;
};
