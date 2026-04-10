import { Test, TestingModule } from '@nestjs/testing';
import { CloneParamsResolverService } from '@libs/code-review/pipeline/services/clone-params-resolver.service';
import { CreateSandboxStage } from '@/code-review/pipeline/stages/create-sandbox.stage';
import {
    ISandboxProvider,
    SANDBOX_PROVIDER_TOKEN,
} from '@/code-review/domain/contracts/sandbox.provider';
import { CodeManagementService } from '@/platform/infrastructure/adapters/services/codeManagement.service';
import { CodeReviewPipelineContext } from '@/code-review/pipeline/context/code-review-pipeline.context';
import { PlatformType } from '@/core/domain/enums';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('CreateSandboxStage', () => {
    let stage: CreateSandboxStage;
    let mockSandboxProvider: jest.Mocked<ISandboxProvider>;
    let mockCodeManagementService: jest.Mocked<CodeManagementService>;

    let mockCloneParamsResolver: any;

    const createBaseContext = (
        overrides: Partial<CodeReviewPipelineContext> = {},
    ): CodeReviewPipelineContext =>
        ({
            dryRun: { enabled: false },
            organizationAndTeamData: {
                organizationId: 'org-123',
                teamId: 'team-456',
            } as any,
            repository: {
                id: 'repo-1',
                name: 'test-repo',
                fullName: 'org/test-repo',
                defaultBranch: 'main',
            } as any,
            branch: 'feature-branch',
            pullRequest: {
                number: 42,
                title: 'Test PR',
                base: { repo: { fullName: 'org/repo' }, ref: 'main' },
                repository: {} as any,
                isDraft: false,
                stats: {
                    total_additions: 10,
                    total_deletions: 5,
                    total_files: 2,
                    total_lines_changed: 15,
                },
            },
            teamAutomationId: 'team-auto-1',
            origin: 'github',
            action: 'opened',
            platformType: PlatformType.GITHUB,
            preparedFileContexts: [],
            validSuggestions: [],
            discardedSuggestions: [],
            correlationId: 'test-correlation-id',
            ...overrides,
        }) as CodeReviewPipelineContext;

    beforeEach(async () => {
        mockSandboxProvider = {
            isAvailable: jest.fn().mockReturnValue(true),
            createSandboxWithRepo: jest.fn().mockResolvedValue({
                remoteCommands: {
                    grep: jest.fn(),
                    read: jest.fn(),
                    listDir: jest.fn(),
                },
                cleanup: jest.fn(),
            }),
        };

        mockCodeManagementService = {
            getCloneParams: jest.fn().mockResolvedValue({
                url: 'https://github.com/org/test-repo.git',
                auth: { token: 'ghp_test_token' },
            }),
        } as any;

        mockCloneParamsResolver = {
            resolve: jest.fn().mockResolvedValue({
                url: 'https://github.com/org/test-repo.git',
                authToken: 'ghp_test_token',
                branch: 'feature-branch',
                prNumber: 42,
                platform: PlatformType.GITHUB,
            }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CreateSandboxStage,
                {
                    provide: SANDBOX_PROVIDER_TOKEN,
                    useValue: mockSandboxProvider,
                },
                {
                    provide: CodeManagementService,
                    useValue: mockCodeManagementService,
                },
                {
                    provide: CloneParamsResolverService,
                    useValue: mockCloneParamsResolver,
                },
            ],
        }).compile();

        stage = module.get<CreateSandboxStage>(CreateSandboxStage);
    });

    it('should have correct stage name', () => {
        expect(stage.stageName).toBe('CreateSandboxStage');
    });

    describe('guard conditions', () => {
        it('should skip if sandbox already exists in context', async () => {
            const context = createBaseContext({
                changedFiles: [{ filename: 'test.ts' } as any],
                sandboxHandle: {
                    type: 'e2b' as const,
                    remoteCommands: {
                        grep: jest.fn(),
                        read: jest.fn(),
                        listDir: jest.fn(),
                    },
                    cleanup: jest.fn(),
                },
            });

            const result = await (stage as any).executeStage(context);

            expect(
                mockSandboxProvider.createSandboxWithRepo,
            ).not.toHaveBeenCalled();
            expect(result.sandboxHandle).toBeDefined();
        });

        it('should skip if no changed files', async () => {
            const context = createBaseContext({ changedFiles: [] });

            const _result = await (stage as any).executeStage(context);

            expect(
                mockSandboxProvider.createSandboxWithRepo,
            ).not.toHaveBeenCalled();
        });

        it('should skip if sandbox provider is not available', async () => {
            mockSandboxProvider.isAvailable.mockReturnValue(false);

            const context = createBaseContext({
                changedFiles: [{ filename: 'test.ts' } as any],
            });

            const _result = await (stage as any).executeStage(context);

            expect(
                mockSandboxProvider.createSandboxWithRepo,
            ).not.toHaveBeenCalled();
        });
    });

    describe('sandbox creation', () => {
        it('should create sandbox and store in context', async () => {
            const context = createBaseContext({
                changedFiles: [{ filename: 'test.ts' } as any],
            });

            const result = await (stage as any).executeStage(context);

            expect(
                mockSandboxProvider.createSandboxWithRepo,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    cloneUrl: 'https://github.com/org/test-repo.git',
                    authToken: 'ghp_test_token',
                    branch: 'feature-branch',
                    prNumber: 42,
                    platform: PlatformType.GITHUB,
                }),
            );

            expect(result.sandboxHandle).toBeDefined();
            expect(result.sandboxHandle.remoteCommands).toBeDefined();
            expect(result.getFreshCloneParams).toBeDefined();

            const freshParams = await result.getFreshCloneParams!();
            expect(freshParams.cloneUrl).toBe(
                'https://github.com/org/test-repo.git',
            );
        });

        it('should handle sandbox creation failure gracefully', async () => {
            mockSandboxProvider.createSandboxWithRepo.mockRejectedValue(
                new Error('E2B timeout'),
            );

            const context = createBaseContext({
                changedFiles: [{ filename: 'test.ts' } as any],
            });

            // Should NOT throw
            const result = await (stage as any).executeStage(context);

            expect(result.sandboxHandle).toBeUndefined();
        });
    });
});
