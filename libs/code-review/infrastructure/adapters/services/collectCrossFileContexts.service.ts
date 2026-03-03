import { createLogger } from '@kodus/flow';
import {
    BYOKConfig,
    LLMModelProvider,
    ParserType,
    PromptRole,
    PromptRunnerService,
} from '@kodus/kodus-common/llm';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
    CrossFileContextPlannerSchema,
    CrossFileContextPlannerSchemaType,
    prompt_cross_file_context_planner,
} from '@libs/common/utils/langchainCommon/prompts/codeReviewCrossFileContextPlanner';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { BYOKPromptRunnerService } from '@libs/core/infrastructure/services/tokenTracking/byokPromptRunner.service';
import { TokenChunkingService } from '@libs/core/infrastructure/services/tokenChunking/tokenChunking.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { WarpGrepClient, WarpGrepResult } from '@morphllm/morphsdk';

/**
 * Remote command executors for sandbox environments.
 * Mirrors the RemoteCommands interface from @morphllm/morphsdk/tools/warp-grep.
 */
export interface RemoteCommands {
    grep: (pattern: string, path: string, glob?: string) => Promise<string>;
    read: (path: string, start: number, end: number) => Promise<string>;
    listDir: (path: string, maxDepth: number) => Promise<string>;
}

//#region Constants
const MAX_PLANNER_QUERIES = 16;
const MAX_TOTAL_CONTEXTS = 60;
const MAX_PER_FILE_CHARS = 8000;
const MAX_TOTAL_CHARS = 200_000;
const CONTEXT_WINDOW_SMALL = 25;
const CONTEXT_WINDOW_SINGLE_LINE = 40;
const MIN_SNIPPET_LINES = 5;
//#endregion

//#region Types
export const COLLECT_CROSS_FILE_CONTEXTS_SERVICE_TOKEN = Symbol(
    'CollectCrossFileContextsService',
);

export type CrossFileContextSnippet = {
    filePath: string;
    content: string;
    rationale: string;
    relevanceScore: number;
    relatedSymbol?: string;
    relationship: string;
    hop: number;
    riskLevel: 'low' | 'medium' | 'high';
    startLine?: number;
    endLine?: number;
    targetFiles?: string[];
};

export type CollectCrossFileContextsResult = {
    contexts: CrossFileContextSnippet[];
    plannerQueries: CrossFileContextPlannerSchemaType['queries'];
    totalSearches: number;
    totalSnippetsBeforeDedup: number;
};

interface CollectContextsParams {
    remoteCommands: RemoteCommands;
    changedFiles: FileChange[];
    byokConfig?: BYOKConfig;
    organizationAndTeamData: OrganizationAndTeamData;
    prNumber: number;
    language: string;
    repoRoot: string;
}

type PlannerQuery = CrossFileContextPlannerSchemaType['queries'][number];
//#endregion

@Injectable()
export class CollectCrossFileContextsService {
    private readonly logger = createLogger(
        CollectCrossFileContextsService.name,
    );

    constructor(
        private readonly promptRunnerService: PromptRunnerService,
        private readonly observabilityService: ObservabilityService,
        private readonly tokenChunkingService: TokenChunkingService,
        private readonly configService: ConfigService,
    ) {}

