import { Hono } from 'hono';
import { redis, settings } from '@devvit/web/server';
import type {LeaderboardData, ApiResponse, LeaderboardEntry} from '../../shared/api';

export const api = new Hono();

api.get('/getLeaderboard', async (c) => {
    try {
        const helpUrl = await settings.get<string>('pointSystemHelpPage');
        const pointName = await settings.get<string>('pointName');
        const items = await redis.zRange(
            'thanksPointsStore',
            0,
            10, // TODO: Pagination
            { by: "rank", reverse: true }
        );
        const leaderboardEntries: LeaderboardEntry[] = items.map(e => {
            return {
                username: e.member,
                score: e.score
            }
        });
        return c.json<ApiResponse<LeaderboardData>>({
            status: 'ok',
            message: '',
            data: {
                helpUrl: helpUrl,
                pointName: pointName,
                entries: leaderboardEntries
            }
        });
    } catch (error) {
        console.error(`API Get Leaderboard Error: `, error);
        let errorMessage = 'Unknown error fetching leaderboard';
        if (error instanceof Error) {
            errorMessage = `GetLeaderboard failed: ${error.message}`;
        }
        return c.json<ApiResponse<undefined>>(
            { status: 'error', message: errorMessage },
            400
        );
    }
});
