import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';

import { FinishOnboardingUseCase } from './finish-onboarding.use-case';

// The trial is provisioned cloud-only (provisionTrial early-returns unless
// environment.API_CLOUD_MODE). Force cloud mode on so the trial path runs.
jest.mock('@libs/ee/configs/environment', () => {
    const actual = jest.requireActual('@libs/ee/configs/environment');
    return {
        ...actual,
        environment: { ...actual.environment, API_CLOUD_MODE: true },
    };
});

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

        const licenseService = {
            startTrial: jest.fn().mockResolvedValue(true),
        };
        const permissionValidationService = {
            getBYOKConfig: jest.fn().mockResolvedValue(null),
        };

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
            licenseService as any,
            permissionValidationService as any,
        );

        return {
            useCase,
            createOrUpdateParametersUseCase,
            syncSelectedReposKodyRulesUseCase,
            generateKodyRulesUseCase,
            licenseService,
            permissionValidationService,
        };
    };

    it('commits onboarding synchronously and runs repo-rule import + past-review generation detached', async () => {
        const {
            useCase,
            createOrUpdateParametersUseCase,
            syncSelectedReposKodyRulesUseCase,
            generateKodyRulesUseCase,
        } = buildUseCase();

        await useCase.execute({ teamId: 'team-1', reviewPR: false } as any);

        // Onboarding is committed synchronously...
        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalledWith(
            ParametersKey.PLATFORM_CONFIGS,
            expect.objectContaining({ finishOnboard: true }),
            expect.anything(),
        );

        // ...while the LLM-heavy repo-rule import AND the 3-month past-review
        // backfill both run detached (via setImmediate), so neither blocks the
        // onboarding response. Sync runs first; generation is chained off its
        // completion so it sees the imported rules.
        await new Promise((resolve) => setImmediate(resolve));
        expect(
            syncSelectedReposKodyRulesUseCase.execute,
        ).toHaveBeenCalledWith({ teamId: 'team-1', organizationId: 'org-1' });
        expect(generateKodyRulesUseCase.execute).toHaveBeenCalledWith(
            { teamId: 'team-1', months: 3 },
            'org-1',
        );
    });

    it('provisions the trial server-side after committing onboarding', async () => {
        const { useCase, licenseService } = buildUseCase();

        await useCase.execute({ teamId: 'team-1', reviewPR: false } as any);

        expect(licenseService.startTrial).toHaveBeenCalledWith(
            { organizationId: 'org-1', teamId: 'team-1' },
            false,
        );
    });

    it('does not fail onboarding when trial provisioning throws', async () => {
        const { useCase, licenseService, syncSelectedReposKodyRulesUseCase } =
            buildUseCase();
        licenseService.startTrial.mockRejectedValueOnce(
            new Error('billing down'),
        );

        await expect(
            useCase.execute({ teamId: 'team-1', reviewPR: false } as any),
        ).resolves.not.toThrow();

        // Onboarding still schedules its (detached) rule import despite the
        // billing error.
        await new Promise((resolve) => setImmediate(resolve));
        expect(
            syncSelectedReposKodyRulesUseCase.execute,
        ).toHaveBeenCalledWith({ teamId: 'team-1', organizationId: 'org-1' });
    });
});
