import { KodyRulesSyncService } from '@libs/kodyRules/infrastructure/adapters/services/kodyRulesSync.service';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('KodyRulesSyncService.syncRepositoryMain', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const repository = {
        id: 'repo-1',
        name: 'backend-services',
        fullName: 'quintoandar/backend-services',
        defaultBranch: 'main',
    };

    function createService() {
        const kodyRulesService = {
            createOrUpdate: jest.fn().mockResolvedValue({ uuid: 'rule-1' }),
        };
        const parametersService = {
            findByKey: jest.fn().mockResolvedValue({
                configValue: {
                    repositories: [
                        {
                            id: 'repo-1',
                            configs: { ideRulesSyncEnabled: false },
                            directories: [
                                {
                                    id: 'dir-1',
                                    path: 'qantilever',
                                },
                            ],
                        },
                    ],
                },
            }),
        };
        const contextResolutionService = {
            getRepositoryNameByOrganizationAndRepository: jest
                .fn()
                .mockResolvedValue('backend-services'),
            getTeamIdByOrganizationAndRepository: jest
                .fn()
                .mockResolvedValue('team-1'),
        };
        const codeManagementService = {
            getDefaultBranch: jest.fn().mockResolvedValue('main'),
            getRepositoryAllFiles: jest.fn(),
            getRepositoryContentFile: jest.fn().mockResolvedValue({
                data: {
                    content: Buffer.from(
                        [
                            '---',
                            '# @kody-sync',
                            '---',
                            'Logging rule content',
                        ].join('\n'),
                        'utf-8',
                    ).toString('base64'),
                    encoding: 'base64',
                },
            }),
        };
        const updateOrCreateCodeReviewParameterUseCase = {
            execute: jest.fn().mockResolvedValue(undefined),
        };
        const promptRunnerService = {};
        const permissionValidationService = {
            validateBasicLicense: jest
                .fn()
                .mockResolvedValue({ allowed: true }),
            getBYOKConfig: jest.fn().mockResolvedValue(undefined),
        };
        const observabilityService = {};
        const contextReferenceDetectionService = {};

        const service = new KodyRulesSyncService(
            kodyRulesService as any,
            parametersService as any,
            contextResolutionService as any,
            codeManagementService as any,
            updateOrCreateCodeReviewParameterUseCase as any,
            promptRunnerService as any,
            permissionValidationService as any,
            observabilityService as any,
            contextReferenceDetectionService as any,
        );

        jest.spyOn(service as any, 'convertFileToKodyRules').mockResolvedValue([
            {
                title: 'Logging Rule',
                rule: 'Use log instead of logger',
                path: '**/*',
                severity: 'medium',
                scope: 'file',
                examples: [],
            },
        ]);
        jest.spyOn(
            service as any,
            'processContextReferences',
        ).mockResolvedValue(undefined);

        return {
            service,
            kodyRulesService,
            codeManagementService,
        };
    }

    it('syncs only the requested path during manual resync', async () => {
        const { service, kodyRulesService, codeManagementService } =
            createService();

        await service.syncRepositoryMain({
            organizationAndTeamData,
            repository,
            path: 'qantilever/.cursor/rules/logging.mdc',
        });

        expect(
            codeManagementService.getRepositoryAllFiles,
        ).not.toHaveBeenCalled();
        expect(
            codeManagementService.getRepositoryContentFile,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                file: { filename: 'qantilever/.cursor/rules/logging.mdc' },
            }),
        );
        expect(kodyRulesService.createOrUpdate).toHaveBeenCalledWith(
            organizationAndTeamData,
            expect.objectContaining({
                sourcePath: 'qantilever/.cursor/rules/logging.mdc',
            }),
            expect.any(Object),
        );
    });
});

// ─── Bug regression tests ──────────────────────────────────────────────────────