    async collectContexts(
        params: CollectContextsParams,
    ): Promise<CollectCrossFileContextsResult> {
        const {
            remoteCommands,
            changedFiles,
            byokConfig,
            organizationAndTeamData,
            prNumber,
            language,
            repoRoot,
        } = params;

        const emptyResult: CollectCrossFileContextsResult = {
            contexts: [],
            plannerQueries: [],
            totalSearches: 0,
            totalSnippetsBeforeDedup: 0,
        };

        // 1. Run planner to get search queries
        const plannerQueries = await this.runPlanner(
            changedFiles,
            byokConfig,
            organizationAndTeamData,
            prNumber,
            language,
        );

        if (!plannerQueries?.length) {
            this.logger.log({
                message: `No planner queries generated for PR#${prNumber}`,
                context: CollectCrossFileContextsService.name,
                metadata: { organizationAndTeamData, prNumber },
            });
            return emptyResult;
        }

        this.logger.log({
            message: `Planner generated ${plannerQueries.length} queries for PR#${prNumber}`,
            context: CollectCrossFileContextsService.name,
            metadata: {
                organizationAndTeamData,
                prNumber,
                queries: plannerQueries.map((q) => ({
                    symbol: q.symbolName,
                    pattern: q.pattern,
                    glob: q.fileGlob,
                    risk: q.riskLevel,
                    rationale: q.rationale,
                })),
            },
        });

        // 2. Execute search queries via WarpGrep
        const changedFilePaths = new Set(changedFiles.map((f) => f.filename));

        const searchResults = await this.executeSearchQueries(
            plannerQueries,
            remoteCommands,
            changedFilePaths,
            repoRoot,
            organizationAndTeamData,
            prNumber,
        );

        if (!searchResults.length) {
            this.logger.log({
                message: `No search results found for PR#${prNumber}`,
                context: CollectCrossFileContextsService.name,
                metadata: { organizationAndTeamData, prNumber },
            });
            return {
                ...emptyResult,
                plannerQueries,
                totalSearches: plannerQueries.length,
            };
        }

        // 3. Expand context windows for small snippets
        const expandedSnippets = await this.expandContextWindows(
            searchResults,
            remoteCommands,
        );

        // 4. Execute hop 2 for high-risk queries
        const hop2Snippets = await this.executeHop2(
            expandedSnippets,
            remoteCommands,
            changedFilePaths,
            repoRoot,
            organizationAndTeamData,
            prNumber,
        );

        const allSnippets = [...expandedSnippets, ...hop2Snippets];
        const totalSnippetsBeforeDedup = allSnippets.length;

        // 5. Deduplicate and rank
        const finalContexts = this.deduplicateAndRank(allSnippets);

        this.logger.log({
            message: `Cross-file context collection completed for PR#${prNumber}`,
            context: CollectCrossFileContextsService.name,
            metadata: {
                organizationAndTeamData,
                prNumber,
                queriesGenerated: plannerQueries.length,
                plannerSymbols: plannerQueries.map((q) => ({
                    symbol: q.symbolName,
                    risk: q.riskLevel,
                    glob: q.fileGlob,
                })),
                totalSnippetsBeforeDedup,
                finalContexts: finalContexts.length,
                snippetFiles: finalContexts.map((c) => ({
                    file: c.filePath,
                    symbol: c.relatedSymbol,
                    hop: c.hop,
                    score: c.relevanceScore,
                })),
            },
        });

        return {
            contexts: finalContexts,
            plannerQueries,
            totalSearches: plannerQueries.length,
            totalSnippetsBeforeDedup,
        };
    }

