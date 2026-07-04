import { ParametersKey } from '@libs/core/domain/enums';

import { GetCodeReviewParameterUseCase } from '../get-code-review-parameter.use-case';

describe('GetCodeReviewParameterUseCase — get-or-create', () => {
    const makeEntity = () => ({
        toObject: () => ({
            configValue: { repositories: [] },
            createdAt: new Date('2026-01-01T00:00:00Z'),
        }),
        createdAt: new Date('2026-01-01T00:00:00Z'),
    });

    const build = (findByKey: jest.Mock, createOrUpdateConfig: jest.Mock) => {
        const parametersService = { findByKey, createOrUpdateConfig };
        const useCase = new GetCodeReviewParameterUseCase(
            parametersService as any,
            {} as any, // codeBaseConfigService
            {} as any, // authorizationService
            {} as any, // promptReferenceManager
        );
        // Short-circuit the heavy inheritance/formatting logic; we only care
        // about the get-or-create branch here.
        jest.spyOn(
            useCase as any,
            'getCodeReviewConfigFormatted',
        ).mockResolvedValue({ configs: {}, repositories: [] });
        return { useCase, parametersService };
    };

    const user = { organization: { uuid: 'org-1' } };

    it('creates the default config when the team has none, then returns it', async () => {
        const createOrUpdateConfig = jest.fn().mockResolvedValue(true);
        // First lookup misses; after creating the default it resolves.
        const findByKey = jest
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(makeEntity());

        const { useCase } = build(findByKey, createOrUpdateConfig);

        const result = await useCase.execute(user as any, 'team-1');

        expect(createOrUpdateConfig).toHaveBeenCalledWith(
            ParametersKey.CODE_REVIEW_CONFIG,
            {
                id: 'global',
                name: 'Global',
                isSelected: true,
                configs: {},
                repositories: [],
            },
            { organizationId: 'org-1', teamId: 'team-1' },
        );
        expect(result).toBeDefined();
    });

    it('does not create anything when the config already exists', async () => {
        const createOrUpdateConfig = jest.fn().mockResolvedValue(true);
        const findByKey = jest.fn().mockResolvedValue(makeEntity());

        const { useCase } = build(findByKey, createOrUpdateConfig);

        await useCase.execute(user as any, 'team-1');

        expect(createOrUpdateConfig).not.toHaveBeenCalled();
    });
});
