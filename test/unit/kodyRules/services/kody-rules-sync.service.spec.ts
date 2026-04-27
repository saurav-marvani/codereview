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
            {} as any, // createOrUpdateKodyRulesUseCase
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

    it('pauseAllIdeSyncRulesForRepository flips ACTIVE rules to PAUSED, leaves PAUSED/DELETED alone', async () => {
        const { service, kodyRulesService } = buildServiceForCleanup([
            { uuid: 'rule-active', repositoryId: 'repo-1', sourcePath: '.cursorrules', status: 'active' },
            { uuid: 'rule-already-paused', repositoryId: 'repo-1', sourcePath: '.cursorrules', status: 'paused' },
            { uuid: 'rule-deleted', repositoryId: 'repo-1', sourcePath: '.cursorrules', status: 'deleted' },
            { uuid: 'rule-onboard', repositoryId: 'repo-1', sourcePath: 'package.json', status: 'active' },
        ]);

        await (service as any).pauseAllIdeSyncRulesForRepository({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        });

        // Only the ACTIVE auto-sync rule is touched
        expect(kodyRulesService.createOrUpdate).toHaveBeenCalledTimes(1);
        expect(kodyRulesService.createOrUpdate).toHaveBeenCalledWith(
            organizationAndTeamData,
            expect.objectContaining({ uuid: 'rule-active', status: 'paused' }),
            expect.any(Object),
        );
    });

    it('resumeAllIdeSyncRulesForRepository flips PAUSED rules back to ACTIVE, leaves DELETED alone', async () => {
        const { service, kodyRulesService } = buildServiceForCleanup([
            { uuid: 'rule-paused-1', repositoryId: 'repo-1', sourcePath: '.cursorrules', status: 'paused' },
            { uuid: 'rule-paused-2', repositoryId: 'repo-1', sourcePath: 'apps/foo/.cursor/rules/x.mdc', status: 'paused' },
            { uuid: 'rule-active', repositoryId: 'repo-1', sourcePath: '.cursorrules', status: 'active' },
            { uuid: 'rule-deleted', repositoryId: 'repo-1', sourcePath: '.cursorrules', status: 'deleted' },
        ]);

        await (service as any).resumeAllIdeSyncRulesForRepository({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        });

        // Only PAUSED auto-sync rules are flipped — DELETED is not resurrected here
        expect(kodyRulesService.createOrUpdate).toHaveBeenCalledTimes(2);
        const flipped = (kodyRulesService.createOrUpdate as jest.Mock).mock.calls.map(
            ([, rule]) => rule.uuid,
        );
        expect(flipped.sort()).toEqual(['rule-paused-1', 'rule-paused-2']);
        for (const call of (kodyRulesService.createOrUpdate as jest.Mock).mock.calls) {
            expect(call[1].status).toBe('active');
        }
    });

    it('countIdeSyncRulesForRepository tallies active/paused/deleted IDE-synced rules', async () => {
        const { service } = buildServiceForCleanup([
            { uuid: 'a1', repositoryId: 'repo-1', sourcePath: '.cursorrules', status: 'active' },
            { uuid: 'a2', repositoryId: 'repo-1', sourcePath: 'CLAUDE.md', status: 'active' },
            { uuid: 'p1', repositoryId: 'repo-1', sourcePath: '.cursorrules', status: 'paused' },
            { uuid: 'd1', repositoryId: 'repo-1', sourcePath: '.cursorrules', status: 'deleted' },
            // NOT counted: Onboard rule (sourcePath outside RULE_FILE_PATTERNS)
            { uuid: 'o1', repositoryId: 'repo-1', sourcePath: 'package.json', status: 'active' },
            // NOT counted: rule from another repo
            { uuid: 'r2', repositoryId: 'repo-2', sourcePath: '.cursorrules', status: 'active' },
        ]);

        const counts = await (service as any).countIdeSyncRulesForRepository({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        });

        expect(counts).toEqual({ active: 2, paused: 1, deleted: 1 });
    });

    it('does not touch Onboard-origin rules (sourcePath outside RULE_FILE_PATTERNS) during purge', async () => {
        // REGRESSION: previously the filter was `sourcePath != null`, which
        // erroneously matched rules from the Onboard flow (which also persist
        // sourcePath, but pointing at files like package.json / esbuild.config.js
        // that are not in the IDE-rule pattern set). Toggling IDE auto-sync off
        // would silently delete those Onboard rules. The filter now requires
        // the sourcePath to match RULE_FILE_PATTERNS via isIdeRuleSource.
        const { service, kodyRulesService } = buildServiceForCleanup([
            // Auto-sync rules — should be purged
            { uuid: 'rule-cursor-root', repositoryId: 'repo-1', sourcePath: '.cursorrules', status: 'active' },
            { uuid: 'rule-cursor-subdir', repositoryId: 'repo-1', sourcePath: 'applications/foo/.cursor/rules/api.mdc', status: 'active' },
            // Onboard rules with sourcePath outside RULE_FILE_PATTERNS — should be left alone
            { uuid: 'rule-onboard-pkg', repositoryId: 'repo-1', sourcePath: 'package.json', status: 'active' },
            { uuid: 'rule-onboard-esbuild', repositoryId: 'repo-1', sourcePath: 'esbuild.config.js', status: 'active' },
            { uuid: 'rule-onboard-tsconfig', repositoryId: 'repo-1', sourcePath: 'apps/web/tsconfig.json', status: 'active' },
        ]);

        await (service as any).purgeAllIdeSyncRulesForRepository({
            organizationAndTeamData,
            repositoryId: 'repo-1',
        });

        expect(kodyRulesService.createOrUpdate).toHaveBeenCalledTimes(2);
        const purgedUuids = (kodyRulesService.createOrUpdate as jest.Mock).mock.calls.map(
            ([, rule]) => rule.uuid,
        );
        expect(purgedUuids.sort()).toEqual(['rule-cursor-root', 'rule-cursor-subdir']);
    });
});