    //#region Planner
    private async runPlanner(
        changedFiles: FileChange[],
        byokConfig: BYOKConfig | undefined,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
        language: string,
    ): Promise<CrossFileContextPlannerSchemaType['queries']> {
        try {
            // Prepare per-file diff items (truncated to 2k chars each)
            const fileDiffItems = changedFiles.map((f) => {
                const diff = f.patchWithLinesStr || f.patch || '';
                const truncated =
                    diff.length > 2000
                        ? diff.substring(0, 2000) + '\n... (truncated)'
                        : diff;
                return `### ${f.filename}\n${truncated}`;
            });

            const changedFilenames = changedFiles.map((f) => f.filename);

            // Determine effective model for token counting
            const effectiveModel = byokConfig?.main?.model
                ? byokConfig.main.model
                : LLMModelProvider.CEREBRAS_GPT_OSS_120B;

            // Chunk diff items by token limits
            const byokMaxInputTokens = byokConfig?.main?.maxInputTokens;

            const chunkingResult = this.tokenChunkingService.chunkDataByTokens({
                model: effectiveModel,
                data: fileDiffItems,
                usagePercentage: 50,
                defaultMaxTokens: 64000,
                ...(byokMaxInputTokens && byokMaxInputTokens > 0
                    ? { overrideMaxTokens: byokMaxInputTokens }
                    : {}),
            });

            this.logger.log({
                message: `Planner chunked ${fileDiffItems.length} files into ${chunkingResult.totalChunks} batch(es) for PR#${prNumber}`,
                context: CollectCrossFileContextsService.name,
                metadata: {
                    organizationAndTeamData,
                    prNumber,
                    totalFiles: fileDiffItems.length,
                    totalChunks: chunkingResult.totalChunks,
                    tokenLimit: chunkingResult.tokenLimit,
                    tokensPerChunk: chunkingResult.tokensPerChunk,
                },
            });

            // Run planner batches with limited concurrency (max 4 at a time)
            const BATCH_CONCURRENCY = 4;
            const allQueries: PlannerQuery[] = [];
            const chunks = chunkingResult.chunks as string[][];

            for (let i = 0; i < chunks.length; i += BATCH_CONCURRENCY) {
                const window = chunks.slice(i, i + BATCH_CONCURRENCY);
                const batchSettled = await Promise.allSettled(
                    window.map((batchItems) => {
                        const batchDiffSummary = batchItems.join('\n\n');
                        return this.buildPlannerPromptRunner(
                            batchDiffSummary,
                            changedFilenames,
                            language,
                            byokConfig,
                            organizationAndTeamData,
                            prNumber,
                        );
                    }),
                );

                for (const settled of batchSettled) {
                    if (settled.status === 'fulfilled') {
                        allQueries.push(...(settled.value ?? []));
                    } else {
                        this.logger.warn({
                            message: `Planner batch failed for PR#${prNumber}`,
                            context: CollectCrossFileContextsService.name,
                            error: settled.reason,
                            metadata: { organizationAndTeamData, prNumber },
                        });
                    }
                }
            }

            if (!allQueries.length) {
                this.logger.warn({
                    message: `Planner returned empty queries for PR#${prNumber}`,
                    context: CollectCrossFileContextsService.name,
                    metadata: { organizationAndTeamData, prNumber },
                });
                return [];
            }

            // Deduplicate across batches and apply global cap
            const deduped = this.deduplicatePlannerQueries(allQueries);
            return deduped.slice(0, MAX_PLANNER_QUERIES);
        } catch (error) {
            this.logger.error({
                message: `Planner LLM failed for PR#${prNumber}`,
                context: CollectCrossFileContextsService.name,
                error,
                metadata: { organizationAndTeamData, prNumber },
            });
            return [];
        }
    }

