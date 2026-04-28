import { describe, expect, it, vi } from 'vitest';
import { RealReviewApi } from '../review.api.js';

describe('RealReviewApi', () => {
    it('uses bearer auth and teamId query for analyze with user token', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({
            summary: 'ok',
            issues: [],
            filesAnalyzed: 0,
            duration: 0,
        });

        const payload = Buffer.from(
            JSON.stringify({ organizationId: 'team-1' }),
        ).toString('base64url');
        const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.signature`;

        const api = new RealReviewApi(requestWithRetry);
        await api.analyze('diff --git a/file b/file', token);

        expect(requestWithRetry).toHaveBeenCalledWith(
            '/cli/review?teamId=team-1',
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    diff: 'diff --git a/file b/file',
                    config: undefined,
                }),
            },
        );
    });

    it('uses X-Team-Key for pull request suggestions with team key auth', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({
            summary: 'ok',
            issues: [],
            filesAnalyzed: 0,
            duration: 0,
        });

        const api = new RealReviewApi(requestWithRetry);
        await api.getPullRequestSuggestions('kodus_team_key', {
            prUrl: 'https://github.com/acme/repo/pull/1',
            severity: 'high',
        });

        expect(requestWithRetry).toHaveBeenCalledWith(
            '/pull-requests/suggestions?prUrl=https%3A%2F%2Fgithub.com%2Facme%2Frepo%2Fpull%2F1&severity=high',
            {
                headers: {
                    'X-Team-Key': 'kodus_team_key',
                },
            },
        );
    });

    it('serializes only provided fields for business validation', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({
            status: 'ok',
        });

        const api = new RealReviewApi(requestWithRetry);
        await api.triggerBusinessValidation('kodus_team_key', {
            repository: 'kodustech/cli',
            taskId: 'TASK-1',
        });

        expect(requestWithRetry).toHaveBeenCalledWith(
            '/cli/business-validation',
            {
                method: 'POST',
                headers: {
                    'X-Team-Key': 'kodus_team_key',
                },
                body: JSON.stringify({
                    repository: 'kodustech/cli',
                    taskId: 'TASK-1',
                }),
            },
        );
    });
});
