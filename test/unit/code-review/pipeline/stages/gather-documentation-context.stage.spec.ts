import {
    BYOKProviderService,
    LLMProviderService,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { type IPullRequestManagerService } from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import { DocumentationLLMPlannerService } from '@libs/code-review/infrastructure/adapters/services/documentation-llm-planner.service';
import { DocumentationPackageDiscoveryService } from '@libs/code-review/infrastructure/adapters/services/documentation-package-discovery.service';
import { DocumentationSearchCacheService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-cache.service';
import { DocumentationSearchExaService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { GatherDocumentationContextStage } from '@libs/code-review/pipeline/stages/gather-documentation-context.stage';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

describe('GatherDocumentationContextStage', () => {
    let stage: GatherDocumentationContextStage;
    let discoveryService: jest.Mocked<DocumentationPackageDiscoveryService>;
    let plannerService: jest.Mocked<DocumentationLLMPlannerService>;
    let searchService: jest.Mocked<DocumentationSearchExaService>;

    const baseContext = {
        pullRequest: { number: 7 },
        repository: { id: 'r1', name: 'repo' },
        organizationAndTeamData: { organizationId: 'o1', teamId: 't1' },
        changedFiles: [
            {
                filename: 'src/a.ts',
                patch: '@@ -1,1 +1,1 @@',
                fileContent: 'import { Controller } from "@nestjs/common";',
            },
        ],
    } as unknown as CodeReviewPipelineContext;

    type FixtureInput = {
        pullRequestNumber?: number;
        repositoryId?: string;
        repositoryName?: string;
        organizationId?: string;
        teamId?: string;
        changedFiles: Array<
            Pick<
                FileChange,
                'filename' | 'patch' | 'patchWithLinesStr' | 'fileContent'
            >
        >;
    };

    const independentFixture: FixtureInput = {
        pullRequestNumber: 123,
        repositoryId: 'tmp-repo-id',
        repositoryName: 'kodus-ai',
        organizationId: '00000000-0000-0000-0000-000000000000',
        teamId: '00000000-0000-0000-0000-000000000000',
        changedFiles: [
            {
                filename: 'package.json',
                fileContent: JSON.stringify(
                    {
                        dependencies: {
                            '@nestjs/common': '^11.1.14',
                            'typeorm': '^0.3.28',
                        },
                    },
                    null,
                    2,
                ),
                patch: '@@ -1,1 +1,1 @@',
            },
            {
                filename: 'apps/api/src/example.controller.ts',
                fileContent:
                    "import { Controller, Get } from '@nestjs/common';\n\n@Controller('example')\nexport class ExampleController {\n  @Get()\n  findAll() {\n    return [];\n  }\n}\n",
                patch: '@@ -0,0 +1,9 @@',
            },
        ],
    };

    function buildIndependentContext(
        fixtureInput: FixtureInput,
    ): CodeReviewPipelineContext {
        return {
            pullRequest: {
                number: fixtureInput.pullRequestNumber ?? 123,
            },
            repository: {
                id: fixtureInput.repositoryId ?? 'repo-id',
                name: fixtureInput.repositoryName ?? 'repo-name',
            },
            organizationAndTeamData: {
                organizationId:
                    fixtureInput.organizationId ??
                    '00000000-0000-0000-0000-000000000000',
                teamId:
                    fixtureInput.teamId ??
                    '00000000-0000-0000-0000-000000000000',
            },
            changedFiles: fixtureInput.changedFiles.map((file) => ({
                filename: file.filename,
                patch: file.patch || '',
                patchWithLinesStr: file.patchWithLinesStr || file.patch || '',
                fileContent: file.fileContent || '',
            })),
            codeReviewConfig: {},
        } as unknown as CodeReviewPipelineContext;
    }

    function buildPromptRunnerServiceMock(): PromptRunnerService {
        const service = {
            builder: jest.fn(() => {
                const state: { payload?: any } = {};

                return {
                    setProviders: jest.fn().mockReturnThis(),
                    setBYOKConfig: jest.fn().mockReturnThis(),
                    setBYOKFallbackConfig: jest.fn().mockReturnThis(),
                    setParser: jest.fn().mockReturnThis(),
                    setLLMJsonMode: jest.fn().mockReturnThis(),
                    setPayload: jest.fn(function (payload: any) {
                        state.payload = payload;
                        return this;
                    }),
                    addPrompt: jest.fn().mockReturnThis(),
                    setTemperature: jest.fn().mockReturnThis(),
                    setRunName: jest.fn().mockReturnThis(),
                    execute: jest.fn(async () => {
                        const filePath = state.payload?.file?.filePath || '';
                        const isNestFile =
                            filePath.endsWith('.ts') ||
                            String(
                                state.payload?.file?.fileContent || '',
                            ).includes('@nestjs/common');

                        return {
                            filePath,
                            relevantPackages: isNestFile
                                ? ['@nestjs/common', 'typeorm']
                                : ['typeorm'],
                            queries: isNestFile
                                ? [
                                      'NestJS official controller and route handler documentation',
                                      'TypeORM official docs for entity and repository usage with NestJS',
                                  ]
                                : ['TypeORM official docs for configuration'],
                        };
                    }),
                };
            }),
        };

        return service as unknown as PromptRunnerService;
    }

    function buildRealPromptRunnerService(): PromptRunnerService {
        const logger = new Logger('DocumentationPromptIntegrationTest');
        const byokProviderService = new BYOKProviderService();
        const llmProviderService = new LLMProviderService(
            logger,
            byokProviderService,
        );

        return new PromptRunnerService(logger, llmProviderService);
    }

    beforeEach(async () => {
        discoveryService = {
            discoverPackages: jest.fn(),
        } as unknown as jest.Mocked<DocumentationPackageDiscoveryService>;

        plannerService = {
            planDocumentationByFile: jest.fn(),
        } as unknown as jest.Mocked<DocumentationLLMPlannerService>;

        searchService = {
            searchByFilePlan: jest.fn(),
        } as unknown as jest.Mocked<DocumentationSearchExaService>;

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                GatherDocumentationContextStage,
                {
                    provide: DocumentationPackageDiscoveryService,
                    useValue: discoveryService,
                },
                {
                    provide: DocumentationLLMPlannerService,
                    useValue: plannerService,
                },
                {
                    provide: DocumentationSearchExaService,
                    useValue: searchService,
                },
            ],
        }).compile();

        stage = module.get<GatherDocumentationContextStage>(
            GatherDocumentationContextStage,
        );
    });

    it('should skip when there are no changed files', async () => {
        const context = {
            ...baseContext,
            changedFiles: [],
        } as unknown as CodeReviewPipelineContext;

        const result = await stage.execute(context);

        expect(result).toBe(context);
        expect(discoveryService.discoverPackages).not.toHaveBeenCalled();
    });

    it('should skip documentation gathering when there are no supported code files', async () => {
        const context = {
            ...baseContext,
            changedFiles: [
                {
                    filename: 'README.md',
                    patch: '@@ -1,1 +1,1 @@',
                    fileContent: '# docs',
                },
            ],
        } as unknown as CodeReviewPipelineContext;

        const result = await stage.execute(context);

        expect(result.documentationQueryPlanByFile).toEqual({});
        expect(result.documentationByFile).toEqual({});
        expect(discoveryService.discoverPackages).not.toHaveBeenCalled();
        expect(plannerService.planDocumentationByFile).not.toHaveBeenCalled();
        expect(searchService.searchByFilePlan).not.toHaveBeenCalled();
    });

    it('should store empty documentation context when no packages are discovered', async () => {
        discoveryService.discoverPackages.mockResolvedValue({
            packages: [],
            manifestFiles: [],
        });

        const result = await stage.execute(baseContext);

        expect(result.discoveredPackages).toEqual([]);
        expect(result.documentationQueryPlanByFile).toEqual({});
        expect(result.documentationByFile).toEqual({});
        expect(plannerService.planDocumentationByFile).not.toHaveBeenCalled();
    });

    it('should orchestrate package discovery, planning and search', async () => {
        discoveryService.discoverPackages.mockResolvedValue({
            packages: [
                {
                    name: '@nestjs/common',
                    ecosystem: 'npm',
                    sourceFile: 'package.json',
                },
            ],
            manifestFiles: ['package.json'],
        });

        plannerService.planDocumentationByFile.mockResolvedValue({
            'src/a.ts': {
                relevantPackages: ['@nestjs/common'],
                queries: ['find documentation about nestjs controllers'],
            },
        });

        searchService.searchByFilePlan.mockResolvedValue({
            'src/a.ts': [
                {
                    query: 'find documentation about nestjs controllers',
                    title: 'NestJS docs',
                    url: 'https://docs.nestjs.com/controllers',
                    snippet: 'Controller docs',
                    source: 'exa-search',
                },
            ],
        });

        const result = await stage.execute(baseContext);

        expect(result.discoveredPackages).toHaveLength(1);
        expect(
            result.documentationQueryPlanByFile?.['src/a.ts']?.queries,
        ).toEqual(['find documentation about nestjs controllers']);
        expect(result.documentationByFile?.['src/a.ts']).toHaveLength(1);
    });

    it('should only send code files to the planner', async () => {
        const context = {
            ...baseContext,
            changedFiles: [
                {
                    filename: 'README.md',
                    patch: '@@ -1,1 +1,1 @@',
                    fileContent: '# docs',
                },
                {
                    filename: 'src/a.ts',
                    patch: '@@ -1,1 +1,1 @@',
                    fileContent: 'const a = 1;',
                },
            ],
        } as unknown as CodeReviewPipelineContext;

        discoveryService.discoverPackages.mockResolvedValue({
            packages: [
                {
                    name: '@nestjs/common',
                    ecosystem: 'npm',
                    sourceFile: 'package.json',
                },
            ],
            manifestFiles: ['package.json'],
        });

        plannerService.planDocumentationByFile.mockResolvedValue({
            'src/a.ts': {
                relevantPackages: ['@nestjs/common'],
                queries: ['find docs'],
            },
        });

        searchService.searchByFilePlan.mockResolvedValue({
            'src/a.ts': [
                {
                    query: 'find docs',
                    title: 'doc',
                    url: 'https://example.com',
                    snippet: 'snippet',
                    source: 'exa-search',
                },
            ],
        });

        await stage.execute(context);

        expect(plannerService.planDocumentationByFile).toHaveBeenCalledTimes(1);
        expect(plannerService.planDocumentationByFile).toHaveBeenCalledWith(
            expect.objectContaining({
                changedFiles: [
                    expect.objectContaining({
                        filename: 'src/a.ts',
                    }),
                ],
            }),
        );
    });

    it('should fail open when an internal service throws', async () => {
        discoveryService.discoverPackages.mockRejectedValue(new Error('boom'));

        const result = await stage.execute(baseContext);

        expect(result).toBe(baseContext);
    });

    it('should run independent flow with real planner prompt and real Exa search', async () => {
        const hasPromptKeys = Boolean(
            process.env.API_OPEN_AI_API_KEY &&
            (process.env.API_GROQ_API_KEY ||
                process.env.API_LLM_PROVIDER_MODEL),
        );

        if (!process.env.API_EXA_KEY || !hasPromptKeys) {
            console.warn(
                'Skipping independent flow test for GatherDocumentationContextStage because API_EXA_KEY and prompt provider keys are required',
            );
            return;
        }

        const context = buildIndependentContext(independentFixture);

        const pullRequestManagerMock: Pick<
            IPullRequestManagerService,
            'enrichFilesWithContent'
        > = {
            enrichFilesWithContent: jest.fn(
                async (_org, _repo, _pr, files) => files,
            ),
        };

        const packageDiscoveryService =
            new DocumentationPackageDiscoveryService(
                pullRequestManagerMock as unknown as IPullRequestManagerService,
            );

        const independentPlannerService = new DocumentationLLMPlannerService(
            buildRealPromptRunnerService(),
        );

        const independentSearchService = new DocumentationSearchExaService(
            new ConfigService({ API_EXA_KEY: process.env.API_EXA_KEY }),
            {
                get: jest.fn().mockResolvedValue(null),
                set: jest.fn().mockResolvedValue(undefined),
            } as unknown as DocumentationSearchCacheService,
        );

        const stage = new GatherDocumentationContextStage(
            packageDiscoveryService,
            independentPlannerService,
            independentSearchService,
        );

        const result = await stage.execute(context);

        expect(result.discoveredPackages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: '@nestjs/common',
                    ecosystem: 'npm',
                }),
                expect.objectContaining({
                    name: 'typeorm',
                    ecosystem: 'npm',
                }),
            ]),
        );

        expect(
            result.documentationQueryPlanByFile[
                'apps/api/src/example.controller.ts'
            ],
        ).toBeDefined();

        const planForController =
            result.documentationQueryPlanByFile[
                'apps/api/src/example.controller.ts'
            ];

        expect(result.documentationQueryPlanByFile['package.json']).toBeFalsy();
        expect(result.documentationByFile['package.json']).toBeFalsy();

        expect(planForController.relevantPackages.length).toBeGreaterThan(0);
        expect(planForController.queries.length).toBeGreaterThan(0);

        expect(
            result.documentationByFile['apps/api/src/example.controller.ts'],
        ).toBeDefined();
        expect(
            result.documentationByFile['apps/api/src/example.controller.ts']
                .length,
        ).toBeGreaterThan(0);
        expect(
            result.documentationByFile['apps/api/src/example.controller.ts'][0]
                .source,
        ).toBe('exa-search');
    }, 50000);
});