    private async buildPlannerPromptRunner(
        diffSummary: string,
        changedFilenames: string[],
        language: string,
        byokConfig: BYOKConfig | undefined,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<CrossFileContextPlannerSchemaType['queries']> {
        const payload = { diffSummary, changedFilenames, language };

        const provider = LLMModelProvider.CEREBRAS_GPT_OSS_120B;
        const fallbackProvider = LLMModelProvider.GEMINI_2_5_FLASH;

        const promptRunner = new BYOKPromptRunnerService(
            this.promptRunnerService,
            provider,
            fallbackProvider,
            byokConfig,
        );

        const runName = 'crossFileContextPlanner';
        const spanName = `${CollectCrossFileContextsService.name}::${runName}`;
        const spanAttrs = {
            organizationId: organizationAndTeamData?.organizationId,
            prNumber,
            type: promptRunner.executeMode,
        };

        const builder = promptRunner
            .builder()
            .setParser(ParserType.ZOD, CrossFileContextPlannerSchema as any)
            .setLLMJsonMode(true)
            .setPayload(payload)
            .addPrompt({
                prompt: prompt_cross_file_context_planner,
                role: PromptRole.SYSTEM,
            })
            .addPrompt({
                prompt: 'Analyze the diff and generate search queries. Return the response in the specified JSON format.',
                role: PromptRole.USER,
            })
            .setTemperature(0)
            .addTags(['crossFileContextPlanner', `model:${provider}`])
            .setRunName(runName)
            .addMetadata({
                organizationAndTeamData,
                prNumber,
                runName,
            });

        const { result } = await this.observabilityService.runLLMInSpan({
            spanName,
            runName,
            attrs: spanAttrs,
            exec: (callbacks) => builder.addCallbacks(callbacks).execute(),
        });

        return (result as CrossFileContextPlannerSchemaType)?.queries ?? [];
    }

    private deduplicatePlannerQueries(queries: PlannerQuery[]): PlannerQuery[] {
        const riskRank: Record<string, number> = {
            high: 3,
            medium: 2,
            low: 1,
        };

        const seen = new Map<string, PlannerQuery>();

        for (const query of queries) {
            const key = `${query.symbolName ?? ''}::${query.pattern}`;
            const existing = seen.get(key);

            if (
                !existing ||
                (riskRank[query.riskLevel] ?? 0) >
                    (riskRank[existing.riskLevel] ?? 0)
            ) {
                seen.set(key, query);
            }
        }

        return Array.from(seen.values());
    }
    //#endregion

    //#region Search Execution
    private async executeSearchQueries(
        queries: PlannerQuery[],
        remoteCommands: RemoteCommands,
        changedFilePaths: Set<string>,
        repoRoot: string,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<CrossFileContextSnippet[]> {
        const allSnippets: CrossFileContextSnippet[] = [];

        const client = new WarpGrepClient({
            morphApiKey:
                this.configService.get<string>('API_MORPHLLM_API_KEY') ?? '',
        });

        for (const query of queries) {
            try {
                this.logger.log({
                    message: `Executing search query for PR#${prNumber}: "${query.pattern}" (symbol: ${query.symbolName}, glob: ${query.fileGlob || '*'})`,
                    context: CollectCrossFileContextsService.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        pattern: query.pattern,
                        symbolName: query.symbolName,
                        fileGlob: query.fileGlob,
                        riskLevel: query.riskLevel,
                        repoRoot,
                    },
                });

                const result: WarpGrepResult = await client.execute({
                    query: query.pattern,
                    repoRoot,
                    remoteCommands,
                    includes: query.fileGlob ? [query.fileGlob] : undefined,
                    excludes: [
                        'node_modules',
                        '.git',
                        'dist',
                        'build',
                        '*.min.js',
                        '*.map',
                    ],
                    debug: true,
                });

                this.logger.log({
                    message: `Search result for PR#${prNumber} pattern "${query.pattern}": success=${result.success}, contexts=${result.contexts?.length ?? 0}`,
                    context: CollectCrossFileContextsService.name,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        pattern: query.pattern,
                        success: result.success,
                        contextsCount: result.contexts?.length ?? 0,
                        contextFiles: result.contexts?.map((c) => c.file) ?? [],
                    },
                });

                if (!result.success || !result.contexts?.length) {
                    continue;
                }

                for (const ctx of result.contexts) {
                    // Filter out files that are already in the PR
                    if (changedFilePaths.has(ctx.file)) {
                        this.logger.log({
                            message: `Filtering out changed file from cross-file results: ${ctx.file}`,
                            context: CollectCrossFileContextsService.name,
                        });
                        continue;
                    }

                    allSnippets.push({
                        filePath: ctx.file,
                        content: ctx.content,
                        rationale: query.rationale,
                        relevanceScore: this.getBaseScore(query.riskLevel),
                        relatedSymbol: query.symbolName,
                        relationship: `consumer of ${query.symbolName || query.pattern}`,
                        hop: 1,
                        riskLevel: query.riskLevel,
                        targetFiles: [query.sourceFile],
                    });
                }
            } catch (error) {
                this.logger.warn({
                    message: `Search query failed for pattern "${query.pattern}" on PR#${prNumber}`,
                    context: CollectCrossFileContextsService.name,
                    error,
                    metadata: {
                        organizationAndTeamData,
                        prNumber,
                        pattern: query.pattern,
                    },
                });
            }
        }

        return allSnippets;
    }
    //#endregion