describe('KodyRulesSyncService.scopePathToSourceDirectory', () => {
    function buildBareService() {
        return new KodyRulesSyncService(
            {} as any, {} as any, {} as any, {} as any, {} as any,
            {} as any, {} as any, {} as any, {} as any, {} as any,
        );
    }

    const cases: Array<{
        name: string;
        llmPath: string;
        sourceFilePath: string;
        expected: string;
    }> = [
        // BUG REGRESSION: rule at .cursor/rules/foo.mdc must NOT scope to
        // ".cursor/rules/**/*" (would lint the rule files themselves).
        {
            name: 'root .cursor/rules/foo.mdc → repo-wide **/*',
            llmPath: '**/*',
            sourceFilePath: '.cursor/rules/foo.mdc',
            expected: '**/*',
        },
        {
            name: 'subdir .cursor/rules/x.mdc strips the IDE marker',
            llmPath: '**/*',
            sourceFilePath: 'applications/foo/.cursor/rules/x.mdc',
            expected: 'applications/foo/**/*',
        },
        {
            name: 'root .cursorrules → repo-wide **/*',
            llmPath: '**/*',
            sourceFilePath: '.cursorrules',
            expected: '**/*',
        },
        {
            name: 'subdir .cursorrules scopes to that subdir',
            llmPath: '**/*',
            sourceFilePath: 'applications/bar/.cursorrules',
            expected: 'applications/bar/**/*',
        },
        {
            name: 'root CLAUDE.md → repo-wide **/*',
            llmPath: '**/*',
            sourceFilePath: 'CLAUDE.md',
            expected: '**/*',
        },
        {
            name: 'subdir CLAUDE.md scopes to that subdir',
            llmPath: '**/*',
            sourceFilePath: 'applications/baz/CLAUDE.md',
            expected: 'applications/baz/**/*',
        },
        {
            name: 'subdir .kody/rules/* strips the IDE marker',
            llmPath: '**/*',
            sourceFilePath: 'apps/api/.kody/rules/security.md',
            expected: 'apps/api/**/*',
        },
        {
            name: 'root .kody/rules/* → repo-wide **/*',
            llmPath: '**/*',
            sourceFilePath: '.kody/rules/security.md',
            expected: '**/*',
        },
        {
            name: 'explicit non-** glob is preserved',
            llmPath: 'src/**/*.ts',
            sourceFilePath: '.cursor/rules/foo.mdc',
            expected: 'src/**/*.ts',
        },
        {
            name: 'explicit comma-separated globs are preserved',
            llmPath: 'src/**/*.ts,src/**/*.tsx',
            sourceFilePath: '.kody/rules/x.md',
            expected: 'src/**/*.ts,src/**/*.tsx',
        },
        {
            name: '.github/instructions root → repo-wide',
            llmPath: '**/*',
            sourceFilePath: '.github/instructions/api.instructions.md',
            expected: '**/*',
        },
    ];

    for (const c of cases) {
        it(c.name, () => {
            const service = buildBareService();
            const result = (service as any).scopePathToSourceDirectory(
                c.llmPath,
                c.sourceFilePath,
            );
            expect(result).toBe(c.expected);
        });
    }
});

