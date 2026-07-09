import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';

import { FinishOnboardingUseCase } from './finish-onboarding.use-case';

describe('FinishOnboardingUseCase', () => {
    const buildUseCase = () => {
        const parametersService = {
            findByKey: jest
                .fn()
                .mockResolvedValue({ configValue: { existing: true } }),
        };
        const createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        };
        const syncSelectedReposKodyRulesUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        };
        const generateKodyRulesUseCase = {
            execute: jest.fn().mockResolvedValue([]),
        };
        // No `uuid` on the user → the telemetry block is skipped.
        const request = { user: { organization: { uuid: 'org-1' } } };

        const useCase = new FinishOnboardingUseCase(
            parametersService as any,
            {} as any, // teamService
            {} as any, // reviewPRUseCase
            request as any,
            syncSelectedReposKodyRulesUseCase as any,
            createOrUpdateParametersUseCase as any,
            {} as any, // telemetry
            {} as any, // codeManagement
            generateKodyRulesUseCase as any,
        );

        return {
            useCase,
            createOrUpdateParametersUseCase,
            syncSelectedReposKodyRulesUseCase,
            generateKodyRulesUseCase,
        };
    };

    it('commits onboarding, imports repo rules, and kicks off past-review generation in the background', async () => {
        const {
            useCase,
            createOrUpdateParametersUseCase,
            syncSelectedReposKodyRulesUseCase,
            generateKodyRulesUseCase,
        } = buildUseCase();

        await useCase.execute({ teamId: 'team-1', reviewPR: false } as any);

        // Onboarding is committed...
        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalledWith(
            ParametersKey.PLATFORM_CONFIGS,
            expect.objectContaining({ finishOnboard: true }),
            expect.anything(),
        );
        // ...imports rules from repo files...
        expect(
            syncSelectedReposKodyRulesUseCase.execute,
        ).toHaveBeenCalledWith({ teamId: 'team-1' });

        // ...and schedules the 3-month past-review backfill without blocking
        // the onboarding response (detached via setImmediate).
        await new Promise((resolve) => setImmediate(resolve));
        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledWith(
            { teamId: 'team-1', months: 3 },
            'org-1',
        );
    });
});
