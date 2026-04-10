import { Test, TestingModule } from '@nestjs/testing';
import { AgentReviewStage } from '@/code-review/pipeline/stages/agent-review.stage';
import { ReviewOrchestratorService } from '@/code-review/infrastructure/agents/review-orchestrator.service';
import { ObservabilityService } from '@/core/log/observability.service';
import { AUTOMATION_EXECUTION_SERVICE_TOKEN } from '@/automation/domain/automationExecution/contracts/automation-execution.service';
import { KodusGraphService } from '@/code-review/infrastructure/adapters/services/kodusGraph.service';
import { RepositoryRepository } from '@/code-review/infrastructure/adapters/repositories/repository.repository';
import { CodeReviewPipelineContext } from '@/code-review/pipeline/context/code-review-pipeline.context';
import { PlatformType } from '@/core/domain/enums';
import { CodeReviewVersion } from '@/core/domain/enums/code-review.enum';

jest.mock('ai', () => ({
    generateText: jest.fn().mockResolvedValue({
        object: { classifications: [] },
        output: { classifications: [] },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    }),
    Output: { object: jest.fn().mockReturnValue({}) },
    jsonSchema: jest.fn().mockReturnValue({}),
}));

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('AgentReviewStage', () => {
    let stage: AgentReviewStage;
    let mockOrchestrator: jest.Mocked<ReviewOrchestratorService>;

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
            } as any,
            branch: 'main',
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
            codeReviewConfig: {
                codeReviewVersion: CodeReviewVersion.V3_AGENT,
                reviewOptions: { bug: true, security: true, performance: true },
            } as any,
            preparedFileContexts: [],
            validSuggestions: [],
            discardedSuggestions: [],
            correlationId: 'test-correlation-id',
            ...overrides,
        }) as CodeReviewPipelineContext;

    beforeEach(async () => {
        mockOrchestrator = {
            execute: jest.fn().mockResolvedValue({
                suggestions: [
                    {
                        relevantFile: 'src/auth.ts',
                        suggestionContent: 'Missing null check',
                        label: 'bug',
                        severity: 'high',
                        relevantLinesStart: 10,
                        relevantLinesEnd: 15,
                    },
                    {
                        relevantFile: 'src/api.ts',
                        suggestionContent: 'XSS vulnerability',
                        label: 'security',
                        severity: 'critical',
                        relevantLinesStart: 20,
                        relevantLinesEnd: 25,
                    },
                ],
                agentResults: [
                    {
                        agentName: 'bug-agent',
                        suggestions: [{}],
                        turnsUsed: 3,
                        durationMs: 1000,
                    },
                    {
                        agentName: 'security-agent',
                        suggestions: [{}],
                        turnsUsed: 5,
                        durationMs: 2000,
                    },
                ],
                totalDurationMs: 2500,
            }),
        } as any;

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AgentReviewStage,
                {
                    provide: ReviewOrchestratorService,
                    useValue: mockOrchestrator,
                },
                {
                    provide: ObservabilityService,
                    useValue: {
                        runInSpan: jest.fn((_name: string, fn: any) => fn()),
                    },
                },
                {
                    provide: AUTOMATION_EXECUTION_SERVICE_TOKEN,
                    useValue: {
                        updateCodeReview: jest.fn(),
                        findLatestStageLog: jest.fn(),
                        updateStageLog: jest.fn(),
                    },
                },
                {
                    provide: KodusGraphService,
                    useValue: {
                        generateContext: jest.fn().mockResolvedValue(''),
                        generateContextLegacy: jest.fn().mockResolvedValue(''),
                    },
                },
                {
                    provide: RepositoryRepository,
                    useValue: {
                        findOrCreate: jest.fn(),
                        findByExternalId: jest.fn(),
                        updateStatus: jest.fn(),
                    },
                },
            ],
        }).compile();

        stage = module.get<AgentReviewStage>(AgentReviewStage);
    });

    it('should have correct stage name', () => {
        expect(stage.stageName).toBe('AgentReviewStage');
    });

    describe('guard conditions', () => {
        it('should skip when no changed files', async () => {
            const context = createBaseContext({ changedFiles: [] });

            const result = await (stage as any).executeStage(context);

            expect(mockOrchestrator.execute).not.toHaveBeenCalled();
            expect(result.fileAnalysisResults).toBeUndefined();
        });

        it('should skip when no sandbox handle', async () => {
            const context = createBaseContext({
                changedFiles: [{ filename: 'src/index.ts' } as any],
                sandboxHandle: undefined,
            });

            const _result = await (stage as any).executeStage(context);

            expect(mockOrchestrator.execute).not.toHaveBeenCalled();
        });
    });

    describe('execution', () => {
        it('should call orchestrator with correct input', async () => {
            const changedFiles = [
                { filename: 'src/auth.ts', patch: '+code' } as any,
                { filename: 'src/api.ts', patch: '+more code' } as any,
            ];

            const context = createBaseContext({
                changedFiles,
                sandboxHandle: {
                    remoteCommands: {
                        grep: jest.fn(),
                        read: jest.fn(),
                        listDir: jest.fn(),
                    },
                    cleanup: jest.fn(),
                    type: 'e2b' as const,
                },
                codeReviewConfig: {
                    codeReviewVersion: CodeReviewVersion.V3_AGENT,
                    reviewOptions: {
                        bug: true,
                        security: true,
                        performance: false,
                    },
                    languageResultPrompt: 'pt-BR',
                } as any,
            });

            await (stage as any).executeStage(context);

            expect(mockOrchestrator.execute).toHaveBeenCalledWith(
                expect.objectContaining({
                    prNumber: 42,
                    changedFiles,
                    languageResultPrompt: 'pt-BR',
                    reviewOptions: {
                        bug: true,
                        security: true,
                        performance: false,
                    },
                }),
            );
        });

        it('should group suggestions by file into fileAnalysisResults', async () => {
            const changedFiles = [
                { filename: 'src/auth.ts' } as any,
                { filename: 'src/api.ts' } as any,
            ];

            const context = createBaseContext({
                changedFiles,
                sandboxHandle: {
                    remoteCommands: {
                        grep: jest.fn(),
                        read: jest.fn(),
                        listDir: jest.fn(),
                    },
                    cleanup: jest.fn(),
                    type: 'e2b' as const,
                },
            });

            const result = await (stage as any).executeStage(context);

            expect(result.fileAnalysisResults).toHaveLength(2);

            const authResult = result.fileAnalysisResults.find(
                (r: any) => r.file.filename === 'src/auth.ts',
            );
            expect(authResult.validSuggestionsToAnalyze).toHaveLength(1);
            expect(authResult.validSuggestionsToAnalyze[0].label).toBe('bug');

            const apiResult = result.fileAnalysisResults.find(
                (r: any) => r.file.filename === 'src/api.ts',
            );
            expect(apiResult.validSuggestionsToAnalyze).toHaveLength(1);
            expect(apiResult.validSuggestionsToAnalyze[0].label).toBe(
                'security',
            );
        });

        it('should set empty discardedSuggestions for each file', async () => {
            const context = createBaseContext({
                changedFiles: [{ filename: 'src/auth.ts' } as any],
                sandboxHandle: {
                    remoteCommands: {
                        grep: jest.fn(),
                        read: jest.fn(),
                        listDir: jest.fn(),
                    },
                    cleanup: jest.fn(),
                    type: 'e2b' as const,
                },
            });

            const result = await (stage as any).executeStage(context);

            for (const fileResult of result.fileAnalysisResults) {
                expect(fileResult.discardedSuggestionsBySafeGuard).toEqual([]);
            }
        });
    });

    describe('error handling', () => {
        it('should return empty results on orchestrator failure', async () => {
            mockOrchestrator.execute.mockRejectedValue(
                new Error('Agent loop crashed'),
            );

            const context = createBaseContext({
                changedFiles: [{ filename: 'src/index.ts' } as any],
                sandboxHandle: {
                    remoteCommands: {
                        grep: jest.fn(),
                        read: jest.fn(),
                        listDir: jest.fn(),
                    },
                    cleanup: jest.fn(),
                    type: 'e2b' as const,
                },
            });

            const result = await (stage as any).executeStage(context);

            expect(result.fileAnalysisResults).toEqual([]);
        });
    });
});