    //#region Context Expansion
    private async expandContextWindows(
        snippets: CrossFileContextSnippet[],
        remoteCommands: RemoteCommands,
    ): Promise<CrossFileContextSnippet[]> {
        const expanded: CrossFileContextSnippet[] = [];

        for (const snippet of snippets) {
            try {
                const lineCount = snippet.content.split('\n').length;

                if (lineCount >= MIN_SNIPPET_LINES) {
                    expanded.push(snippet);
                    continue;
                }

                // Skip expansion if we don't have actual line position info
                // Without it, we'd read wrong lines from the file
                if (!snippet.startLine || !snippet.endLine) {
                    expanded.push(snippet);
                    continue;
                }

                const window =
                    lineCount <= 1
                        ? CONTEXT_WINDOW_SINGLE_LINE
                        : CONTEXT_WINDOW_SMALL;

                const startLine = Math.max(
                    1,
                    (snippet.startLine || 1) - window,
                );
                const endLine = (snippet.endLine || lineCount) + window;

                const expandedContent = await remoteCommands.read(
                    snippet.filePath,
                    startLine,
                    endLine,
                );

                if (expandedContent) {
                    // Enforce per-file char limit
                    const trimmed = expandedContent.substring(
                        0,
                        MAX_PER_FILE_CHARS,
                    );

                    expanded.push({
                        ...snippet,
                        content: trimmed,
                        startLine,
                        endLine,
                    });
                } else {
                    expanded.push(snippet);
                }
            } catch {
                // Keep the original snippet if expansion fails
                expanded.push(snippet);
            }
        }

        return expanded;
    }
    //#endregion

    //#region Hop 2
    private async executeHop2(
        hop1Snippets: CrossFileContextSnippet[],
        remoteCommands: RemoteCommands,
        changedFilePaths: Set<string>,
        repoRoot: string,
        organizationAndTeamData: OrganizationAndTeamData,
        prNumber: number,
    ): Promise<CrossFileContextSnippet[]> {
        const hop2Snippets: CrossFileContextSnippet[] = [];
        const highRiskSnippets = hop1Snippets.filter(
            (s) => s.riskLevel === 'high',
        );

        if (!highRiskSnippets.length) {
            return hop2Snippets;
        }

        try {
            const client = new WarpGrepClient({
                morphApiKey:
                    this.configService.get<string>('API_MORPHLLM_API_KEY') ??
                    '',
            });

            // Extract function names only from high-risk hop 1 snippets
            const hop1FunctionNames = new Set<string>();
            const funcToTargetFiles = new Map<string, Set<string>>();
            for (const snippet of highRiskSnippets) {
                const funcNames = this.extractFunctionNames(snippet.content);
                for (const name of funcNames) {
                    hop1FunctionNames.add(name);
                    const existing =
                        funcToTargetFiles.get(name) || new Set<string>();
                    snippet.targetFiles?.forEach((f) => existing.add(f));
                    funcToTargetFiles.set(name, existing);
                }
            }

            // For each function found in hop 1, search for its callers
            const hop1FilePaths = new Set(hop1Snippets.map((s) => s.filePath));
            const excludedPaths = new Set([
                ...changedFilePaths,
                ...hop1FilePaths,
            ]);

            for (const funcName of hop1FunctionNames) {
                if (!funcName || funcName.length < 3) continue;

                try {
                    const result = await client.execute({
                        query: funcName,
                        repoRoot,
                        remoteCommands,
                        excludes: ['node_modules', '.git', 'dist', 'build'],
                    });

                    if (!result.success || !result.contexts?.length) {
                        continue;
                    }

                    for (const ctx of result.contexts) {
                        if (excludedPaths.has(ctx.file)) continue;

                        hop2Snippets.push({
                            filePath: ctx.file,
                            content: ctx.content,
                            rationale: `Hop 2: caller of ${funcName} found in hop 1 results`,
                            relevanceScore: this.getBaseScore('high') - 10,
                            relatedSymbol: funcName,
                            relationship: `indirect consumer (hop 2) of ${funcName}`,
                            hop: 2,
                            riskLevel: 'high',
                            targetFiles: [
                                ...(funcToTargetFiles.get(funcName) || []),
                            ],
                        });
                    }
                } catch (error) {
                    this.logger.warn({
                        message: `Hop 2 search failed for function "${funcName}" on PR#${prNumber}`,
                        context: CollectCrossFileContextsService.name,
                        error,
                        metadata: {
                            organizationAndTeamData,
                            prNumber,
                            funcName,
                        },
                    });
                }
            }
        } catch (error) {
            this.logger.warn({
                message: `Hop 2 execution failed entirely for PR#${prNumber}`,
                context: CollectCrossFileContextsService.name,
                error,
                metadata: { organizationAndTeamData, prNumber },
            });
        }

        return hop2Snippets;
    }
    //#endregion