describe('KodyRulesSyncService — Bug: path scoping from sourcePath (Bug 1)', () => {
    const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };
    const repository = {
        id: 'repo-1',
        name: 'backend-services',
        fullName: 'quintoandar/backend-services',
        defaultBranch: 'main',
    };

    // syncSingleFileFromMain (called when `path` is provided) uses kodyRulesService.createOrUpdate
    function buildService(llmReturnedPath: string, configuredDirectories: Array<{ id: string; path: string }> = []) {
        const kodyRulesService = {
            // used by findRuleBySourcePath (dedup check)
            findByOrganizationId: jest.fn().mockResolvedValue({ rules: [] }),
            // used by syncSingleFileFromMain to persist the rule
            createOrUpdate: jest.fn().mockResolvedValue({ uuid: 'rule-new' }),
        };
        const parametersService = {
            findByKey: jest.fn().mockResolvedValue({
                configValue: {
                    repositories: [
                        {
                            id: 'repo-1',
                            configs: { ideRulesSyncEnabled: true },
                            directories: configuredDirectories,
                        },
                    ],
                },
            }),
        };
        const codeManagementService = {
            getDefaultBranch: jest.fn().mockResolvedValue('main'),
            getRepositoryAllFiles: jest.fn(),
            getRepositoryContentFile: jest.fn().mockResolvedValue({
                data: {
                    content: Buffer.from('Java Spring Architecture rules', 'utf-8').toString('base64'),
                    encoding: 'base64',
                },
            }),
        };

        const service = new KodyRulesSyncService(
            kodyRulesService as any,
            parametersService as any,
            {} as any, // contextResolutionService
            codeManagementService as any,
            { execute: jest.fn().mockResolvedValue(undefined) } as any, // updateOrCreateCodeReviewParameterUseCase
            {} as any, // createOrUpdateKodyRulesUseCase (unused for this path)
            {} as any, // promptRunnerService
            { validateBasicLicense: jest.fn().mockResolvedValue({ allowed: true }), getBYOKConfig: jest.fn().mockResolvedValue(undefined) } as any,
            {} as any, // observabilityService
            {} as any, // contextReferenceDetectionService
        );

        jest.spyOn(service as any, 'convertFileToKodyRules').mockResolvedValue([
            {
                title: 'Java/Spring Architecture Rule',
                rule: 'Enforce hexagonal architecture conventions',
                path: llmReturnedPath,
                severity: 'high',
                scope: 'file',
                examples: [],
            },
        ]);
        jest.spyOn(service as any, 'processContextReferences').mockResolvedValue(undefined);

        return { service, kodyRulesService };
    }

    it('scopes path to the subdirectory when LLM returns "**/*" for a .cursorrules in a subdirectory', async () => {
        // BUG: a .cursorrules at applications/backoffice-bff/.cursorrules should produce
        // path: "applications/backoffice-bff/**/*", NOT "**/*"
        // The directory must be configured so the path passes the isFileMatchingGlob guard.
        const { service, kodyRulesService } = buildService('**/*', [
            { id: 'dir-bff', path: 'applications/backoffice-bff' },
        ]);

        await service.syncRepositoryMain({
            organizationAndTeamData,
            repository,
            path: 'applications/backoffice-bff/.cursorrules',
        });

        expect(kodyRulesService.createOrUpdate).toHaveBeenCalledWith(
            organizationAndTeamData,
            expect.objectContaining({
                path: 'applications/backoffice-bff/**/*',
                sourcePath: 'applications/backoffice-bff/.cursorrules',
            }),
            expect.any(Object),
        );
    });

    it('keeps "**/*" unchanged when the source file is at the repo root', async () => {
        // A .cursorrules at root should legitimately apply to all files — no scoping needed.
        const { service, kodyRulesService } = buildService('**/*');

        await service.syncRepositoryMain({
            organizationAndTeamData,
            repository,
            path: '.cursorrules',
        });

        expect(kodyRulesService.createOrUpdate).toHaveBeenCalledWith(
            organizationAndTeamData,
            expect.objectContaining({
                path: '**/*',
                sourcePath: '.cursorrules',
            }),
            expect.any(Object),
        );
    });

    it('keeps an explicit glob returned by the LLM untouched regardless of source depth', async () => {
        // If the .cursorrules file explicitly declares its own globs, preserve them.
        const { service, kodyRulesService } = buildService('src/**,test/**', [
            { id: 'dir-bff', path: 'applications/backoffice-bff' },
        ]);

        await service.syncRepositoryMain({
            organizationAndTeamData,
            repository,
            path: 'applications/backoffice-bff/.cursorrules',
        });

        expect(kodyRulesService.createOrUpdate).toHaveBeenCalledWith(
            organizationAndTeamData,
            expect.objectContaining({
                path: 'src/**,test/**',
                sourcePath: 'applications/backoffice-bff/.cursorrules',
            }),
            expect.any(Object),
        );
    });
});

