import { KodyLearningCronProvider } from './kodyLearning.cron';

/**
 * Covers the per-repo window partition added for issue #1506: a repo that has
 * never produced past-review rules gets the one-time 3-month backfill, every
 * other enabled repo gets the weekly (1-week) delta.
 */
function build(opts: {
    repoIds: string[];
    hasPastReviewRules: (repoId: string) => boolean | Promise<boolean>;
}) {
    const parametersService = {
        findByKey: jest.fn().mockResolvedValue({
            configValue: {
                configs: {},
                repositories: opts.repoIds.map((id) => ({
                    id,
                    isSelected: true,
                    configs: {},
                })),
            },
        }),
    } as any;

    const generateKodyRulesUseCase = {
        execute: jest.fn().mockResolvedValue(undefined),
    } as any;

    const generateInitialKodyRulesUseCase = {
        hasPastReviewRules: jest.fn((_org: string, repoId: string) =>
            Promise.resolve(opts.hasPastReviewRules(repoId)),
        ),
    } as any;

    const cron = new KodyLearningCronProvider(
        {} as any,
        parametersService,
        generateKodyRulesUseCase,
        generateInitialKodyRulesUseCase,
        {} as any,
    );

    return { cron, generateKodyRulesUseCase, generateInitialKodyRulesUseCase };
}

const run = (cron: KodyLearningCronProvider) =>
    (cron as any).generateKodyRules({
        organizationId: 'org-1',
        teamId: 'team-1',
    });

describe('KodyLearningCronProvider — per-repo backfill window', () => {
    it('uses a 3-month window for repos with no past-review rules yet', async () => {
        const { cron, generateKodyRulesUseCase } = build({
            repoIds: ['r1'],
            hasPastReviewRules: () => false,
        });

        await run(cron);

        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledTimes(1);
        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledWith(
            { teamId: 'team-1', months: 3, repositoriesIds: ['r1'] },
            'org-1',
        );
    });

    it('uses the 1-week window once a repo already has past-review rules', async () => {
        const { cron, generateKodyRulesUseCase } = build({
            repoIds: ['r1'],
            hasPastReviewRules: () => true,
        });

        await run(cron);

        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledTimes(1);
        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledWith(
            { teamId: 'team-1', weeks: 1, repositoriesIds: ['r1'] },
            'org-1',
        );
    });

    it('splits a mixed set into one 3-month batch and one 1-week batch', async () => {
        const { cron, generateKodyRulesUseCase } = build({
            repoIds: ['fresh', 'seeded'],
            hasPastReviewRules: (id) => id === 'seeded',
        });

        await run(cron);

        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledWith(
            { teamId: 'team-1', months: 3, repositoriesIds: ['fresh'] },
            'org-1',
        );
        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledWith(
            { teamId: 'team-1', weeks: 1, repositoriesIds: ['seeded'] },
            'org-1',
        );
    });

    it('falls back to the weekly window when the past-review check fails', async () => {
        const { cron, generateKodyRulesUseCase, generateInitialKodyRulesUseCase } =
            build({ repoIds: ['r1'], hasPastReviewRules: () => true });
        generateInitialKodyRulesUseCase.hasPastReviewRules.mockRejectedValue(
            new Error('mongo down'),
        );

        await run(cron);

        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledTimes(1);
        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledWith(
            { teamId: 'team-1', weeks: 1, repositoriesIds: ['r1'] },
            'org-1',
        );
    });
});
