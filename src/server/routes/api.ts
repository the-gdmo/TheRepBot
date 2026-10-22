import { Hono } from 'hono';
import { context, reddit, redis, settings } from '@devvit/web/server';
import type { LeaderboardData, ApiResponse, LeaderboardEntry } from '../../shared/api';
import { POINTS_STORE_KEY } from '../../shared/constants';

export const api = new Hono();

api.get('/getLeaderboard', async (c) => {
    try {
        const helpPage = await settings.get<string>('pointSystemHelpPage');
        const helpUrl = helpPage ? `https://reddit.com/r/${context.subredditName}/wiki/${helpPage}` : undefined;
        const pointName = await settings.get<string>('pointName');

        // Read the complete sorted set, not the moderator-configured wiki/post top-N limit.
        // Redis sorted-set rank order is descending so index 0 is the highest-scoring user.
        const items = await redis.zRange(POINTS_STORE_KEY, 0, -1, { by: 'rank', reverse: true });
        const leaderboardEntries: LeaderboardEntry[] = items.map((item) => ({
            username: item.member,
            score: item.score,
        }));

        // Resolve the viewer's own Reddit username server-side so the client can locate their rank.
        let currentUsername: string | undefined;
        try {
            currentUsername = await reddit.getCurrentUsername();
        } catch (identityError) {
            // The leaderboard remains usable if the viewer is logged out or identity is unavailable.
            console.warn('Could not resolve current leaderboard viewer:', identityError);
        }

        return c.json<ApiResponse<LeaderboardData>>({
            status: 'ok',
            message: '',
            data: {
                helpUrl,
                pointName,
                entries: leaderboardEntries,
                currentUsername,
            },
        });
    } catch (error) {
        console.error('API Get Leaderboard Error:', error);
        const errorMessage = error instanceof Error
            ? `GetLeaderboard failed: ${error.message}`
            : 'Unknown error fetching leaderboard';
        return c.json<ApiResponse<undefined>>({ status: 'error', message: errorMessage }, 400);
    }
});
