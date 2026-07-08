import { KodyRulesOrigin } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { GenerateInitialKodyRulesUseCase } from './generate-initial-kody-rules.use-case';

function build(opts: { documents?: unknown[] } = {}) {
    const kodyRulesService = {
        find: jest.fn().mockResolvedValue(opts.documents ?? []),
    } as any;
    const generate = {
        execute: jest.fn().mockResolvedValue(undefined),
    } as any;

    return {
        useCase: new GenerateInitialKodyRulesUseCase(kodyRulesService, generate),
        kodyRulesService,
        generate,
    };
}

const org = { organizationId: 'org-1', teamId: 'team-1' };

describe('GenerateInitialKodyRulesUseCase', () => {
    it('seeds the repo from the last 3 months when it has no past-review rules', async () => {
        const { useCase, generate } = build({ documents: [] });

        await useCase.execute({
            organizationAndTeamData: org,
            repositoryId: 'repo-1',
        });

        expect(generate.execute).toHaveBeenCalledTimes(1);
        expect(generate.execute).toHaveBeenCalledWith(
            { teamId: 'team-1', months: 3, repositoriesIds: ['repo-1'] },
            'org-1',
        );
    });

    it('skips generation when the repo already has past-review rules', async () => {
        const { useCase, generate } = build({
            documents: [
                {
                    rules: [
                        {
                            repositoryId: 'repo-1',
                            origin: KodyRulesOrigin.PAST_REVIEWS,
                        },
                    ],
                },
            ],
        });

        await useCase.execute({
            organizationAndTeamData: org,
            repositoryId: 'repo-1',
        });

        expect(generate.execute).not.toHaveBeenCalled();
    });

    it('still seeds when existing rules come from other origins (e.g. IDE files)', async () => {
        const { useCase, generate } = build({
            documents: [
                {
                    rules: [
                        {
                            repositoryId: 'repo-1',
                            origin: KodyRulesOrigin.REPO_FILE_SYNC,
                        },
                    ],
                },
            ],
        });

        await useCase.execute({
            organizationAndTeamData: org,
            repositoryId: 'repo-1',
        });

        expect(generate.execute).toHaveBeenCalledTimes(1);
    });

    it('no-ops without touching dependencies when required ids are missing', async () => {
        const { useCase, kodyRulesService, generate } = build();

        await useCase.execute({
            organizationAndTeamData: { organizationId: '', teamId: '' },
            repositoryId: '',
        });

        expect(kodyRulesService.find).not.toHaveBeenCalled();
        expect(generate.execute).not.toHaveBeenCalled();
    });

    it('swallows generation errors so a detached fire never rejects', async () => {
        const { useCase, generate } = build({ documents: [] });
        generate.execute.mockRejectedValue(new Error('boom'));

        await expect(
            useCase.execute({
                organizationAndTeamData: org,
                repositoryId: 'repo-1',
            }),
        ).resolves.toBeUndefined();
    });
});
