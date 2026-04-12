import { createLogger } from '@kodus/flow';
import { PromptRunnerService } from '@kodus/kodus-common/llm';
import { Injectable } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    CodeReviewConfig,
    CodeSuggestion,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { convertTiptapJSONToText } from '@libs/common/utils/tiptap-json';
import { byokToVercelModel, getModelName } from './llm/byok-to-vercel';
import { resolveContextWindow } from './llm/model-context-window';
import {
    runAgentLoop,
    type AgentLoopSecrets,
    type VerificationTraceSummary,
    type AgentAnomalySummary,
} from './llm/agent-loop';
import {
    CoverageSummary,
    formatCoverageTargetsForPrompt,
} from './llm/coverage-ledger';

/** Rough token estimate: 1 token ≈ 4 characters */
const CHARS_PER_TOKEN = 4;
/** Use at most 60% of the context window for diffs */
const DIFF_BUDGET_RATIO = 0.6;

function estimateDiffTokens(files: FileChange[]): number {
    return files.reduce((sum, f) => {
        const diff = f.patchWithLinesStr ?? f.patch ?? '';
        return sum + Math.ceil(diff.length / CHARS_PER_TOKEN);
    }, 0);
}

function chunkFilesByTokenBudget(files: FileChange[], budgetTokens: number): FileChange[][] {
    if (files.length === 0) return [[]];

    const chunks: FileChange[][] = [];
    let currentChunk: FileChange[] = [];
    let currentTokens = 0;

    for (const file of files) {
        const diff = file.patchWithLinesStr ?? file.patch ?? '';
        const fileTokens = Math.ceil(diff.length / CHARS_PER_TOKEN);

        // If a single file exceeds the budget, give it its own chunk
        if (fileTokens > budgetTokens) {
            if (currentChunk.length > 0) {
                chunks.push(currentChunk);
                currentChunk = [];
                currentTokens = 0;
            }
            chunks.push([file]);
            continue;
        }

        if (currentTokens + fileTokens > budgetTokens && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentTokens = 0;
        }

        currentChunk.push(file);
        currentTokens += fileTokens;
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}

function formatOtherFilesSummary(allFiles: FileChange[], batchFiles: Set<string>): string {
    const others = allFiles.filter(f => !batchFiles.has(f.filename));
    if (others.length === 0) return '';

    const lines = others.map(f => `  - ${f.filename} (+${f.additions} -${f.deletions})`).join('\n');
    return `\n  <OtherFilesInThisPR count="${others.length}">\n    The following files are also changed in this PR but reviewed in a separate batch:\n${lines}\n  </OtherFilesInThisPR>`;
}

const DEFAULT_SEVERITY_FLAGS = {
    critical:
        'Runtime crash, data loss, or security breach that affects all users. The service goes down or data is corrupted. Examples: unhandled null dereference on a main code path, SQL injection, infinite recursion, writing to the wrong database table.',
    high: 'A core feature is broken or produces wrong results for most users. Examples: wrong return value from a public API, race condition that corrupts shared state, broken authentication flow, missing permission check on a sensitive endpoint.',
    medium: 'A feature is broken in a specific scenario or edge case. Most users are unaffected but the bug is real. Examples: off-by-one in pagination, incorrect behavior when input is empty, stale cache after update, wrong error message shown to user.',
    low: 'Minor issue with minimal user impact. Examples: dead code, misleading log level, missing type annotation, hardcoded value that should be configurable, cosmetic inconsistency.',
} as const;

function resolvePromptOverrideText(value: unknown): string {
    if (value === undefined || value === null) {
        return '';
    }

    if (typeof value === 'string') {
        return convertTiptapJSONToText(value).trim();
    }

    if (typeof value === 'object') {
        if ('value' in value) {
            return resolvePromptOverrideText(
                (value as { value?: unknown }).value,
            );
        }

        return convertTiptapJSONToText(value as Record<string, unknown>).trim();
    }

    return '';
}

/**
 * Category-specific agent configuration provided by each concrete subclass.
 */
export interface ReviewAgentIdentity {
    name: string;
    description: string;
    goal: string;
    expertise: string[];
}

/**
 * Input passed to the agent for a single review execution.
 */
/**
 * Progress event emitted by agents during investigation.
 */
export interface AgentProgressEvent {
    agentName: string;
    agentCategory?: string;
    agentReplicaIndex?: number;
    agentReplicaTotal?: number;
    status: 'started' | 'investigating' | 'completed' | 'error';
    step?: number;
    toolCalls?: Array<{ tool: string; args: string; durationMs?: number }>;
    findings?: number;
    durationMs?: number;
    totalTokens?: number;
    /** How the agent finished — helps surface timeouts and max-steps in the UI */
    finishReason?: 'stop' | 'timeout' | 'max-steps' | 'error';
    /** How findings were obtained — 'json-parse' (normal), 'second-chance', 'generate-object' (fallback LLM), 'empty' */
    source?: string;
    suggestionsPreview?: Array<{
        relevantFile?: string;
        relevantLinesStart?: number;
        relevantLinesEnd?: number;
        oneSentenceSummary?: string;
        label?: string;
        severity?: string;
    }>;
    coverage?: CoverageSummary;
    verification?: VerificationTraceSummary | null;
    anomalies?: AgentAnomalySummary;
}

export interface ReviewAgentInput {
    organizationAndTeamData: OrganizationAndTeamData;
    changedFiles: FileChange[];
    /**
     * Remote commands for the E2B sandbox. When undefined, the agent runs
     * in self-contained mode (no tools, single-shot analysis on the diffs
     * inlined in the user prompt). Used by the CLI trial flow where there
     * is no sandbox available.
     */
    remoteCommands: RemoteCommands | undefined;
    prNumber: number;
    repositoryId?: string;
    repositoryFullName: string;
    languageResultPrompt: string;
    memoryRules?: Partial<IKodyRule>[];
    v2PromptOverrides?: CodeReviewConfig['v2PromptOverrides'];
    generationMain?: string;
    prTitle?: string;
    prBody?: string;
    onAgentProgress?: (event: AgentProgressEvent) => void;
    gitHubToken?: string;
    /** Base branch of the PR (e.g. "main"). Passed to tools for git diff. */
    baseBranch?: string;
    /** Pre-computed call graph for changed functions. Generated once, shared across agents. */
    callGraph?: string;
    /** Optional runtime alias used to distinguish replicated agent runs in traces. */
    agentRuntimeName?: string;
    /** Optional replica metadata for replicated agent runs. */
    agentReplicaIndex?: number;
    agentReplicaTotal?: number;
    /** Review mode: 'fast' skips heavy passes (verify, coverage recovery, synthesis rescue) and caps agent steps; 'normal' skips verify only for very-high-confidence findings; 'deep' verifies everything. */
    reviewMode?: 'fast' | 'normal' | 'deep';
    /** Minimum severity level to keep. Findings below this threshold are discarded before verify. */
    severityLevelFilter?: string;
    /** Optional per-agent step budget for the main investigation loop. */
    maxSteps?: number;
    /** Categories allowed for this run when using a mixed/generalist reviewer. */
    requestedCategories?: Array<'bug' | 'security' | 'performance'>;
}

/**
 * Output from a single agent execution.
 */
export interface ReviewAgentOutput {
    suggestions: Partial<CodeSuggestion>[];
    discardedBySeverity?: Partial<CodeSuggestion>[];
    discardedByVerify?: Partial<CodeSuggestion>[];
    agentName: string;
    agentCategory?: string;
    agentReplicaIndex?: number;
    agentReplicaTotal?: number;
    turnsUsed: number;
    durationMs: number;
}

/**
 * Abstract base class for code review agents (Bugs, Security, Performance).
 *
 * Uses Vercel AI SDK with native function calling instead of text-based ReAct.
 * This works with any model (BYOK) because the SDK translates tool definitions
 * to each provider's native format (OpenAI function_call, Anthropic tool_use,
 * Gemini function_calling, OpenRouter, etc.).
 *
 * Subclasses only define:
 * - identity (name, description, goal, expertise)
 * - category-specific system prompt
 * - category label
 */
@Injectable()
export abstract class BaseCodeReviewAgentProvider {
    private readonly agentLogger = createLogger('CodeReviewAgent');

    constructor(
        protected readonly promptRunnerService: PromptRunnerService,
        protected readonly permissionValidationService: PermissionValidationService,
        protected readonly observabilityService: ObservabilityService,
    ) {}

    protected abstract getIdentity(): ReviewAgentIdentity;
    protected abstract getCategoryPrompt(): string;
    protected abstract getCategoryLabel(): string;

    protected supportsMixedLabels(): boolean {
        return false;
    }

    protected getAllowedSuggestionLabels(
        _input: ReviewAgentInput,
    ): Array<'bug' | 'security' | 'performance'> {
        const category = this.getCategoryLabel();
        if (
            category === 'bug' ||
            category === 'security' ||
            category === 'performance'
        ) {
            return [category];
        }

        return ['bug'];
    }

    /**
     * Execute the agent against the provided changed files.
     */
    async execute(input: ReviewAgentInput): Promise<ReviewAgentOutput> {
        const startTime = Date.now();
        const baseIdentity = this.getIdentity();
        const identity: ReviewAgentIdentity = {
            ...baseIdentity,
            name: input.agentRuntimeName || baseIdentity.name,
        };
        const agentCategory = this.getCategoryLabel();

        this.agentLogger.log({
            message: `[AGENT] Starting ${identity.name} for PR#${input.prNumber}`,
            context: identity.name,
            metadata: {
                organizationId: input.organizationAndTeamData?.organizationId,
                teamId: input.organizationAndTeamData?.teamId,
                prNumber: input.prNumber,
                filesCount: input.changedFiles.length,
            },
        });

        // Resolve BYOK config - Scoped locally to prevent race conditions across parallel PR reviews
        const byokConfig = await this.permissionValidationService.getBYOKConfig(
            input.organizationAndTeamData,
        );

        // Create Vercel AI SDK model from BYOK config
        const model = byokToVercelModel(byokConfig);
        const modelName = getModelName(byokConfig);

        this.agentLogger.log({
            message: `[AGENT] ${identity.name} using model: ${modelName}`,
            context: identity.name,
        });

        // Check if diffs exceed the context window budget and need chunking
        const contextWindow = resolveContextWindow({
            byokMaxInputTokens: byokConfig?.main?.maxInputTokens,
            modelName,
        });
        const diffBudget = Math.floor(contextWindow * DIFF_BUDGET_RATIO);
        const totalDiffTokens = estimateDiffTokens(input.changedFiles);

        if (totalDiffTokens > diffBudget && input.changedFiles.length > 1) {
            this.agentLogger.warn({
                message: `[AGENT] ${identity.name} diffs exceed context budget (${totalDiffTokens} tokens > ${diffBudget} budget), splitting into batches`,
                context: identity.name,
                metadata: {
                    totalDiffTokens,
                    diffBudget,
                    contextWindow,
                    filesCount: input.changedFiles.length,
                },
            });

            return this.executeChunked(input, {
                identity,
                agentCategory,
                byokConfig,
                model,
                modelName,
                startTime,
                diffBudget,
            });
        }

        const systemPrompt = this.buildSystemPrompt(input);
        const userPrompt = this.buildUserPrompt(input);

        this.agentLogger.log({
            message: `[AGENT] ${identity.name} prompt context: memoryRules=${input.memoryRules?.length ?? 0}, overrides=${!!input.v2PromptOverrides}, language=${input.languageResultPrompt || 'default'}`,
            context: identity.name,
        });

        // Emit progress: agent started
        input.onAgentProgress?.({
            agentName: identity.name,
            agentCategory,
            agentReplicaIndex: input.agentReplicaIndex,
            agentReplicaTotal: input.agentReplicaTotal,
            status: 'started',
        });

        try {
            // Accumulate tool calls for batch progress updates
            const recentToolCalls: AgentProgressEvent['toolCalls'] = [];
            let stepCount = 0;
            const PROGRESS_BATCH_SIZE = 5;

            // Secrets are passed via closure (not as traceable arg) so that
            // LangSmith tracing never serialises API keys, tokens, or
            // NestJS service instances (which carry ConfigService with all env vars).
            const loopSecrets: AgentLoopSecrets = {
                remoteCommands: input.remoteCommands,
                byokConfig,
                gitHubToken: input.gitHubToken,
            };

            const loopParams = {
                model,
                systemPrompt,
                userPrompt,
                agentName: identity.name,
                telemetryMetadata: {
                    organizationId:
                        input.organizationAndTeamData?.organizationId,
                    teamId: input.organizationAndTeamData?.teamId,
                    pullRequestId: input.prNumber,
                    repositoryId: input.repositoryId,
                    provider: modelName,
                },
                changedFiles: input.changedFiles,
                prNumber: input.prNumber,
                repositoryFullName: input.repositoryFullName,
                baseBranch: input.baseBranch,
                callGraph: input.callGraph,
                reviewMode: input.reviewMode,
                severityLevelFilter: input.severityLevelFilter,
                maxSteps: input.maxSteps,
                contextWindowTokens: contextWindow,

                onStepFinish: (step: any) => {
                    stepCount++;
                    if (step.toolCalls) {
                        for (const tc of step.toolCalls) {
                            this.agentLogger.log({
                                message: `[AGENT-TOOL] PR#${input.prNumber} ${identity.name} tool=${tc.toolName}`,
                                context: identity.name,
                            });
                            recentToolCalls.push({
                                tool: tc.toolName,
                                args: JSON.stringify(
                                    tc.args || tc.input || {},
                                ).substring(0, 100),
                            });
                        }
                    }
                    // Batch progress update every N steps
                    if (
                        stepCount % PROGRESS_BATCH_SIZE === 0 &&
                        recentToolCalls.length > 0
                    ) {
                        input.onAgentProgress?.({
                            agentName: identity.name,
                            agentCategory,
                            agentReplicaIndex: input.agentReplicaIndex,
                            agentReplicaTotal: input.agentReplicaTotal,
                            status: 'investigating',
                            step: stepCount,
                            toolCalls: [...recentToolCalls],
                        });
                        recentToolCalls.length = 0; // Clear after sending
                    }
                },
            };

            let agentResult;
            if (process.env.LANGCHAIN_TRACING_V2 === 'true') {
                const { traceable } = require('langsmith/traceable');
                const tracedRun = traceable(
                    // loopSecrets captured via closure — never serialised by LangSmith
                    (params: typeof loopParams) =>
                        runAgentLoop(params, loopSecrets),
                    {
                        name: identity.name,
                        metadata: {
                            organizationId:
                                input.organizationAndTeamData?.organizationId,
                            teamId: input.organizationAndTeamData?.teamId,
                            prNumber: input.prNumber,
                            pullRequestId: input.prNumber,
                        },
                        processInputs: (inputs: Record<string, any>) => {
                            // Strip redundant `patch` from changedFiles — patchWithLinesStr
                            // already carries the same content with line numbers added.
                            const params = inputs?.args?.[0] ?? inputs;
                            if (params?.changedFiles) {
                                return {
                                    ...params,
                                    changedFiles: params.changedFiles.map(
                                        ({
                                            patch: _patch,
                                            ...rest
                                        }: Record<string, any>) => rest,
                                    ),
                                };
                            }
                            return params;
                        },
                    },
                );
                agentResult = await tracedRun(loopParams);
            } else {
                agentResult = await runAgentLoop(loopParams, loopSecrets);
            }

            const durationMs = Date.now() - startTime;

            // Record token usage to observability (MongoDB spans)
            // Uses runInSpan to ensure proper span lifecycle and MongoDB persistence
            try {
                const vUsage = agentResult.verificationUsage;
                const mainInputTokens =
                    agentResult.usage.inputTokens - (vUsage?.inputTokens ?? 0);
                const mainOutputTokens =
                    agentResult.usage.outputTokens -
                    (vUsage?.outputTokens ?? 0);

                await this.observabilityService.runInSpan(
                    `${identity.name}::review`,
                    async () => agentResult,
                    {
                        'gen_ai.usage.input_tokens': mainInputTokens,
                        'gen_ai.usage.output_tokens': mainOutputTokens,
                        'gen_ai.usage.total_tokens':
                            mainInputTokens + mainOutputTokens,
                        ...(agentResult.usage.reasoningTokens > 0 && {
                            'gen_ai.usage.reasoning_tokens':
                                agentResult.usage.reasoningTokens -
                                (vUsage?.reasoningTokens ?? 0),
                        }),
                        'gen_ai.response.model': modelName,
                        'gen_ai.run.name': `code-review-${this.getCategoryLabel()}`,
                        'type': byokConfig ? 'byok' : 'system',
                        'organizationId':
                            input.organizationAndTeamData?.organizationId,
                        'teamId': input.organizationAndTeamData?.teamId,
                        'prNumber': input.prNumber,
                        'steps': agentResult.steps,
                        'toolCalls': agentResult.toolCalls.length,
                        'finishReason': agentResult.finishReason,
                        'source': agentResult.source,
                        durationMs,
                    },
                );

                // Separate span for verification tokens
                if (
                    vUsage &&
                    (vUsage.inputTokens > 0 || vUsage.outputTokens > 0)
                ) {
                    await this.observabilityService.runInSpan(
                        `${identity.name}::verify`,
                        async () => agentResult,
                        {
                            'gen_ai.usage.input_tokens': vUsage.inputTokens,
                            'gen_ai.usage.output_tokens': vUsage.outputTokens,
                            'gen_ai.usage.total_tokens':
                                vUsage.inputTokens + vUsage.outputTokens,
                            ...(vUsage.reasoningTokens > 0 && {
                                'gen_ai.usage.reasoning_tokens':
                                    vUsage.reasoningTokens,
                            }),
                            'gen_ai.response.model': modelName,
                            'gen_ai.run.name': `code-review-${this.getCategoryLabel()}-verify`,
                            'type': byokConfig ? 'byok' : 'system',
                            'organizationId':
                                input.organizationAndTeamData?.organizationId,
                            'teamId': input.organizationAndTeamData?.teamId,
                            'prNumber': input.prNumber,
                        },
                    );
                }
            } catch {
                // Observability is best-effort
            }

            // Map findings to CodeSuggestion format
            const validFiles = new Set(
                input.changedFiles.map((f) => f.filename),
            );
            const isKodyRules = this.getCategoryLabel() === 'kody_rules';
            const rawSuggestions = (
                agentResult.findings?.suggestions || []
            ).filter(
                (s) =>
                    s.suggestionContent &&
                    // Kody Rules PR-level suggestions may not have a relevantFile
                    (isKodyRules
                        ? !s.relevantFile || validFiles.has(s.relevantFile)
                        : s.relevantFile && validFiles.has(s.relevantFile)),
            );

            const suggestions = rawSuggestions.map((s) => ({
                relevantFile: s.relevantFile,
                language: s.language || '',
                suggestionContent: s.suggestionContent,
                existingCode: s.existingCode || '',
                improvedCode: s.improvedCode || '',
                oneSentenceSummary: s.oneSentenceSummary || '',
                relevantLinesStart: s.relevantLinesStart,
                relevantLinesEnd: s.relevantLinesEnd,
                label: this.resolveSuggestionLabel(
                    s as Partial<CodeSuggestion> & { label?: string },
                    input,
                ),
                severity: s.severity || 'medium',
                llmPrompt: s.suggestionContent,
                ...(s.ruleUuid && { brokenKodyRulesIds: [s.ruleUuid] }),
            }));

            // Emit progress: agent completed
            // Only mark as error if the agent hit a hard limit (timeout or MAX_STEPS with tool-calls finish).
            // source=empty with finishReason=stop is legitimate (agent investigated and found nothing).
            const hitHardLimit =
                agentResult.finishReason === 'timeout' ||
                (agentResult.source === 'empty' &&
                    agentResult.finishReason === 'tool-calls');

            input.onAgentProgress?.({
                agentName: identity.name,
                agentCategory,
                agentReplicaIndex: input.agentReplicaIndex,
                agentReplicaTotal: input.agentReplicaTotal,
                status: hitHardLimit ? 'error' : 'completed',
                findings: suggestions.length,
                durationMs,
                totalTokens: agentResult.usage.totalTokens,
                step: agentResult.steps,
                finishReason:
                    agentResult.finishReason === 'timeout'
                        ? 'timeout'
                        : hitHardLimit
                          ? 'max-steps'
                          : 'stop',
                source: agentResult.source,
                coverage: agentResult.coverage,
                verification: agentResult.verification,
                anomalies: agentResult.anomalies,
                suggestionsPreview: suggestions.slice(0, 10).map((s) => ({
                    relevantFile: s.relevantFile,
                    relevantLinesStart: s.relevantLinesStart,
                    relevantLinesEnd: s.relevantLinesEnd,
                    oneSentenceSummary: s.oneSentenceSummary,
                    label: s.label,
                    severity: s.severity,
                })),
                toolCalls: agentResult.toolCalls.map((tc) => ({
                    tool: tc.toolName || tc.tool,
                    args: JSON.stringify(tc.args).substring(0, 100),
                })),
            });

            this.agentLogger.log({
                message: `[AGENT] ${identity.name} completed for PR#${input.prNumber}: ${suggestions.length} suggestions in ${durationMs}ms (source=${agentResult.source}, steps=${agentResult.steps}, tools=${agentResult.toolCalls.length}, input=${agentResult.usage.inputTokens}, output=${agentResult.usage.outputTokens}, total=${agentResult.usage.totalTokens})`,
                context: identity.name,
                metadata: {
                    organizationId:
                        input.organizationAndTeamData?.organizationId,
                    prNumber: input.prNumber,
                    suggestionsCount: suggestions.length,
                    durationMs,
                    source: agentResult.source,
                    steps: agentResult.steps,
                    toolCalls: agentResult.toolCalls.length,
                    inputTokens: agentResult.usage.inputTokens,
                    outputTokens: agentResult.usage.outputTokens,
                    totalTokens: agentResult.usage.totalTokens,
                    finishReason: agentResult.finishReason,
                    model: modelName,
                    coverage: agentResult.coverage,
                    verification: agentResult.verification,
                    anomalies: agentResult.anomalies,
                },
            });

            return {
                suggestions,
                discardedBySeverity: (
                    agentResult.discardedBySeverity || []
                ).map((s) => ({
                    relevantFile: s.relevantFile,
                    suggestionContent: s.suggestionContent,
                    severity: s.severity || 'medium',
                    label: this.getCategoryLabel(),
                    oneSentenceSummary: s.oneSentenceSummary || '',
                })),
                discardedByVerify: (agentResult.droppedByVerify || []).map(
                    (s) => ({
                        relevantFile: s.relevantFile,
                        suggestionContent: s.suggestionContent,
                        severity: s.severity || 'medium',
                        label: this.getCategoryLabel(),
                        oneSentenceSummary: s.oneSentenceSummary || '',
                    }),
                ),
                agentName: identity.name,
                agentCategory,
                agentReplicaIndex: input.agentReplicaIndex,
                agentReplicaTotal: input.agentReplicaTotal,
                turnsUsed: agentResult.steps,
                durationMs,
            };
        } catch (error) {
            const durationMs = Date.now() - startTime;
            input.onAgentProgress?.({
                agentName: identity.name,
                agentCategory,
                agentReplicaIndex: input.agentReplicaIndex,
                agentReplicaTotal: input.agentReplicaTotal,
                status: 'error',
                durationMs,
            });
            this.agentLogger.error({
                message: `[AGENT] ${identity.name} failed for PR#${input.prNumber} after ${durationMs}ms: ${error instanceof Error ? error.message : String(error)}`,
                context: identity.name,
                error,
                metadata: {
                    prNumber: input.prNumber,
                    durationMs,
                    model: modelName,
                    errorStack:
                        error instanceof Error
                            ? error.stack?.substring(0, 500)
                            : undefined,
                },
            });
            return {
                suggestions: [],
                agentName: identity.name,
                agentCategory,
                agentReplicaIndex: input.agentReplicaIndex,
                agentReplicaTotal: input.agentReplicaTotal,
                turnsUsed: 0,
                durationMs,
            };
        }
    }

    /**
     * Runs the agent in multiple batches when the total diff size exceeds
     * the model's context window budget. Each batch gets a subset of files
     * with their full diffs, plus a summary of the other files in the PR.
     */
    private async executeChunked(
        input: ReviewAgentInput,
        ctx: {
            identity: ReviewAgentIdentity;
            agentCategory: string;
            byokConfig: any;
            model: any;
            modelName: string;
            startTime: number;
            diffBudget: number;
        },
    ): Promise<ReviewAgentOutput> {
        const { identity, agentCategory, byokConfig, model, modelName, startTime, diffBudget } = ctx;
        const chunks = chunkFilesByTokenBudget(input.changedFiles, diffBudget);

        this.agentLogger.log({
            message: `[AGENT] ${identity.name} PR#${input.prNumber}: reviewing ${input.changedFiles.length} files in ${chunks.length} batch(es)`,
            context: identity.name,
            metadata: {
                batches: chunks.map((c, i) => ({
                    batch: i + 1,
                    files: c.length,
                    tokens: estimateDiffTokens(c),
                })),
            },
        });

        const allSuggestions: Partial<CodeSuggestion>[] = [];
        const allDiscardedBySeverity: Partial<CodeSuggestion>[] = [];
        const allDiscardedByVerify: Partial<CodeSuggestion>[] = [];
        let totalTurns = 0;

        for (let i = 0; i < chunks.length; i++) {
            const batchFiles = chunks[i];
            const batchFileSet = new Set(batchFiles.map(f => f.filename));
            const batchLabel = `${identity.name} batch ${i + 1}/${chunks.length}`;

            this.agentLogger.log({
                message: `[AGENT] ${batchLabel} starting: ${batchFiles.length} files`,
                context: identity.name,
                metadata: { files: batchFiles.map(f => f.filename) },
            });

            try {
                const batchInput: ReviewAgentInput = {
                    ...input,
                    changedFiles: batchFiles,
                    agentRuntimeName: batchLabel,
                };

                const batchResult = await this.execute(batchInput);

                allSuggestions.push(...batchResult.suggestions);
                if (batchResult.discardedBySeverity) {
                    allDiscardedBySeverity.push(...batchResult.discardedBySeverity);
                }
                if (batchResult.discardedByVerify) {
                    allDiscardedByVerify.push(...batchResult.discardedByVerify);
                }
                totalTurns += batchResult.turnsUsed;

                this.agentLogger.log({
                    message: `[AGENT] ${batchLabel} completed: ${batchResult.suggestions.length} findings`,
                    context: identity.name,
                });
            } catch (error) {
                this.agentLogger.error({
                    message: `[AGENT] ${batchLabel} failed: ${error instanceof Error ? error.message : String(error)}`,
                    context: identity.name,
                    error,
                });
            }
        }

        const durationMs = Date.now() - startTime;

        this.agentLogger.log({
            message: `[AGENT] ${identity.name} PR#${input.prNumber} all batches done: ${allSuggestions.length} total findings in ${durationMs}ms`,
            context: identity.name,
        });

        input.onAgentProgress?.({
            agentName: identity.name,
            agentCategory,
            agentReplicaIndex: input.agentReplicaIndex,
            agentReplicaTotal: input.agentReplicaTotal,
            status: 'completed',
            findings: allSuggestions.length,
            durationMs,
        });

        return {
            suggestions: allSuggestions,
            discardedBySeverity: allDiscardedBySeverity,
            discardedByVerify: allDiscardedByVerify,
            agentName: identity.name,
            agentCategory,
            agentReplicaIndex: input.agentReplicaIndex,
            agentReplicaTotal: input.agentReplicaTotal,
            turnsUsed: totalTurns,
            durationMs,
        };
    }

    private buildSystemPrompt(input: ReviewAgentInput): string {
        const isSelfContained = !input.remoteCommands;
        if (isSelfContained) {
            return this.buildSelfContainedSystemPrompt(input);
        }

        const identity = this.getIdentity();
        const categoryPrompt = this.getCategoryPrompt();
        const overridesSection = this.formatOverrides(input);
        const memoryRulesSection = this.formatMemoryRules(input.memoryRules);

        const langLabel = resolveLanguageLabel(input.languageResultPrompt);
        const langSection = langLabel
            ? `\n  <Language>Write ALL review comments, summaries, and reasoning in ${langLabel}. This is mandatory — do not fall back to English.</Language>`
            : '';

        return `<CodeReviewAgent>
  <Date>${new Date().toLocaleDateString('en-GB')}</Date>
  <Role>
    You are ${identity.name}, ${identity.description}
    ${categoryPrompt}${langSection}
  </Role>

  <Mindset>
    Assume every change is broken until you prove it is safe.
    Your default is to report — you need evidence to DISMISS, not evidence to report.
    "Looks correct" is not enough to dismiss. You must explain WHY it cannot fail.
    High-recall mode: if the visible code gives you concrete, code-backed suspicion of a defect, emit the finding instead of self-censoring it. A later verifier will filter unsupported claims.
  </Mindset>

  <Workflow>
    Your first action must be a tool call — not text.

    PHASE 1 — INVESTIGATE (use tools)

      Step 1: Read the diffs. For each changed function/method, list what it does differently now.

      Step 2: For each method CHANGED in the diff, trace the call chain:
        a) grep("exactMethodName\\(", excludeTests=true) → find who calls it
        b) readFile the caller — what does it pass? What does it expect back?
        c) If the changed method calls ANOTHER method, grep for THAT method too — read it. What does it actually return? Is it the right target?
        d) Keep following calls until you hit a concrete implementation or return value. Do NOT stop at the first layer.
        For interfaces/abstract methods, grep "implements X" or "extends X" to find concrete implementations.
        e) Before every readFile call, identify the exact unanswered question that this read will answer.
        f) Do not reread a highly overlapping range of the same file unless you have a new concrete question, such as a newly discovered symbol, a specific caller/callee to verify, or a branch not covered by the previous read.
        g) Confidence-seeking rereads are a mistake. If the next read would mostly overlap with what you already saw and you cannot name a new question, do not make that read.

      Step 3: Read caller context. Understand HOW the changed code is used in production.
        If you have a concrete compile-time or contract hypothesis and checkTypes is available, you may use it to verify that hypothesis on the changed files.

      Step 4: If the code uses an external library or framework API that you are unsure about, use searchDocs to verify.
        Examples: "Does Rails serializer require ? suffix on include_ methods?", "Does Python dataclass use shared mutable defaults?", "Does Prisma @updatedAt fire with empty data object?"
        Do NOT guess framework behavior — verify it.

    PHASE 2 — CHALLENGE (think adversarially)

      For each changed function, ask yourself these questions:
        - "What if this input is null/nil/empty/zero?" → check if new code handles it. Then ask: "Does handling it by returning early silently disable a feature that should work in that case?"
        - "What if two requests hit this at the same time?" → check-then-act without lock = race condition
        - "What if a caller passes a different type than expected?" → datetime vs number, dict vs list
        - "What if this function is called from a path I haven't seen?" → grep again if unsure
        - "Does this change break any existing caller?" → did the signature, return type, or side effect change?
        - "Does this affect caching/invalidation?" → changed predicate = stale cache risk
        - "Does this code delegate to another layer (cache, proxy, adapter)?" → is it calling the right target — delegate vs self, concrete vs default?
        - "When code calls through an indirection (session.getProvider(), context.getService(), factory.create()), which concrete object is returned?" → grep for the registration/binding to verify. Only report a self-recursion if you found concrete evidence (e.g. a registration line binding the interface to the current class).
      If you cannot confidently answer "this is safe" for any question, investigate more or report it.

    PHASE 3 — RESPOND

      Write reasoning that shows your adversarial analysis:
        For each changed function: what you challenged, what you found, why you reported or dismissed it.
        BAD reasoning: "The code looks correct."
        GOOD reasoning: "Challenged CreateDevice: what if two requests pass count check simultaneously? Grepped TagDevice(, found caller at impl.go:155. No lock or unique constraint — race condition. Reported."

      Do not stop after finding the first issue — investigate ALL changed code before responding.
      Do not burn steps rereading the same body. If a readFile range overlaps heavily with what you already saw, reread only when a newly discovered symbol or branch creates a new concrete question; otherwise continue with grep, caller/callee tracing, or another changed file.

    IMPORTANT — VERIFY BEFORE CLAIMING:
      NEVER claim something is missing, undefined, not imported, or does not exist without first using grep to verify.
      NEVER claim a method has the wrong signature without first reading its definition.
      NEVER claim a variable is unused or a branch is unreachable without tracing the actual code path.
      If you searched and did not find it, say "I searched for X and did not find it" — do not assert "X does not exist".
  </Workflow>

  <Scope>
    Root cause must be in lines added or modified by this PR.
    relevantFile/relevantLinesStart/relevantLinesEnd must point to the changed lines.
    Trace impact through callers — symptom can appear elsewhere, but the cause must be in the diff.
  </Scope>

${overridesSection}

${memoryRulesSection}

</CodeReviewAgent>`;
    }

    protected buildUserPrompt(input: ReviewAgentInput): string {
        const isSelfContained = !input.remoteCommands;
        if (isSelfContained) {
            return this.buildSelfContainedUserPrompt(input);
        }

        const prContextSection = this.formatPRContext(
            input.prTitle,
            input.prBody,
        );
        const diffsSection = this.formatDiffs(input.changedFiles);
        const callGraphSection = input.callGraph
            ? `\n  <CallGraph>\n${input.callGraph}\n  </CallGraph>`
            : '';
        const coverageTargets = formatCoverageTargetsForPrompt(
            input.changedFiles,
        );

        const categoryLabel = this.getCategoryLabel();
        const mixedLabelMode = this.supportsMixedLabels();
        const allowedSuggestionLabels = this.getAllowedSuggestionLabels(input);
        const mixedLabelRules = mixedLabelMode
            ? `- Every finding must include a "label" and it must be one of: ${allowedSuggestionLabels.join(', ')}.
    - Use bug for correctness/regression issues, security for exploit or authorization issues, and performance for material slowdowns or resource blowups.
    - If the same root cause could fit multiple categories, choose the strongest primary label once — do not duplicate the same finding under multiple labels.`
            : '';
        const mixedLabelTaskGuidance = mixedLabelMode
            ? `
    Before finalizing, run an explicit pass for each enabled category: ${allowedSuggestionLabels.join(', ')}.
    Do not stop after finding only bug issues — you must still check whether the changed code introduces concrete security or performance problems when those categories are enabled.
    In your reasoning, explicitly note at least one concrete hypothesis you tested for each enabled category, even if that category produced no finding.`
            : '';
        const mixedLabelLensRules = mixedLabelMode
            ? `
    - For every enabled category (${allowedSuggestionLabels.join(', ')}), either report a concrete finding or explain in the reasoning why no concrete issue exists.
    - Do not suppress a concrete performance issue just because it is not a correctness bug. If the primary failure mode is scale, query count, cache blowup, unbounded loading, async fanout, or blocking I/O, label it as performance.
    - Do not suppress a concrete security issue just because the code also has a bug. If the primary failure mode is exploitability, authorization bypass, trust-boundary failure, or unsafe input reaching a sink, label it as security.`
            : '';
        const outputLabelLine = mixedLabelMode
            ? `"label": "${allowedSuggestionLabels.join('|')}",
      `
            : '';

        const taskDescriptions: Record<string, string> = {
            bug: 'real bugs introduced, exposed, or made worse by these changes',
            performance:
                'real performance regressions introduced or worsened by these changes',
            security:
                'real security vulnerabilities introduced, exposed, or made worse by these changes',
            generalist:
                'real bugs, security vulnerabilities, and material performance regressions introduced, exposed, or made worse by these changes',
        };
        const taskDescription =
            categoryLabel === 'generalist'
                ? `real ${allowedSuggestionLabels.join(', ')} issues introduced, exposed, or made worse by these changes`
                : (taskDescriptions[categoryLabel] ??
                  'issues introduced by these changes');

        return (
            `<ReviewTask>
  ${prContextSection}

  <Diffs>
${diffsSection}
  </Diffs>
${callGraphSection}

  <Task>
    Review this Pull Request for ${taskDescription}.
    For each changed function: grep callers → read context → challenge with adversarial questions.${input.callGraph ? '\n    Use the call graph above as a fast map of production callers/callees, but still verify with tools before reporting.' : ''}
    Promote a finding only when you can point to a concrete failure path, broken contract, wrong branch behavior, unsafe state transition, or caller/callee incompatibility introduced by the diff.
    Prefer concrete findings over speculative theories. Dismiss only what you can explain WHY it cannot fail.
${mixedLabelTaskGuidance}
  </Task>

  <CoverageContract>
    You must inspect every changed file below with readFile or checkTypes before finalizing.
    grep, findFile, and listDir help navigation, but they do not count as coverage.
${coverageTargets ? `${coverageTargets}\n` : ''}
  </CoverageContract>

  <Rules>
    - Root cause must be in lines added or modified by this PR.
    - Pre-existing issues: report only if this PR makes them worse or newly reachable.
    - "Looks correct" is not a valid reason to dismiss — explain the specific reason it is safe.
    - Before finalizing, make sure you have inspected every changed file listed above.
    - Before reporting, be able to answer at least one of these: which changed line creates the risk, what concrete failing path follows, which caller/callee assumption is broken, or what observable bad behavior would happen.
    - Do not promote a finding from a mere possibility. Plausible is not enough. The changed code plus the code you inspected must show a concrete failure path and a concrete wrong outcome.
    - Do not report generic resource exhaustion, shell injection, bypass, or performance theories unless the modified code directly creates or worsens that path.
    - Clear local defects in the diff should still be reported immediately. Cross-file claims require at least one confirming reference from a caller, callee, test, or nearby state transition.
    - Before every readFile call, identify the exact unanswered question that this read will answer.
    - Do not reread the same or highly overlapping range just to gain confidence. Confidence-seeking rereads are a mistake.
    - Treat redundant readFile calls as a mistake. Only reread overlapping lines if a newly discovered symbol, caller/callee, or branch creates a new concrete question that the previous read did not answer.
    - Do NOT report generic efficiency concerns (O(N), N+1, redundant calls, missing pagination, missing timeouts) as bugs. Report them only when the changed code creates a concrete, material slowdown or resource blowup, and then label them as performance.
    - Do NOT report missing defensive measures (missing CSRF, missing rate limiting, missing input validation) unless you can demonstrate a specific exploit path in the changed code.
    - Every finding must pass this test: "Can I name the exact input or state that triggers the failure, and the exact wrong behavior, wrong output, or crash that results?" If not, do not report it.
    - Before reporting, ask what would make the behavior intentional or safe. If the code you inspected does not let you reject that safe explanation, do not report the finding.
    - Concrete findings include build-time and contract failures too. If the diff introduces a signature mismatch, wrong delegate call, impossible method call, or dropped required side effect, you may report it even without a runtime trace.
    - For wrappers, middleware, providers, caches, and adapters, verify both behavior and wiring: the changed code may be wrong because it calls the wrong target, preserves the wrong cached semantics, or silently stops propagating tracing/logging/metrics/auth state.
    - For security flows, challenge any value that became static, shared, or reused across requests/users when it should be per-request, per-session, or per-principal.
    ${mixedLabelRules}
    ${mixedLabelLensRules}
    - Assign a confidence score (1-10) to each finding. Be honest — overconfidence wastes verification budget:
      9-10: You read BOTH the callsite AND the callee definition, confirmed the types/signatures mismatch or the wrong return value, and can name the exact failing input. Reserve 10 for bugs where you verified the fix would work.
      7-8: You read the relevant code and traced the failure path, but did not verify the callee definition or could not confirm the exact input that triggers it.
      5-6: The code pattern looks wrong based on the diff, but you only read one side (caller OR callee, not both). The bug is plausible but not fully confirmed.
      1-4: Suspicious pattern, speculative concern, or you are reporting based on experience rather than evidence from this codebase.
    - Return only the JSON object inside markdown fences, no extra text.
  </Rules>

  <OutputFormat>
` +
            '```' +
            `json
{
  "reasoning": "For each changed function: what you challenged, what callers you found, why you reported or dismissed. Example: 'Challenged CreateDevice: what if two requests pass count check simultaneously? Grepped TagDevice(, found caller at impl.go:155. No lock or unique constraint — race condition. Reported.'",
  "suggestions": [
    {
      ${outputLabelLine}"relevantFile": "path/to/file.ext",
      "language": "the file language",
      "suggestionContent": "WHAT: one sentence naming the exact problem. WHY: one sentence on the real impact. HOW: concrete fix if clear from the code — omit if speculative.",
      "existingCode": "problematic code snippet from the diff",
      "improvedCode": "fixed code snippet (only if fix is clear from context)",
      "oneSentenceSummary": "Brief summary",
      "relevantLinesStart": 10,
      "relevantLinesEnd": 15,
      "severity": "critical|high|medium|low",
      "confidence": 8
    }
  ]
}
` +
            '```' +
            `
  </OutputFormat>
</ReviewTask>`
        );
    }

    /**
     * Builds a self-contained system prompt for trial / no-sandbox flows.
     *
     * The tool-heavy workflow (grep callers, readFile bodies, checkTypes)
     * from the normal system prompt does not apply — the agent has no
     * tools. This variant keeps the role/mindset/category guidance but
     * replaces the workflow with a single-pass analysis instruction set.
     */
    private buildSelfContainedSystemPrompt(input: ReviewAgentInput): string {
        const identity = this.getIdentity();
        const categoryPrompt = this.getCategoryPrompt();
        const overridesSection = this.formatOverrides(input);
        const memoryRulesSection = this.formatMemoryRules(input.memoryRules);

        const langLabel = resolveLanguageLabel(input.languageResultPrompt);
        const langSection = langLabel
            ? `\n  <Language>Write ALL review comments, summaries, and reasoning in ${langLabel}. This is mandatory — do not fall back to English.</Language>`
            : '';

        return `<CodeReviewAgent mode="self-contained">
  <Date>${new Date().toLocaleDateString('en-GB')}</Date>
  <Role>
    You are ${identity.name}, ${identity.description}
    ${categoryPrompt}${langSection}
  </Role>

  <Mindset>
    You are running without tools and without access to the repository.
    You see only the diffs and any inlined file contents.
    Report findings only when the evidence is fully visible in what you see.
    "Might be" is not enough — if you cannot point to specific visible lines as proof, do NOT report it.
    Low-hallucination mode: err on the side of silence when the defect depends on code you cannot see.
  </Mindset>

  <Workflow>
    PHASE 1 — READ
      Read every diff. For each changed function, understand what it does differently now.
      If full file contents are inlined below, also read those to understand the surrounding context of each change.

    PHASE 2 — CHALLENGE (strictly within the visible code)
      For each changed function, ask:
        - "Is there a null/undefined dereference on a path the diff introduces?"
        - "Is an off-by-one, inverted condition, missing break, or wrong operator visible?"
        - "Is a secret, credential, or token hardcoded in the diff?"
        - "Is there an obvious injection sink (SQL concat, shell interpolation, unsafe HTML) in the diff?"
        - "Is a resource opened but not closed on an error path visible in the diff?"
        - "Is a value used that is assigned later, or never assigned at all, in the shown code?"
      Do NOT ask questions you cannot answer from the visible code.

    PHASE 3 — RESPOND
      Return a JSON object with your findings. Every finding must cite exact line numbers from the diff.
      Assign confidence honestly: 7+ only when the defect is obvious from the shown lines, 3-5 when you suspect it but cannot fully prove it, below 3 for speculation (do NOT report below 5).

    FORBIDDEN:
      - Claiming a caller passes wrong data (you cannot see callers).
      - Claiming a dependency has a signature mismatch (you cannot read the dependency).
      - Reporting missing rate-limiting, CSRF, or defense-in-depth without a concrete exploit visible in the diff.
      - Any finding whose proof would require reading a file that is not inlined below.
  </Workflow>

  <Scope>
    Root cause must be in lines added or modified by this change.
    relevantFile/relevantLinesStart/relevantLinesEnd must point to the changed lines.
  </Scope>

${overridesSection}

${memoryRulesSection}

</CodeReviewAgent>`;
    }

    /**
     * Builds a self-contained user prompt for trial / no-sandbox flows.
     *
     * The agent has no tools and cannot explore the repo, so the prompt:
     *   - Inlines file content when the CLI shipped it (fileContent field)
     *   - Removes all tool instructions (no readFile/grep/checkTypes refs)
     *   - Drops the CoverageContract (nothing to cover against)
     *   - Explicitly forbids speculation about callers or cross-file behavior
     *   - Focuses on self-evident defects in the diff
     */
    protected buildSelfContainedUserPrompt(input: ReviewAgentInput): string {
        const prContextSection = this.formatPRContext(
            input.prTitle,
            input.prBody,
        );
        const diffsSection = this.formatDiffs(input.changedFiles);
        const fileContentsSection = this.formatInlineFileContents(
            input.changedFiles,
        );

        const categoryLabel = this.getCategoryLabel();
        const mixedLabelMode = this.supportsMixedLabels();
        const allowedSuggestionLabels = this.getAllowedSuggestionLabels(input);
        const outputLabelLine = mixedLabelMode
            ? `"label": "${allowedSuggestionLabels.join('|')}",
      `
            : '';

        const taskDescriptions: Record<string, string> = {
            bug: 'real bugs introduced, exposed, or made worse by these changes',
            performance:
                'real performance regressions introduced or worsened by these changes',
            security:
                'real security vulnerabilities introduced, exposed, or made worse by these changes',
            generalist:
                'real bugs, security vulnerabilities, and material performance regressions introduced, exposed, or made worse by these changes',
        };
        const taskDescription =
            categoryLabel === 'generalist'
                ? `real ${allowedSuggestionLabels.join(', ')} issues self-evident from these diffs`
                : (taskDescriptions[categoryLabel] ??
                  'issues introduced by these changes');

        return (
            `<ReviewTask mode="self-contained">
  ${prContextSection}

  <Diffs>
${diffsSection}
  </Diffs>
${fileContentsSection}

  <Task>
    You are running in self-contained mode. You have NO tools and NO access to the repository beyond the diffs and any inlined file contents shown above.

    Review these changes for ${taskDescription} that are self-evident from the diff alone.

    Report only findings you can fully justify from what you can see. Do NOT speculate about callers, cross-file behavior, or code you do not have.
  </Task>

  <Rules>
    - Root cause must be visible in the diff or in the inlined file contents.
    - Do NOT claim "function X might be called from somewhere that passes null" — you cannot verify that.
    - Do NOT claim "this might break an existing caller" — you cannot see callers.
    - DO report: null/undefined dereferences with no guard in the changed code, off-by-one errors, inverted conditions, missing await, hardcoded secrets, obvious injection paths, resource leaks in the changed function, missing error handling around risky operations, typos in identifiers that are local to the shown code.
    - DO NOT report: generic performance theories, missing CSRF/rate-limiting, speculative race conditions without a visible shared-state violation, suggestions that require knowing how the code is used elsewhere.
    - Every finding must pass this test: "Can I point to the exact lines in the diff and explain the failure path using only what is visible here?"
    - If in doubt, do NOT report it.
    - Assign a confidence score (1-10). In self-contained mode, confidence above 7 is rare — reserve it for defects that are obvious from the shown lines alone.
    - Return only the JSON object inside markdown fences, no extra text.
  </Rules>

  <OutputFormat>
` +
            '```' +
            `json
{
  "reasoning": "What you checked and why. Example: 'Looked at auth.ts line 42: new code dereferences user.email without checking if user is null. Parameter comes from an unchecked path in the same function. Reported.'",
  "suggestions": [
    {
      ${outputLabelLine}"relevantFile": "path/to/file.ext",
      "language": "the file language",
      "suggestionContent": "WHAT: one sentence naming the exact problem. WHY: one sentence on the real impact visible from the diff. HOW: concrete fix if clear.",
      "existingCode": "problematic code snippet from the diff",
      "improvedCode": "fixed code snippet",
      "oneSentenceSummary": "Brief summary",
      "relevantLinesStart": 10,
      "relevantLinesEnd": 15,
      "severity": "critical|high|medium|low",
      "confidence": 6
    }
  ]
}
` +
            '```' +
            `
  </OutputFormat>
</ReviewTask>`
        );
    }

    /**
     * Inlines full file contents for any FileChange that carries a
     * `fileContent` field. Used only in self-contained mode: the CLI
     * client ships the user's local file state so the agent has at least
     * the full modified files to reason over, even without a sandbox.
     */
    private formatInlineFileContents(files: FileChange[]): string {
        if (!files?.length) return '';

        const withContent = files.filter(
            (f) => typeof f.fileContent === 'string' && f.fileContent.length > 0,
        );
        if (withContent.length === 0) return '';

        const blocks = withContent
            .map((f) => {
                const lang = (f as any).language || '';
                return `### ${f.filename}\n\`\`\`${lang}\n${f.fileContent}\n\`\`\``;
            })
            .join('\n\n');

        return `\n\n  <FileContents>\n${blocks}\n  </FileContents>`;
    }

    private formatPRContext(prTitle?: string, prBody?: string): string {
        if (!prTitle && !prBody) return '';

        const parts: string[] = [];
        if (prTitle) parts.push(`Title: ${prTitle}`);
        if (prBody) parts.push(prBody.substring(0, 500));

        return `\n  <PRContext>${parts.join('\n')}</PRContext>`;
    }

    private formatDiffs(files: FileChange[]): string {
        if (!files?.length) return 'No changed files provided.';

        return files
            .map((file) => {
                const diff = file.patchWithLinesStr ?? file.patch ?? '';
                return `### ${file.filename}\n\`\`\`diff\n${diff}\n\`\`\``;
            })
            .join('\n\n');
    }

    private formatMemoryRules(rules?: Partial<IKodyRule>[]): string {
        if (!rules?.length) return '';

        const formatted = rules
            .map((r) => `- **${r.title}**: ${r.rule}`)
            .join('\n');

        return `## Memory Rules (Team Conventions)\n${formatted}`;
    }

    private formatOverrides(input: ReviewAgentInput): string {
        const parts: string[] = [];

        const descriptions = input.v2PromptOverrides?.categories?.descriptions;
        if (descriptions) {
            if (this.supportsMixedLabels()) {
                const labels = this.getAllowedSuggestionLabels(input);

                const mixedCategorySections = labels
                    .map((label) => {
                        const value = resolvePromptOverrideText(
                            descriptions[label],
                        );
                        if (!value) return null;

                        const header =
                            label.charAt(0).toUpperCase() + label.slice(1);
                        return `### ${header}\n${value}`;
                    })
                    .filter((section): section is string => Boolean(section));

                if (mixedCategorySections.length > 0) {
                    parts.push(
                        `## Category Guidelines\n${mixedCategorySections.join('\n\n')}`,
                    );
                }
            } else {
                const categoryLabel = this.getCategoryLabel();
                const categoryDesc = resolvePromptOverrideText(
                    descriptions[categoryLabel as keyof typeof descriptions],
                );
                if (categoryDesc) {
                    parts.push(`## Category Guidelines\n${categoryDesc}`);
                }
            }
        }

        // Severity classification is handled by a separate post-processing step (classify-severity.ts)
        // to avoid biasing the agent's investigation. The agent assigns a rough severity but
        // the final classification uses dedicated criteria (default or client-custom).

        const generationMain = resolvePromptOverrideText(
            input.generationMain ?? input.v2PromptOverrides?.generation?.main,
        );
        if (generationMain) {
            parts.push(`## Writing Guidelines\n${generationMain}`);
        }

        return parts.join('\n\n');
    }

    private resolveSuggestionLabel(
        suggestion: Partial<CodeSuggestion> & { label?: string },
        input: ReviewAgentInput,
    ): string {
        if (!this.supportsMixedLabels()) {
            return this.getCategoryLabel();
        }

        const allowedLabels = new Set(this.getAllowedSuggestionLabels(input));
        const rawLabel =
            typeof suggestion.label === 'string'
                ? suggestion.label.toLowerCase()
                : '';

        if (
            (rawLabel === 'bug' ||
                rawLabel === 'security' ||
                rawLabel === 'performance') &&
            allowedLabels.has(rawLabel as 'bug' | 'security' | 'performance')
        ) {
            return rawLabel;
        }

        return this.getAllowedSuggestionLabels(input)[0] || 'bug';
    }
}

const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });

function resolveLanguageLabel(localeOrLabel?: string): string | null {
    if (!localeOrLabel || typeof localeOrLabel !== 'string') return null;
    try {
        return displayNames.of(localeOrLabel) || localeOrLabel;
    } catch {
        return localeOrLabel;
    }
}
