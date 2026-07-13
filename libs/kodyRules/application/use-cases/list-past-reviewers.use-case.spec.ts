import { ListPastReviewersUseCase } from './list-past-reviewers.use-case';

jest.mock('@libs/common/utils/transforms/date', () => ({
    generateDateFilter: () => ({
        startDate: '2020-01-01T00:00:00.000Z',
        endDate: '2020-04-01T00:00:00.000Z',
    }),
}));

function build(opts: {
    members?: any[];
    repos?: any[];
    prsByRepo?: Record<string, any[] | Error>;
    cached?: any[];
}) {
    const codeManagementService = {
        getListMembers: jest.fn().mockResolvedValue(opts.members ?? []),
        getRepositories: jest.fn().mockResolvedValue(opts.repos ?? []),
        getPullRequestsByRepository: jest.fn((params: any) => {
            const val = (opts.prsByRepo ?? {})[params.repository.id];
            if (val instanceof Error) return Promise.reject(val);
            return Promise.resolve(val ?? []);
        }),
    } as any;
    const cacheService = {
        getFromCache: jest.fn().mockResolvedValue(opts.cached ?? null),
        addToCache: jest.fn().mockResolvedValue(undefined),
    } as any;
    const request = { user: { organization: { uuid: 'org-1' } } } as any;

    return {
        useCase: new ListPastReviewersUseCase(
            codeManagementService,
            cacheService,
            request,
        ),
        codeManagementService,
        cacheService,
    };
}

const author = (id: any, name?: string) => ({ user: { id, name } });

describe('ListPastReviewersUseCase', () => {
    it('unions current members with PR authors, deduped by id and sorted by name', async () => {
        const { useCase } = build({
            members: [
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ],
            repos: [{ id: 'r1', name: 'repo-1' }],
            prsByRepo: {
                // Bob (2) also authored PRs (dup) + Carol (3), a departed dev
                // not in the current members list.
                r1: [author(2, 'Bob'), author(3, 'Carol'), author(2, 'Bob')],
            },
        });

        const result = await useCase.execute({
            teamId: 'team-1',
            repositoryId: 'r1',
        });

        expect(result).toEqual([
            { id: '1', name: 'Alice' },
            { id: '2', name: 'Bob' },
            { id: '3', name: 'Carol' },
        ]);
    });

    it('scopes PR-author lookup to the requested repo only', async () => {
        const { useCase, codeManagementService } = build({
            members: [],
            repos: [
                { id: 'r1', name: 'repo-1' },
                { id: 'r2', name: 'repo-2' },
            ],
            prsByRepo: { r1: [author(9, 'Nine')], r2: [author(10, 'Ten')] },
        });

        const result = await useCase.execute({
            teamId: 'team-1',
            repositoryId: 'r2',
        });

        expect(
            codeManagementService.getPullRequestsByRepository,
        ).toHaveBeenCalledTimes(1);
        expect(result).toEqual([{ id: '10', name: 'Ten' }]);
    });

    it('still returns PR authors when the members call fails', async () => {
        const { useCase, codeManagementService } = build({
            repos: [{ id: 'r1', name: 'repo-1' }],
            prsByRepo: { r1: [author(3, 'Carol')] },
        });
        codeManagementService.getListMembers.mockRejectedValue(
            new Error('members down'),
        );

        const result = await useCase.execute({
            teamId: 'team-1',
            repositoryId: 'r1',
        });

        expect(result).toEqual([{ id: '3', name: 'Carol' }]);
    });

    it('tolerates a per-repo PR fetch failure without dropping the others', async () => {
        const { useCase } = build({
            members: [],
            repos: [
                { id: 'r1', name: 'repo-1' },
                { id: 'r2', name: 'repo-2' },
            ],
            prsByRepo: {
                r1: new Error('rate limited'),
                r2: [author(10, 'Ten')],
            },
        });

        const result = await useCase.execute({ teamId: 'team-1' });

        expect(result).toEqual([{ id: '10', name: 'Ten' }]);
    });

    it('falls back to the id as the display name when none is provided', async () => {
        const { useCase } = build({
            members: [{ id: 7 }],
            repos: [],
        });

        const result = await useCase.execute({ teamId: 'team-1' });

        expect(result).toEqual([{ id: '7', name: '7' }]);
    });

    it('returns the cached list without recomputing', async () => {
        const { useCase, codeManagementService } = build({
            cached: [{ id: '1', name: 'Alice' }],
        });

        const result = await useCase.execute({ teamId: 'team-1' });

        expect(result).toEqual([{ id: '1', name: 'Alice' }]);
        expect(codeManagementService.getListMembers).not.toHaveBeenCalled();
    });

    it('serves an empty cached list as a hit (no recompute)', async () => {
        const { useCase, codeManagementService } = build({ cached: [] });

        const result = await useCase.execute({ teamId: 'team-1' });

        expect(result).toEqual([]);
        expect(codeManagementService.getListMembers).not.toHaveBeenCalled();
    });

    it('caches an empty result so an empty team is not recomputed', async () => {
        const { useCase, cacheService } = build({ members: [], repos: [] });

        const result = await useCase.execute({ teamId: 'team-1' });

        expect(result).toEqual([]);
        expect(cacheService.addToCache).toHaveBeenCalledWith(
            expect.any(String),
            [],
            expect.any(Number),
        );
    });

    it('does not cache when a provider call errors (avoids caching a failure)', async () => {
        const { useCase, cacheService, codeManagementService } = build({
            repos: [{ id: 'r1', name: 'repo-1' }],
            prsByRepo: { r1: [author(3, 'Carol')] },
        });
        codeManagementService.getListMembers.mockRejectedValue(
            new Error('members down'),
        );

        const result = await useCase.execute({ teamId: 'team-1' });

        expect(result).toEqual([{ id: '3', name: 'Carol' }]);
        expect(cacheService.addToCache).not.toHaveBeenCalled();
    });
});