describe('KodyRulesSyncService.getConfiguredDirectories', () => {
    const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };

    function buildService(repositories: any[]) {
        const parametersService = {
            findByKey: jest.fn().mockResolvedValue({
                configValue: { repositories },
            }),
        };
        const service = new KodyRulesSyncService(
            {} as any, // kodyRulesService
            parametersService as any,
            {} as any, // contextResolutionService
            {} as any, // codeManagementService
            {} as any, // updateOrCreateCodeReviewParameterUseCase
            {} as any, // createOrUpdateKodyRulesUseCase
            {} as any, // promptRunnerService
            {} as any, // permissionValidationService
            {} as any, // observabilityService
            {} as any, // contextReferenceDetectionService
        );
        return service;
    }

    it('returns the configured directory paths for the repository', async () => {
        // REGRESSION: TypeScript was complaining "Property 'path' does not
        // exist on type 'DirectoryCodeReviewConfig'" because the formal type
        // models nested `folders[]` while the persisted shape carries `path`
        // directly on each entry. The implementation now narrows via runtime
        // typeof check and returns only the valid string paths.
        const service = buildService([
            {
                id: 'repo-1',
                directories: [
                    { id: 'd1', path: 'apps/web' },
                    { id: 'd2', path: 'apps/api' },
                ],
            },
        ]);

        const dirs = await (service as any).getConfiguredDirectories(
            organizationAndTeamData,
            'repo-1',
        );

        expect(dirs.sort()).toEqual(['apps/api', 'apps/web']);
    });

    it('skips entries that do not have a string `path`', async () => {
        const service = buildService([
            {
                id: 'repo-1',
                directories: [
                    { id: 'd1', path: 'apps/web' },
                    { id: 'd2' /* path missing */ },
                    { id: 'd3', path: null },
                    { id: 'd4', path: 42 as any },
                ],
            },
        ]);

        const dirs = await (service as any).getConfiguredDirectories(
            organizationAndTeamData,
            'repo-1',
        );

        expect(dirs).toEqual(['apps/web']);
    });

    it('returns [] when the repo has no directories configured', async () => {
        const service = buildService([
            { id: 'repo-1', directories: [] },
        ]);

        const dirs = await (service as any).getConfiguredDirectories(
            organizationAndTeamData,
            'repo-1',
        );

        expect(dirs).toEqual([]);
    });

    it('returns [] when repositoryId is missing', async () => {
        const service = buildService([
            { id: 'repo-1', directories: [{ id: 'd1', path: 'apps/web' }] },
        ]);

        const dirs = await (service as any).getConfiguredDirectories(
            organizationAndTeamData,
            undefined,
        );

        expect(dirs).toEqual([]);
    });
});
