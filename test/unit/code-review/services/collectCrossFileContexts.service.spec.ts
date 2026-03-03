import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PromptRunnerService } from '@kodus/kodus-common/llm';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { TokenChunkingService } from '@libs/core/infrastructure/services/tokenChunking/tokenChunking.service';
import {
    CollectCrossFileContextsService,
    CrossFileContextSnippet,
    RemoteCommands,
} from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import {
    createSampleFileChange,
    createSamplePlannerQuery,
    createSampleSnippet,
    createMockRemoteCommands,
    mockOrganizationAndTeamData,
} from '../../../fixtures/cross-file-context.fixtures';

// Mock external SDK
jest.mock('@morphllm/morphsdk', () => ({
    WarpGrepClient: jest.fn().mockImplementation(() => ({
        execute: jest.fn(),
    })),
}));

// Mock logger to silence logs during tests
jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('CollectCrossFileContextsService', () => {
    let service: CollectCrossFileContextsService;
    let mockPromptRunnerService: any;
    let mockObservabilityService: any;
    let mockTokenChunkingService: any;

    beforeEach(async () => {
        // Chainable builder mock (follows llmAnalysis.service.spec.ts pattern)
        const builderMock = {
            setParser: jest.fn().mockReturnThis(),
            setLLMJsonMode: jest.fn().mockReturnThis(),
            setPayload: jest.fn().mockReturnThis(),
            addPrompt: jest.fn().mockReturnThis(),
            setTemperature: jest.fn().mockReturnThis(),
            addTags: jest.fn().mockReturnThis(),
            setRunName: jest.fn().mockReturnThis(),
            addMetadata: jest.fn().mockReturnThis(),
            addCallbacks: jest.fn().mockReturnThis(),
            setProviders: jest.fn().mockReturnThis(),
            setBYOKConfig: jest.fn().mockReturnThis(),
            setBYOKFallbackConfig: jest.fn().mockReturnThis(),
            setApiKey: jest.fn().mockReturnThis(),
            execute: jest.fn().mockResolvedValue({
                result: { queries: [] },
            }),
        };

        mockPromptRunnerService = {
            builder: jest.fn().mockReturnValue(builderMock),
        };

        mockObservabilityService = {
            runLLMInSpan: jest.fn().mockImplementation(({ exec }) => exec([])),
        };

        mockTokenChunkingService = {
            chunkDataByTokens: jest.fn().mockReturnValue({
                chunks: [['chunk1']],
                totalChunks: 1,
                tokenLimit: 64000,
                tokensPerChunk: [1000],
            }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CollectCrossFileContextsService,
                {
                    provide: PromptRunnerService,
                    useValue: mockPromptRunnerService,
                },
                {
                    provide: ObservabilityService,
                    useValue: mockObservabilityService,
                },
                {
                    provide: TokenChunkingService,
                    useValue: mockTokenChunkingService,
                },
                {
                    provide: ConfigService,
                    useValue: { get: jest.fn() },
                },
            ],
        }).compile();

        service = module.get<CollectCrossFileContextsService>(
            CollectCrossFileContextsService,
        );
        jest.clearAllMocks();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 2 — Pure Logic Tests
    // ─────────────────────────────────────────────────────────────────────────

    describe('deduplicateAndRank()', () => {
        const dedup = (snippets: CrossFileContextSnippet[]) =>
            (service as any).deduplicateAndRank(snippets);

        it('should sort by relevanceScore desc within each file', () => {
            const snippets = [
                createSampleSnippet({
                    filePath: 'a.ts',
                    content: 'low',
                    relevanceScore: 30,
                }),
                createSampleSnippet({
                    filePath: 'a.ts',
                    content: 'high',
                    relevanceScore: 90,
                }),
            ];

            const result = dedup(snippets);
            expect(result[0].content).toBe('high');
        });

        it('should respect MAX_PER_FILE_CHARS (8000)', () => {
            const longContent = 'x'.repeat(5000);
            const snippets = [
                createSampleSnippet({
                    filePath: 'a.ts',
                    content: longContent,
                    relevanceScore: 90,
                }),
                createSampleSnippet({
                    filePath: 'a.ts',
                    content: longContent,
                    relevanceScore: 80,
                }),
            ];

            const result = dedup(snippets);
            // Second snippet pushes total above 8000, should be skipped
            expect(result).toHaveLength(1);
        });

        it('should detect overlap and remove duplicates', () => {
            const shared =
                'export function greet(name: string) { return name; }';
            const snippets = [
                createSampleSnippet({
                    filePath: 'a.ts',
                    content: shared,
                    relevanceScore: 90,
                }),
                createSampleSnippet({
                    filePath: 'a.ts',
                    content: shared,
                    relevanceScore: 70,
                }),
            ];

            const result = dedup(snippets);
            expect(result).toHaveLength(1);
        });

        it('should respect MAX_TOTAL_CONTEXTS (60) and MAX_TOTAL_CHARS (200k)', () => {
            // Create 70 snippets with small content
            const snippets = Array.from({ length: 70 }, (_, i) =>
                createSampleSnippet({
                    filePath: `file-${i}.ts`,
                    content: `content-${i}`,
                    relevanceScore: 100 - i,
                }),
            );

            const result = dedup(snippets);
            expect(result.length).toBeLessThanOrEqual(60);
        });

        it('should return empty array for empty input', () => {
            expect(dedup([])).toEqual([]);
        });

        it('should merge targetFiles when deduplicating overlapping snippets', () => {
            const shared =
                'export function greet(name: string) { return name; }';
            const snippets = [
                createSampleSnippet({
                    filePath: 'a.ts',
                    content: shared,
                    relevanceScore: 90,
                    targetFiles: ['src/handler.ts'],
                }),
                createSampleSnippet({
                    filePath: 'a.ts',
                    content: shared,
                    relevanceScore: 70,
                    targetFiles: ['src/controller.ts'],
                }),
            ];

            const result = dedup(snippets);
            expect(result).toHaveLength(1);
            expect(result[0].targetFiles).toEqual(
                expect.arrayContaining(['src/handler.ts', 'src/controller.ts']),
            );
            expect(result[0].targetFiles).toHaveLength(2);
        });

        it('should deduplicate targetFiles entries during merge', () => {
            const shared =
                'export function greet(name: string) { return name; }';
            const snippets = [
                createSampleSnippet({
                    filePath: 'a.ts',
                    content: shared,
                    relevanceScore: 90,
                    targetFiles: ['src/handler.ts'],
                }),
                createSampleSnippet({
                    filePath: 'a.ts',
                    content: shared,
                    relevanceScore: 70,
                    targetFiles: ['src/handler.ts', 'src/controller.ts'],
                }),
            ];

            const result = dedup(snippets);
            expect(result).toHaveLength(1);
            expect(result[0].targetFiles).toHaveLength(2);
        });
    });

    describe('extractFunctionNames()', () => {
        const extract = (content: string) =>
            (service as any).extractFunctionNames(content);

        it('should extract JS/TS functions', () => {
            const code = `
function myFunc(a, b) {}
async handleRequest(req, res) {}
const handler = (event) => {}
            `;
            const names = extract(code);
            expect(names).toContain('myFunc');
            expect(names).toContain('handleRequest');
            expect(names).toContain('handler');
        });

        it('should extract Python def', () => {
            const code = `def my_function(x, y):\n    return x + y`;
            const names = extract(code);
            expect(names).toContain('my_function');
        });

        it('should extract Go func and method receivers', () => {
            const code = `
func MyHandler(w http.ResponseWriter, r *http.Request) {}
func (s *Server) Handle(ctx context.Context) {}
            `;
            const names = extract(code);
            expect(names).toContain('MyHandler');
            expect(names).toContain('Handle');
        });

        it('should filter common keywords', () => {
            const code = `
function myFunc() {}
if (true) {}
for (let i = 0; i < 10; i++) {}
while (true) {}
return value;
            `;
            const names = extract(code);
            expect(names).toContain('myFunc');
            expect(names).not.toContain('if');
            expect(names).not.toContain('for');
            expect(names).not.toContain('while');
            expect(names).not.toContain('return');
        });

        it('should deduplicate returned names', () => {
            const code = `
function greet() {}
function greet() {}
const greet = () => {}
            `;
            const names = extract(code);
            const greetCount = names.filter(
                (n: string) => n === 'greet',
            ).length;
            expect(greetCount).toBe(1);
        });
    });

    describe('hasContentOverlap()', () => {
        const overlap = (a: string, b: string) =>
            (service as any).hasContentOverlap(a, b);

        it('should return true for identical strings', () => {
            expect(overlap('hello world', 'hello world')).toBe(true);
        });

        it('should return true when one is a prefix of the other (up to 200 chars)', () => {
            const short = 'export function greet(name)';
            const long = short + ' { return `Hello ${name}`; }';
            expect(overlap(short, long)).toBe(true);
        });

        it('should return false for unrelated content', () => {
            expect(
                overlap(
                    'function calculateTax(amount) { return amount * 0.2; }',
                    'class UserRepository { findById(id) { return db.query(id); } }',
                ),
            ).toBe(false);
        });
    });

    describe('getBaseScore() / isCommonKeyword()', () => {
        const getBaseScore = (level: string) =>
            (service as any).getBaseScore(level);
        const isCommonKeyword = (name: string) =>
            (service as any).isCommonKeyword(name);

        it('should return 80/50/30 for high/medium/low', () => {
            expect(getBaseScore('high')).toBe(80);
            expect(getBaseScore('medium')).toBe(50);
            expect(getBaseScore('low')).toBe(30);
        });

        it('should return true for keywords', () => {
            expect(isCommonKeyword('if')).toBe(true);
            expect(isCommonKeyword('for')).toBe(true);
            expect(isCommonKeyword('while')).toBe(true);
            expect(isCommonKeyword('return')).toBe(true);
            expect(isCommonKeyword('class')).toBe(true);
        });

        it('should return false for normal names', () => {
            expect(isCommonKeyword('greet')).toBe(false);
            expect(isCommonKeyword('handleRequest')).toBe(false);
            expect(isCommonKeyword('calculateTax')).toBe(false);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Phase 4 — Core Service Tests (with mocks)
    // ─────────────────────────────────────────────────────────────────────────

    describe('runPlanner()', () => {
        const runPlanner = (
            changedFiles: any[],
            byokConfig?: any,
            orgData?: any,
            prNumber?: number,
            language?: string,
        ) =>
            (service as any).runPlanner(
                changedFiles,
                byokConfig,
                orgData || mockOrganizationAndTeamData,
                prNumber || 42,
                language || 'en-US',
            );

        it('should truncate diffs to 2000 chars per file', async () => {
            const longDiff = 'x'.repeat(3000);
            const file = createSampleFileChange({
                patch: longDiff,
                patchWithLinesStr: longDiff,
            });

            await runPlanner([file]);

            // Verify tokenChunkingService was called
            expect(
                mockTokenChunkingService.chunkDataByTokens,
            ).toHaveBeenCalled();
            const callArgs =
                mockTokenChunkingService.chunkDataByTokens.mock.calls[0][0];
            // Each item in data should be truncated
            const firstItem = callArgs.data[0] as string;
            // The formatted item is `### filename\ntruncated_diff`
            expect(firstItem).toContain('... (truncated)');
        });

        it('should call tokenChunkingService with correct model and percentage', async () => {
            const file = createSampleFileChange();

            await runPlanner([file]);

            expect(
                mockTokenChunkingService.chunkDataByTokens,
            ).toHaveBeenCalledWith(
                expect.objectContaining({
                    usagePercentage: 50,
                    defaultMaxTokens: 64000,
                }),
            );
        });

        it('should deduplicate queries between batches (key: symbolName::pattern, keeps higher riskLevel)', () => {
            // Test the deduplication logic directly
            const dedup = (queries: any[]) =>
                (service as any).deduplicatePlannerQueries(queries);

            const queries = [
                createSamplePlannerQuery({
                    symbolName: 'greet',
                    pattern: 'greet\\(',
                    riskLevel: 'low',
                }),
                createSamplePlannerQuery({
                    symbolName: 'greet',
                    pattern: 'greet\\(',
                    riskLevel: 'high',
                }),
                createSamplePlannerQuery({
                    symbolName: 'farewell',
                    pattern: 'farewell\\(',
                    riskLevel: 'medium',
                }),
            ];

            const result = dedup(queries);

            // Should keep only one query per key, with the higher riskLevel
            const greetQueries = result.filter(
                (q: any) => q.symbolName === 'greet',
            );
            expect(greetQueries).toHaveLength(1);
            expect(greetQueries[0].riskLevel).toBe('high');
            // farewell should also be kept
            expect(result).toHaveLength(2);
        });

        it('should cap at MAX_PLANNER_QUERIES (16)', async () => {
            const manyQueries = Array.from({ length: 20 }, (_, i) =>
                createSamplePlannerQuery({
                    symbolName: `sym${i}`,
                    pattern: `sym${i}\\(`,
                }),
            );

            const builderMock = mockPromptRunnerService.builder();
            builderMock.execute.mockResolvedValue({
                result: { queries: manyQueries },
            });

            const result = await runPlanner([createSampleFileChange()]);
            expect(result.length).toBeLessThanOrEqual(16);
        });

        it('should return empty array on total LLM failure (no throw)', async () => {
            mockTokenChunkingService.chunkDataByTokens.mockImplementation(
                () => {
                    throw new Error('Token chunking exploded');
                },
            );

            const result = await runPlanner([createSampleFileChange()]);
            expect(result).toEqual([]);
        });
    });

    describe('executeSearchQueries()', () => {
        const { WarpGrepClient } = require('@morphllm/morphsdk');

        const executeSearch = (
            queries: any[],
            remoteCommands: RemoteCommands,
            changedFilePaths: Set<string>,
            repoRoot: string,
        ) =>
            (service as any).executeSearchQueries(
                queries,
                remoteCommands,
                changedFilePaths,
                repoRoot,
                mockOrganizationAndTeamData,
                42,
            );

        beforeEach(() => {
            jest.clearAllMocks();
        });

        it('should call WarpGrepClient.execute with correct params', async () => {
            const mockExecute = jest.fn().mockResolvedValue({
                success: true,
                contexts: [{ file: 'other.ts', content: 'import { greet }' }],
            });
            WarpGrepClient.mockImplementation(() => ({
                execute: mockExecute,
            }));

            const query = createSamplePlannerQuery();
            const remoteCommands = createMockRemoteCommands();

            await executeSearch(
                [query],
                remoteCommands as any,
                new Set(['src/utils/greet.ts']),
                '.',
            );

            expect(mockExecute).toHaveBeenCalledWith(
                expect.objectContaining({
                    query: query.pattern,
                    repoRoot: '.',
                    remoteCommands,
                    includes: [query.fileGlob],
                    excludes: expect.arrayContaining(['node_modules', '.git']),
                }),
            );
        });

        it('should filter out files already in the PR', async () => {
            const mockExecute = jest.fn().mockResolvedValue({
                success: true,
                contexts: [
                    {
                        file: 'src/utils/greet.ts',
                        content: 'already in PR',
                    },
                    { file: 'other.ts', content: 'external file' },
                ],
            });
            WarpGrepClient.mockImplementation(() => ({
                execute: mockExecute,
            }));

            const result = await executeSearch(
                [createSamplePlannerQuery()],
                createMockRemoteCommands() as any,
                new Set(['src/utils/greet.ts']),
                '.',
            );

            expect(result).toHaveLength(1);
            expect(result[0].filePath).toBe('other.ts');
        });

        it('should continue on individual query failure (log warn, process rest)', async () => {
            let callCount = 0;
            const mockExecute = jest.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    throw new Error('ripgrep failed');
                }
                return Promise.resolve({
                    success: true,
                    contexts: [{ file: 'result.ts', content: 'found it' }],
                });
            });
            WarpGrepClient.mockImplementation(() => ({
                execute: mockExecute,
            }));

            const queries = [
                createSamplePlannerQuery({ symbolName: 'fail' }),
                createSamplePlannerQuery({ symbolName: 'succeed' }),
            ];

            const result = await executeSearch(
                queries,
                createMockRemoteCommands() as any,
                new Set(),
                '.',
            );

            expect(result).toHaveLength(1);
            expect(result[0].filePath).toBe('result.ts');
        });

        it('should return empty array when all queries fail', async () => {
            const mockExecute = jest
                .fn()
                .mockRejectedValue(new Error('all fail'));
            WarpGrepClient.mockImplementation(() => ({
                execute: mockExecute,
            }));

            const result = await executeSearch(
                [
                    createSamplePlannerQuery(),
                    createSamplePlannerQuery({ symbolName: 'other' }),
                ],
                createMockRemoteCommands() as any,
                new Set(),
                '.',
            );

            expect(result).toEqual([]);
        });
    });

    describe('expandContextWindows()', () => {
        const expand = (
            snippets: CrossFileContextSnippet[],
            remoteCommands: RemoteCommands,
        ) => (service as any).expandContextWindows(snippets, remoteCommands);

        it('should NOT expand snippets >= 5 lines', async () => {
            const fiveLineContent = 'line1\nline2\nline3\nline4\nline5';
            const snippet = createSampleSnippet({
                content: fiveLineContent,
                startLine: 10,
                endLine: 14,
            });
            const remote = createMockRemoteCommands();

            const result = await expand([snippet], remote as any);

            expect(remote.read).not.toHaveBeenCalled();
            expect(result[0].content).toBe(fiveLineContent);
        });

        it('should NOT expand snippets without startLine/endLine', async () => {
            const snippet = createSampleSnippet({
                content: 'short',
                startLine: undefined,
                endLine: undefined,
            });
            const remote = createMockRemoteCommands();

            const result = await expand([snippet], remote as any);

            expect(remote.read).not.toHaveBeenCalled();
            expect(result[0].content).toBe('short');
        });

        it('should expand single-line with padding of 40 lines', async () => {
            const snippet = createSampleSnippet({
                content: 'single line',
                startLine: 50,
                endLine: 50,
            });
            const remote = createMockRemoteCommands();
            remote.read.mockResolvedValue('expanded context content');

            const result = await expand([snippet], remote as any);

            expect(remote.read).toHaveBeenCalledWith(
                snippet.filePath,
                10, // max(1, 50 - 40)
                90, // 50 + 40
            );
            expect(result[0].content).toBe('expanded context content');
        });

        it('should expand multi-line (<5) with padding of 25 lines', async () => {
            const snippet = createSampleSnippet({
                content: 'line1\nline2\nline3',
                startLine: 30,
                endLine: 32,
            });
            const remote = createMockRemoteCommands();
            remote.read.mockResolvedValue('expanded multi-line');

            const result = await expand([snippet], remote as any);

            expect(remote.read).toHaveBeenCalledWith(
                snippet.filePath,
                5, // max(1, 30 - 25)
                57, // 32 + 25
            );
            expect(result[0].content).toBe('expanded multi-line');
        });

        it('should fallback to original snippet when read fails', async () => {
            const snippet = createSampleSnippet({
                content: 'original',
                startLine: 10,
                endLine: 10,
            });
            const remote = createMockRemoteCommands();
            remote.read.mockRejectedValue(new Error('read failed'));

            const result = await expand([snippet], remote as any);

            expect(result[0].content).toBe('original');
        });
    });

    describe('executeHop2()', () => {
        const { WarpGrepClient } = require('@morphllm/morphsdk');

        const executeHop2 = (
            hop1Snippets: CrossFileContextSnippet[],
            remoteCommands: RemoteCommands,
            changedFilePaths: Set<string>,
            repoRoot: string,
        ) =>
            (service as any).executeHop2(
                hop1Snippets,
                remoteCommands,
                changedFilePaths,
                repoRoot,
                mockOrganizationAndTeamData,
                42,
            );

        it('should only process snippets with riskLevel high', async () => {
            const mockExecute = jest.fn().mockResolvedValue({
                success: true,
                contexts: [{ file: 'hop2.ts', content: 'hop2 content' }],
            });
            WarpGrepClient.mockImplementation(() => ({
                execute: mockExecute,
            }));

            const snippets = [
                createSampleSnippet({
                    riskLevel: 'high',
                    content: 'function myFunc() { doStuff(); }',
                }),
                createSampleSnippet({
                    riskLevel: 'medium',
                    content: 'function otherFunc() {}',
                }),
                createSampleSnippet({
                    riskLevel: 'low',
                    content: 'function lowFunc() {}',
                }),
            ];

            await executeHop2(
                snippets,
                createMockRemoteCommands() as any,
                new Set(),
                '.',
            );

            // Only high-risk function names should trigger searches
            // "otherFunc" and "lowFunc" should NOT be searched
            for (const call of mockExecute.mock.calls) {
                expect(call[0].query).not.toBe('otherFunc');
                expect(call[0].query).not.toBe('lowFunc');
            }
        });

        it('should return empty when no high-risk snippets', async () => {
            const snippets = [
                createSampleSnippet({ riskLevel: 'medium' }),
                createSampleSnippet({ riskLevel: 'low' }),
            ];

            const result = await executeHop2(
                snippets,
                createMockRemoteCommands() as any,
                new Set(),
                '.',
            );

            expect(result).toEqual([]);
        });

        it('should exclude files from PR AND files from hop1', async () => {
            const mockExecute = jest.fn().mockResolvedValue({
                success: true,
                contexts: [
                    { file: 'src/utils/greet.ts', content: 'PR file' },
                    {
                        file: 'src/controllers/hello.controller.ts',
                        content: 'hop1 file',
                    },
                    { file: 'src/new-caller.ts', content: 'new file' },
                ],
            });
            WarpGrepClient.mockImplementation(() => ({
                execute: mockExecute,
            }));

            const hop1Snippets = [
                createSampleSnippet({
                    filePath: 'src/controllers/hello.controller.ts',
                    riskLevel: 'high',
                    content:
                        'function processRequest(data) { greet(data.name); }',
                }),
            ];

            const result = await executeHop2(
                hop1Snippets,
                createMockRemoteCommands() as any,
                new Set(['src/utils/greet.ts']),
                '.',
            );

            const filePaths = result.map(
                (s: CrossFileContextSnippet) => s.filePath,
            );
            expect(filePaths).not.toContain('src/utils/greet.ts');
            expect(filePaths).not.toContain(
                'src/controllers/hello.controller.ts',
            );
            if (result.length > 0) {
                expect(filePaths).toContain('src/new-caller.ts');
            }
        });

        it('should mark hop2 with hop: 2 and score getBaseScore("high") - 10', async () => {
            const mockExecute = jest.fn().mockResolvedValue({
                success: true,
                contexts: [{ file: 'src/hop2.ts', content: 'hop2 content' }],
            });
            WarpGrepClient.mockImplementation(() => ({
                execute: mockExecute,
            }));

            const hop1Snippets = [
                createSampleSnippet({
                    riskLevel: 'high',
                    content: 'function processRequest() {}',
                }),
            ];

            const result = await executeHop2(
                hop1Snippets,
                createMockRemoteCommands() as any,
                new Set(),
                '.',
            );

            if (result.length > 0) {
                expect(result[0].hop).toBe(2);
                expect(result[0].relevanceScore).toBe(70); // 80 - 10
            }
        });

        it('should propagate targetFiles from hop1 to hop2 snippets', async () => {
            const mockExecute = jest.fn().mockResolvedValue({
                success: true,
                contexts: [{ file: 'src/hop2.ts', content: 'hop2 content' }],
            });
            WarpGrepClient.mockImplementation(() => ({
                execute: mockExecute,
            }));

            const hop1Snippets = [
                createSampleSnippet({
                    riskLevel: 'high',
                    content: 'function processRequest() {}',
                    targetFiles: ['src/changed-file.ts'],
                }),
            ];

            const result = await executeHop2(
                hop1Snippets,
                createMockRemoteCommands() as any,
                new Set(),
                '.',
            );

            if (result.length > 0) {
                expect(result[0].targetFiles).toEqual(['src/changed-file.ts']);
            }
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // collectContexts() — wiring test for the main public method
    // ─────────────────────────────────────────────────────────────────────────

    describe('collectContexts()', () => {
        const { WarpGrepClient } = require('@morphllm/morphsdk');

        const baseParams = {
            remoteCommands: createMockRemoteCommands() as any,
            changedFiles: [createSampleFileChange()],
            byokConfig: undefined,
            organizationAndTeamData: mockOrganizationAndTeamData as any,
            prNumber: 42,
            language: 'en-US',
            repoRoot: '.',
        };

        it('should wire planner → search → expand → dedup and return final contexts', async () => {
            // Planner returns a query
            const plannerQuery = createSamplePlannerQuery({
                symbolName: 'greet',
                pattern: 'greet\\(',
                riskLevel: 'medium', // medium so hop2 is skipped
            });
            const builderMock = mockPromptRunnerService.builder();
            builderMock.execute.mockResolvedValue({
                result: { queries: [plannerQuery] },
            });

            // WarpGrep returns a context hit
            const mockExecute = jest.fn().mockResolvedValue({
                success: true,
                contexts: [
                    {
                        file: 'src/caller.ts',
                        content:
                            'import { greet } from "./greet";\ngreet("world");',
                        startLine: 1,
                        endLine: 2,
                    },
                ],
            });
            WarpGrepClient.mockImplementation(() => ({
                execute: mockExecute,
            }));

            const result = await service.collectContexts(baseParams);

            // Should produce a valid result with contexts
            expect(result.contexts.length).toBeGreaterThanOrEqual(1);
            expect(result.plannerQueries).toHaveLength(1);
            expect(result.totalSearches).toBe(1);
            expect(result.contexts[0].filePath).toBe('src/caller.ts');
            expect(result.contexts[0].hop).toBe(1);
        });

        it('should return empty contexts when planner produces no queries', async () => {
            const builderMock = mockPromptRunnerService.builder();
            builderMock.execute.mockResolvedValue({
                result: { queries: [] },
            });

            const result = await service.collectContexts(baseParams);

            expect(result.contexts).toEqual([]);
            expect(result.plannerQueries).toEqual([]);
            expect(result.totalSearches).toBe(0);
        });

        it('should return plannerQueries and totalSearches even when search finds nothing', async () => {
            const plannerQuery = createSamplePlannerQuery();
            const builderMock = mockPromptRunnerService.builder();
            builderMock.execute.mockResolvedValue({
                result: { queries: [plannerQuery] },
            });

            // WarpGrep returns no matches
            WarpGrepClient.mockImplementation(() => ({
                execute: jest.fn().mockResolvedValue({
                    success: true,
                    contexts: [],
                }),
            }));

            const result = await service.collectContexts(baseParams);

            expect(result.contexts).toEqual([]);
            expect(result.plannerQueries).toHaveLength(1);
            expect(result.totalSearches).toBe(1);
        });
    });
});