    //#region Dedup & Rank
    private deduplicateAndRank(
        snippets: CrossFileContextSnippet[],
    ): CrossFileContextSnippet[] {
        // Group by file
        const byFile = new Map<string, CrossFileContextSnippet[]>();
        for (const snippet of snippets) {
            const existing = byFile.get(snippet.filePath) || [];
            existing.push(snippet);
            byFile.set(snippet.filePath, existing);
        }

        // Merge overlapping snippets per file and enforce per-file limit
        const merged: CrossFileContextSnippet[] = [];
        for (const [, fileSnippets] of byFile) {
            // Sort by relevance score desc, keep the best
            fileSnippets.sort((a, b) => b.relevanceScore - a.relevanceScore);

            const snippetsForThisFile: CrossFileContextSnippet[] = [];
            let totalChars = 0;

            for (const snippet of fileSnippets) {
                if (totalChars + snippet.content.length > MAX_PER_FILE_CHARS) {
                    continue;
                }

                // Check for overlap only within snippets for the current file
                const overlappingSnippet = snippetsForThisFile.find(
                    (existing) =>
                        this.hasContentOverlap(
                            existing.content,
                            snippet.content,
                        ),
                );

                if (overlappingSnippet) {
                    // Merge targetFiles from the duplicate into the survivor
                    if (snippet.targetFiles?.length) {
                        overlappingSnippet.targetFiles = [
                            ...new Set([
                                ...(overlappingSnippet.targetFiles || []),
                                ...snippet.targetFiles,
                            ]),
                        ];
                    }
                } else {
                    totalChars += snippet.content.length;
                    snippetsForThisFile.push(snippet);
                }
            }
            merged.push(...snippetsForThisFile);
        }

        // Sort by score descending
        merged.sort((a, b) => b.relevanceScore - a.relevanceScore);

        // Cap at MAX_TOTAL_CONTEXTS and MAX_TOTAL_CHARS
        const finalSnippets: CrossFileContextSnippet[] = [];
        let totalChars = 0;

        for (const snippet of merged) {
            if (finalSnippets.length >= MAX_TOTAL_CONTEXTS) break;
            if (totalChars + snippet.content.length > MAX_TOTAL_CHARS) continue;

            totalChars += snippet.content.length;
            finalSnippets.push(snippet);
        }

        return finalSnippets;
    }
    //#endregion

    //#region Utilities
    private getBaseScore(riskLevel: 'low' | 'medium' | 'high'): number {
        switch (riskLevel) {
            case 'high':
                return 80;
            case 'medium':
                return 50;
            case 'low':
                return 30;
            default:
                return 20;
        }
    }

    private extractFunctionNames(content: string): string[] {
        const names: string[] = [];

        // Match common function/method patterns across languages
        const patterns = [
            // JS/TS: function name(, async name(, name(, name =(
            /(?:function|async)\s+(\w+)\s*\(/g,
            /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
            /(\w+)\s*\([^)]*\)\s*\{/g,
            // Python: def name(
            /def\s+(\w+)\s*\(/g,
            // Go: func name(, func (receiver) name(
            /func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/g,
            // Java/C#: access modifier type name(
            /(?:public|private|protected|static)\s+\w+\s+(\w+)\s*\(/g,
        ];

        for (const pattern of patterns) {
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(content)) !== null) {
                const name = match[1];
                if (name && name.length >= 3 && !this.isCommonKeyword(name)) {
                    names.push(name);
                }
            }
        }

        return [...new Set(names)];
    }

    private isCommonKeyword(name: string): boolean {
        const keywords = new Set([
            'if',
            'for',
            'while',
            'return',
            'const',
            'let',
            'var',
            'function',
            'class',
            'import',
            'export',
            'from',
            'new',
            'this',
            'super',
            'async',
            'await',
            'try',
            'catch',
            'throw',
            'else',
            'switch',
            'case',
            'break',
            'continue',
            'default',
            'typeof',
            'instanceof',
        ]);
        return keywords.has(name);
    }

    private hasContentOverlap(a: string, b: string): boolean {
        if (a === b) return true;
        // Check if one contains a significant portion of the other
        const shorter = a.length < b.length ? a : b;
        const longer = a.length >= b.length ? a : b;
        return longer.includes(
            shorter.substring(0, Math.min(200, shorter.length)),
        );
    }
    //#endregion
}