describe('KodyRulesSyncService — Bug: orphaned rules after IDE sync toggle-off (Bug 2)', () => {
    const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };

    function buildServiceForCleanup(existingRules: any[]) {
        const kodyRulesService = {
            findByOrganizationId: jest
                .fn()
                .mockResolvedValue({ rules: existingRules }),
            // Soft-delete flips status via createOrUpdate — no hard-delete use case needed.
            createOrUpdate: jest.fn().mockResolvedValue({ uuid: 'rule-updated' }),
        };

        const service = new KodyRulesSyncService(
            kodyRulesService as any,
            {} as any, // parametersService
            {} as any, // contextResolutionService
            {} as any, // codeManagementService
            {} as any, // updateOrCreateCodeReviewParameterUseCase
            {} as any, // createOrUpdateKodyRulesUseCase
            {} as any, // promptRunnerService
            {} as any, // permissionValidationService
            {} as any, // observabilityService
            {} as any, // contextReferenceDetectionService
        );

        return { service, kodyRulesService };
    }

    it('soft-deletes (status=DELETED) all rules with a sourcePath when IDE sync is purged for a repository', async () => {
        // BUG: when the user turns off ideRulesSyncEnabled, rules imported from
        // .cursorrules/.cursor/rules files (identified by non-null sourcePath) persist
        // indefinitely as orphans. Purge flips their status to DELETED, which keeps the
        // record for audit/undo while removing it from the active rule set (filterKodyRules
        // drops any rule whose status !== ACTIVE).
        const { service, kodyRulesService } = buildServiceForCleanup([
            { uuid: 'rule-from-bff', repositoryId: 'repo-1', sourcePath: 'applications/backoffice-bff/.cursorrules', status: 'active' },
            { uuid: 'rule-from-sales', repositoryId: 'repo-1', sourcePath: 'applications/sales-flow/.cursor/rules/arch.mdc', status: 'active' },
            { uuid: 'rule-user-created', repositoryId: 'repo-1', sourcePath: null, status: 'active' },
            { uuid: 'rule-other-repo', repositoryId: 'repo-2', sourcePath: 'some/.cursorrules', status: 'active' },
        ]);

        await (service as any).purgeAllIdeSyncRulesForRepository({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        });

        expect(kodyRulesService.createOrUpdate).toHaveBeenCalledTimes(2);
        expect(kodyRulesService.createOrUpdate).toHaveBeenCalledWith(
            organizationAndTeamData,
            expect.objectContaining({ uuid: 'rule-from-bff', status: 'deleted' }),
            expect.any(Object),
        );
        expect(kodyRulesService.createOrUpdate).toHaveBeenCalledWith(
            organizationAndTeamData,
            expect.objectContaining({ uuid: 'rule-from-sales', status: 'deleted' }),
            expect.any(Object),
        );
    });

    it('does not touch user-created rules (sourcePath is null) during purge', async () => {
        const { service, kodyRulesService } = buildServiceForCleanup([
            { uuid: 'rule-hand-authored', repositoryId: 'repo-1', sourcePath: null, status: 'active' },
            { uuid: 'rule-no-source', repositoryId: 'repo-1', sourcePath: undefined, status: 'active' },
        ]);

        await (service as any).purgeAllIdeSyncRulesForRepository({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        });

        expect(kodyRulesService.createOrUpdate).not.toHaveBeenCalled();
    });

    it('does not touch rules from other repositories during purge', async () => {
        const { service, kodyRulesService } = buildServiceForCleanup([
            { uuid: 'rule-repo-2', repositoryId: 'repo-2', sourcePath: 'some/.cursorrules', status: 'active' },
        ]);

        await (service as any).purgeAllIdeSyncRulesForRepository({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        });

        expect(kodyRulesService.createOrUpdate).not.toHaveBeenCalled();
    });
});
