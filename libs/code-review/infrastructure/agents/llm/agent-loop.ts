import { buildAgentTools } from './agent-tools.factory';
/**
 * Simple agent loop using Vercel AI SDK with native function calling.
 *
 * 1. `generateText` with tools — model investigates using BYOK model
 * 2. Parse JSON from response text — zero cost if model cooperates
 * 3. If JSON parse fails — `generateText` with `Output.object` (cheap model) to structure the text
 */
import * as aiSdk from 'ai';
import { stepCountIs, Output, jsonSchema, type LanguageModel } from 'ai';

// Wrap AI SDK with LangSmith tracing when LANGCHAIN_TRACING_V2=true
let generateText = aiSdk.generateText;
if (process.env.LANGCHAIN_TRACING_V2 === 'true') {
    try {
        const { wrapAISDK } = require('langsmith/experimental/vercel');
        const wrapped = wrapAISDK(aiSdk);
        generateText = wrapped.generateText;
    } catch {
        // LangSmith wrapping not available — use original
    }
}

// Wrap generateText with a hard timeout safety net.
// Some BYOK providers (Synthetic, Z.AI) ignore AbortSignal and hang forever.
// This ensures every LLM call has a maximum wall-clock time.
const _rawGenerateText = generateText;
generateText = (async (...args: Parameters<typeof _rawGenerateText>) => {
    // Extract timeout from the abortSignal if present, otherwise use AGENT_TIMEOUT_MS
    const opts = args[0] as any;
    const ms =
        opts?.__kodusHardTimeoutMs ??
        (opts?.abortSignal
            ? LLM_CALL_TIMEOUT_MS // secondary calls already set timeoutSignal
            : AGENT_TIMEOUT_MS); // main call uses agent-level timeout
    const label = opts?.experimental_telemetry?.functionId || 'generateText';
    return hardTimeout(_rawGenerateText(...args), ms, label);
}) as typeof generateText;

/** Re-export the LangSmith-wrapped (+ hard-timeout) generateText for use outside the agent loop. */
export { generateText as tracedGenerateText };

/**
 * Wraps a generateText call through the BYOK concurrency limiter.
 * When maxConcurrentRequests is configured (e.g. 1 for Z.AI/Synthetic),
 * all LLM calls across all pipelines in this process are serialized.
 */
function throttledGenerateText<T>(params: {
    byokConfig?: BYOKConfig;
    organizationId?: string;
    role?: BYOKLimiterRole;
    label?: string;
    abortSignal?: AbortSignal;
    fn: () => Promise<T>;
}): Promise<T> {
    return runWithBYOKLimiter(
        {
            byokConfig: params.byokConfig,
            organizationId: params.organizationId,
            role: params.role ?? 'main',
            abortSignal: params.abortSignal,
        },
        params.fn,
        params.label ?? 'generateText',
    );
}

/**
 * Standard metadata sent to LangSmith for every LLM call in the code review pipeline.
 * Centralised here so adding a new field only requires changing one place.
 */
export interface LangSmithTelemetryMetadata {
    organizationId?: string;
    teamId?: string;
    pullRequestId?: number;
    repositoryId?: string;
    provider?: string;
}

/**
 * Build the `providerOptions.langsmith` object for a generateText call.
 * Fields in `metadata` appear in the **Metadata tab** of LangSmith.
 * `name` sets the run name.
 */
export function buildLangSmithProviderOptions(
    runName: string,
    meta?: LangSmithTelemetryMetadata,
) {
    return {
        langsmith: {
            name: runName,
            metadata: meta
                ? {
                      organizationId: meta.organizationId,
                      teamId: meta.teamId,
                      pullRequestId: meta.pullRequestId,
                      repositoryId: meta.repositoryId,
                      provider: meta.provider,
                  }
                : undefined,
        },
    };
}
import { z } from 'zod';
import { createLogger } from '@kodus/flow';
import { EnhancedJSONParser } from '@kodus/flow';
import { BYOKConfig } from '@kodus/kodus-common/llm';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    getInternalModel,
    runWithBYOKLimiter,
    type BYOKLimiterRole,
} from './byok-to-vercel';
import { RemoteCommands } from '../../adapters/services/collectCrossFileContexts.service';
import {
    buildCoverageLedger,
    CoverageSummary,
    formatCoverageDebt,
    getCoverageSummary,
    markCoverageFromToolCall,
} from './coverage-ledger';

const logger = createLogger('AgentLoop');

const MAX_STEPS_NORMAL = 15;
const MAX_STEPS_DEEP = 100;
const AGENT_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes max per agent
const LLM_CALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max per individual LLM call

/** Create an AbortSignal that fires after the given ms. */
function timeoutSignal(ms: number): AbortSignal {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
}

/**
 * Hard timeout wrapper — kills the promise even if the provider ignores AbortSignal.
 * Uses Promise.race so that a stuck HTTP connection can never block the pipeline forever.
 *
 * Every generateText call already passes timeoutSignal(ms) as AbortSignal,
 * but some providers (OpenAI-compatible proxies like Synthetic, Z.AI) ignore it.
 * This is the safety net.
 */
function hardTimeout<T>(
    promise: Promise<T>,
    ms: number,
    label: string,
): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
            timer = setTimeout(
                () =>
                    reject(
                        new Error(
                            `[HARD-TIMEOUT] ${label} exceeded ${ms / 1000}s`,
                        ),
                    ),
                ms + 5_000, // +5s grace so AbortSignal fires first when it works
            );
        }),
    ]).finally(() => clearTimeout(timer));
}

/** Schema for structured output */
const suggestionSchema = z.object({
    relevantFile: z.string(),
    language: z.string().optional(),
    label: z.enum(['bug', 'security', 'performance']).optional(),
    suggestionContent: z.string(),
    existingCode: z.string(),
    improvedCode: z.string(),
    oneSentenceSummary: z.string().optional(),
    relevantLinesStart: z.number().optional(),
    relevantLinesEnd: z.number().optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low']).optional(), // V2 compat
    confidence: z.number().min(1).max(10).optional(), // 1-10: how confident the agent is in this finding
    ruleUuid: z.string().optional(), // Kody Rules: UUID of the violated rule
});

const _findingsSchema = z.object({
    reasoning: z.string(),
    suggestions: z.array(suggestionSchema),
});

export type FindingsOutput = z.infer<typeof _findingsSchema>;

export interface AgentLoopInput {
    model: LanguageModel;
    systemPrompt: string;
    userPrompt: string;
    agentName?: string; // e.g. 'kodus-bug-review-agent' — used for LangSmith trace identification
    telemetryMetadata?: LangSmithTelemetryMetadata;
    maxSteps?: number;
    onStepFinish?: (event: any) => void;
    changedFiles?: any[];
    prNumber?: number;
    repositoryFullName?: string;
    /** Base branch of the PR (e.g. "main"). Used by git diff tools. */
    baseBranch?: string;
    /** Pre-computed call graph shared by reviewers and verifier. */
    callGraph?: string;
    /** Review mode: 'normal' skips verify only for very-high-confidence findings, 'deep' verifies everything. */
    reviewMode?: 'normal' | 'deep';
    /** Minimum severity level to keep. Findings below this threshold are discarded before verify. */
    severityLevelFilter?: string;
}

/**
 * Secrets and service references that must NEVER be serialized into
 * LangSmith traces or LLM payloads. Extracted from the old AgentLoopInput
 * to prevent accidental leaks (NestJS ConfigService carries all env vars).
 */
export interface AgentLoopSecrets {
    remoteCommands: RemoteCommands;
    byokConfig?: BYOKConfig;
    gitHubToken?: string;
}

export interface AgentLoopOutput {
    findings: FindingsOutput;
    text: string;
    steps: number;
    toolCalls: Array<{
        tool: string;
        toolName?: string;
        args: Record<string, unknown>;
        result?: string;
    }>;
    finishReason: string;
    /** Whether findings came from direct JSON parse or fallback generateObject */
    source: 'json-parse' | 'generate-object' | 'empty';
    usage: {
        inputTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        totalTokens: number;
    };
    /** Suggestions discarded by severity filter (before verify). */
    discardedBySeverity?: FindingsOutput['suggestions'];
    /** Suggestions discarded by the verifier. */
    droppedByVerify?: FindingsOutput['suggestions'];
    /** Token usage for the verification sub-step only (included in total usage). */
    verificationUsage?: {
        inputTokens: number;
        outputTokens: number;
        reasoningTokens: number;
    };
    coverage: CoverageSummary;
    verification?: VerificationTraceSummary | null;
    anomalies: AgentAnomalySummary;
}

interface SuggestionVerificationDecision {
    index: number;
    keep: boolean;
    rationale: string;
    confidence?: 'high' | 'medium' | 'low';
}

interface ToolEvidenceSummary {
    strongFiles: string[];
    weakFiles: string[];
}

interface VerificationDecisionTrace {
    index: number;
    relevantFile: string;
    action: 'keep' | 'drop' | 'refine';
    parseMode: 'direct' | 'fallback-llm' | 'default-keep';
    rationale: string;
    confidence?: 'high' | 'medium' | 'low';
    verifierEvidence: ToolEvidenceSummary;
    rawTextPreview?: string;
}

interface SuggestionEvidenceBundle {
    bundle: string;
    relevantInvestigationLog: string;
    relevantInvestigationCount: number;
    callGraphHint: string;
}

export interface VerificationTraceSummary {
    beforeCount: number;
    afterCount: number;
    droppedByVerifier: number;
    droppedByEvidenceFilter: number;
    decisions: VerificationDecisionTrace[];
}

export interface AgentAnomalySummary {
    stepsLe2: boolean;
    zeroToolCalls: boolean;
    zeroStrongEvidenceFiles: boolean;
    zeroCoverage: boolean;
    lowCoverage: boolean;
    lowStrongEvidenceFiles: boolean;
}

/**
 * Run the agent loop with native function calling.
 *
 * `secrets` is kept separate from `input` so that LangSmith tracing
 * (which serializes `input`) never captures API keys, tokens, or
 * NestJS service instances that carry ConfigService with all env vars.
 */
export async function runAgentLoop(
    input: AgentLoopInput,
    secrets: AgentLoopSecrets,
): Promise<AgentLoopOutput> {
    const tools = buildAgentTools(secrets.remoteCommands, secrets.gitHubToken);
    const coverageTargets = buildCoverageLedger(input.changedFiles);

    const allToolCalls: AgentLoopOutput['toolCalls'] = [];
    let stepCount = 0;
    let lastStepText = ''; // Capture text from intermediate steps for timeout recovery
    const allStepTexts: string[] = []; // Accumulate ALL text steps for better timeout recovery
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalReasoningTokens = 0;
    let verificationTrace: VerificationTraceSummary | null = null;

    // Timeout: 8 minutes max per agent — some models need many tool calls
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
        logger.warn({
            message: `[AGENT-TIMEOUT] Agent exceeded ${AGENT_TIMEOUT_MS / 1000}s timeout, aborting`,
            context: 'AgentLoop',
        });
        abortController.abort();
    }, AGENT_TIMEOUT_MS);

    let result;
    try {
        result = await throttledGenerateText({
            byokConfig: secrets.byokConfig,
            organizationId: input.telemetryMetadata?.organizationId,
            role: 'main',
            label: input.agentName ?? 'agent-loop',
            abortSignal: abortController.signal,
            fn: () =>
                generateText({
                    ...({ __kodusHardTimeoutMs: AGENT_TIMEOUT_MS } as any),
                    model: input.model,
                    abortSignal: abortController.signal,
                    system: input.systemPrompt,
                    prompt: input.userPrompt,
                    experimental_telemetry: {
                        isEnabled: true,
                        functionId: input.agentName ?? 'agent-loop',
                    },
                    providerOptions: buildLangSmithProviderOptions(
                        input.agentName ?? 'agent-loop',
                        input.telemetryMetadata,
                    ),
                    tools,
                    stopWhen: stepCountIs(
                        input.maxSteps ||
                            (input.reviewMode === 'deep'
                                ? MAX_STEPS_DEEP
                                : MAX_STEPS_NORMAL),
                    ),
                    // Last 2 steps: remove tools entirely to force text response.
                    // toolChoice: 'none' doesn't work with all providers (e.g., Gemini ignores it).
                    // Removing tools entirely guarantees the model can only respond with text.
                    prepareStep: ({ stepNumber }: any) => {
                        const maxSteps =
                            input.maxSteps ||
                            (input.reviewMode === 'deep'
                                ? MAX_STEPS_DEEP
                                : MAX_STEPS_NORMAL);
                        const forceTextAfter = maxSteps - 2;
                        const coverageDebt =
                            formatCoverageDebt(coverageTargets);

                        if (coverageDebt) {
                            if (stepNumber >= forceTextAfter) {
                                logger.log({
                                    message: `[AGENT-COVERAGE-DEBT] step=${stepNumber}/${maxSteps} pending=${getCoverageSummary(coverageTargets).pendingTargets} — prioritizing uncovered changed files`,
                                    context: 'AgentLoop',
                                });
                            }

                            return {
                                system:
                                    input.systemPrompt +
                                    '\n\nIMPORTANT: Coverage debt is still open.\n' +
                                    coverageDebt +
                                    '\nPrioritize the uncovered changed files before exploring anything else.',
                            };
                        }

                        if (stepNumber >= forceTextAfter) {
                            logger.log({
                                message: `[AGENT-FORCE-TEXT] step=${stepNumber}/${maxSteps} — removing tools, forcing JSON response`,
                                context: 'AgentLoop',
                            });
                            return {
                                toolChoice: 'none' as const,
                                activeTools: [],
                                system:
                                    input.systemPrompt +
                                    '\n\nIMPORTANT: You have reached the final response step. ' +
                                    'Do NOT call any more tools. ' +
                                    'Respond ONLY with a JSON object inside a markdown code block:\n' +
                                    '```json\n' +
                                    '{\n' +
                                    '  "reasoning": "what you investigated and found",\n' +
                                    '  "suggestions": []\n' +
                                    '}\n' +
                                    '```\n' +
                                    'If you found no issues, return an empty suggestions array. No prose, no explanation outside the JSON.',
                            };
                        }

                        // Note: toolChoice: 'required' was removed because some providers
                        // (e.g. Moonshot) reject it with "incompatible with thinking enabled".
                        // The prompt already instructs "Your first action must be a tool call".

                        return {};
                    },
                    onStepFinish: (event: any) => {
                        stepCount++;

                        if (event.toolCalls) {
                            // Build a lookup of tool results — different providers use different structures
                            const resultLookup = new Map<string, string>();
                            const toolResults: any[] = event.toolResults || [];

                            for (const tr of toolResults) {
                                const id = tr?.toolCallId || tr?.id || '';
                                const val =
                                    tr?.result ??
                                    tr?.output ??
                                    tr?.content ??
                                    '';
                                if (id) resultLookup.set(id, String(val));
                            }

                            for (const tc of event.toolCalls) {
                                const args =
                                    (tc as any).args || (tc as any).input || {};

                                // Try multiple ID fields to match tool call → result
                                const callId =
                                    tc.toolCallId || (tc as any).id || '';
                                let resultStr = resultLookup.get(callId) || '';

                                // Fallback: if toolResults has same count as toolCalls, match by index
                                if (
                                    !resultStr &&
                                    toolResults.length ===
                                        event.toolCalls.length
                                ) {
                                    const idx = event.toolCalls.indexOf(tc);
                                    if (idx >= 0 && toolResults[idx]) {
                                        const tr = toolResults[idx];
                                        resultStr = String(
                                            tr?.result ??
                                                tr?.output ??
                                                tr?.content ??
                                                '',
                                        );
                                    }
                                }

                                allToolCalls.push({
                                    tool: tc.toolName,
                                    toolName: tc.toolName,
                                    args,
                                    result: resultStr.substring(0, 500),
                                });

                                const newlyTouched = markCoverageFromToolCall(
                                    coverageTargets,
                                    tc.toolName,
                                    args,
                                    stepCount,
                                );
                                if (newlyTouched.length > 0) {
                                    logger.log({
                                        message: `[AGENT-COVERAGE] step=${stepCount} touched ${newlyTouched.map((target) => target.file).join(', ')}`,
                                        context: 'AgentLoop',
                                        metadata: {
                                            step: stepCount,
                                            touchedFiles: newlyTouched.map(
                                                (target) => target.file,
                                            ),
                                            coverage:
                                                getCoverageSummary(
                                                    coverageTargets,
                                                ),
                                        },
                                    });
                                }

                                logger.log({
                                    message: `[AGENT-TOOL] step=${stepCount} ${tc.toolName}(${JSON.stringify(args).substring(0, 200)}) → ${resultStr ? resultStr.substring(0, 150) : '(empty)'}${resultStr.length > 150 ? '...' : ''}`,
                                    context: 'AgentLoop',
                                    metadata: {
                                        step: stepCount,
                                        tool: tc.toolName,
                                        args,
                                        resultLength: resultStr.length,
                                    },
                                });
                            }
                        }

                        if (event.text) {
                            lastStepText = event.text;
                            allStepTexts.push(event.text);
                            logger.log({
                                message: `[AGENT-TEXT] step=${stepCount} finishReason=${event.finishReason} textLength=${event.text.length} tokens=${event.usage?.totalTokens ?? 0}`,
                                context: 'AgentLoop',
                                metadata: {
                                    step: stepCount,
                                    finishReason: event.finishReason,
                                    textLength: event.text.length,
                                    textPreview: event.text.substring(0, 300),
                                    usage: event.usage,
                                },
                            });
                        }

                        // Track cumulative token usage for timeout recovery
                        if (event.usage) {
                            totalInputTokens += event.usage.inputTokens ?? 0;
                            totalOutputTokens += event.usage.outputTokens ?? 0;
                            totalReasoningTokens +=
                                event.usage.reasoningTokens ?? 0;
                        }

                        input.onStepFinish?.(event);
                    },
                }),
        });
    } catch (error) {
        clearTimeout(timeoutHandle);
        if (abortController.signal.aborted) {
            // Try to recover findings from the last text the model produced before timeout
            let findings: FindingsOutput | null = null;
            let source: AgentLoopOutput['source'] = 'empty';

            // Try to recover from ALL accumulated text steps (not just the last one)
            // Models often produce partial findings in intermediate steps before timeout
            const textsToTry = [
                lastStepText,
                ...allStepTexts.slice().reverse(), // Try most recent first
                allStepTexts.join('\n\n'), // Try concatenated as last resort
            ].filter((t) => t && t.length > 50);

            // Deduplicate
            const uniqueTexts = [...new Set(textsToTry)];

            for (const text of uniqueTexts) {
                if (findings && findings.suggestions.length > 0) break;

                // Strategy 1: Try to parse JSON directly (safe — no hallucination risk)
                findings = tryParseFindings(text);
                if (findings && findings.suggestions.length > 0) {
                    source = 'json-parse';
                    logger.log({
                        message: `[AGENT-TIMEOUT-RECOVERY] Recovered ${findings.suggestions.length} suggestions from step text (${text.length} chars)`,
                        context: 'AgentLoop',
                    });
                    break;
                }
            }

            // Strategy 2: If no JSON found, try fallback LLM with the richest text
            if (!findings) {
                const bestText = uniqueTexts.find(
                    (t) => t.length > 100 && looksLikeFindings(t),
                );
                if (bestText) {
                    try {
                        const fallbackResult = await structureWithFallbackModel(
                            bestText,
                            secrets.byokConfig,
                            input.telemetryMetadata?.organizationId,
                        );
                        if (
                            fallbackResult &&
                            fallbackResult.findings.suggestions.length > 0
                        ) {
                            findings = fallbackResult.findings;
                            totalInputTokens +=
                                fallbackResult.usage.inputTokens;
                            totalOutputTokens +=
                                fallbackResult.usage.outputTokens;
                            source = 'generate-object';
                            logger.log({
                                message: `[AGENT-TIMEOUT-RECOVERY] Recovered ${findings.suggestions.length} suggestions via fallback model (${bestText.length} chars)`,
                                context: 'AgentLoop',
                            });
                        }
                    } catch {
                        // Best effort
                    }
                }
            }

            logger.warn({
                message: `[AGENT-TIMEOUT] Agent timed out after ${AGENT_TIMEOUT_MS / 1000}s (${stepCount} steps, ${allToolCalls.length} tool calls, recovered=${findings?.suggestions?.length ?? 0})`,
                context: 'AgentLoop',
            });

            return {
                findings: findings || {
                    reasoning: 'Agent timed out',
                    suggestions: [],
                },
                text: lastStepText,
                steps: stepCount,
                toolCalls: allToolCalls,
                finishReason: 'timeout',
                source,
                usage: {
                    inputTokens: totalInputTokens,
                    outputTokens: totalOutputTokens,
                    reasoningTokens: totalReasoningTokens,
                    totalTokens: totalInputTokens + totalOutputTokens,
                },
                coverage: getCoverageSummary(coverageTargets),
                verification: null,
                anomalies: buildAgentAnomalies({
                    steps: stepCount,
                    toolCalls: allToolCalls,
                    coverage: getCoverageSummary(coverageTargets),
                }),
            };
        }
        throw error;
    }
    clearTimeout(timeoutHandle);

    // result.text may be empty if the model's last step was a tool call.
    // Fall back to accumulated step texts (e.g., from forced text steps 33/34).
    let finalText = result.text || '';
    if (!finalText && allStepTexts.length > 0) {
        finalText = allStepTexts[allStepTexts.length - 1]; // Use last text step
        logger.log({
            message: `[AGENT-FALLBACK-TEXT] result.text empty, using last step text (${finalText.length} chars)`,
            context: 'AgentLoop',
        });
    }

    // Second chance: when the model hit MAX_STEPS without producing text,
    // make a follow-up call WITHOUT tools using the full conversation history.
    // The model already investigated — it just needs a chance to respond.
    if (
        !finalText &&
        result.finishReason === 'tool-calls' &&
        allToolCalls.length > 0
    ) {
        logger.log({
            message: `[AGENT-SECOND-CHANCE] Agent hit MAX_STEPS with ${allToolCalls.length} tool calls but no text. Making follow-up call to extract findings.`,
            context: 'AgentLoop',
        });

        try {
            // Build a summary of what the agent investigated — include enough result context
            const investigationSummary = allToolCalls
                .map((tc) => {
                    const args =
                        typeof tc.args === 'string'
                            ? tc.args
                            : JSON.stringify(tc.args);
                    const resultStr =
                        typeof tc.result === 'string'
                            ? tc.result?.substring(0, 400)
                            : '';
                    return `${tc.toolName}(${args.substring(0, 150)}) → ${resultStr || '(empty)'}`;
                })
                .join('\n');
            const secondChanceSignal = timeoutSignal(LLM_CALL_TIMEOUT_MS);

            const secondChanceResult = await throttledGenerateText({
                byokConfig: secrets.byokConfig,
                organizationId: input.telemetryMetadata?.organizationId,
                role: 'main',
                label: `${input.agentName ?? 'agent-loop'}-second-chance`,
                abortSignal: secondChanceSignal,
                fn: () =>
                    generateText({
                        abortSignal: secondChanceSignal,
                        model: input.model,
                        system: input.systemPrompt,
                        prompt: `You have already investigated this code review task using ${allToolCalls.length} tool calls. Here is a summary of your investigation:

<InvestigationLog>
${investigationSummary.substring(0, 8000)}
</InvestigationLog>

Based on your investigation above, respond NOW with your findings as a JSON block. Do NOT call any tools.

IMPORTANT: Your investigation log shows what you looked at. Re-read it carefully.
- If you found ANY suspicious patterns, null risks, type mismatches, race conditions, or missing validations — report them.
- If a tool call returned evidence of a problem (error output, missing checks, wrong types) — report it even if you're not 100% certain.
- "I didn't find issues" is only valid if you can explain WHY each changed function is safe.

Respond with ONLY the JSON:

\`\`\`json
{
  "reasoning": "For each changed function: what you challenged, what evidence you found, why you reported or dismissed",
  "suggestions": [
    {
      "relevantFile": "path/to/file",
      "language": "java",
      "label": "bug|security|performance",
      "suggestionContent": "Description of the issue with evidence from your investigation",
      "existingCode": "problematic code",
      "improvedCode": "fixed code",
      "oneSentenceSummary": "Brief summary",
      "relevantLinesStart": 10,
      "relevantLinesEnd": 15,
      "severity": "critical|high|medium|low"
    }
  ]
}
\`\`\``,
                        stopWhen: stepCountIs(1), // No tools, just respond
                    }),
            });

            finalText = secondChanceResult.text || '';

            // Track additional token usage
            totalInputTokens +=
                (secondChanceResult as any).totalUsage?.inputTokens ??
                secondChanceResult.usage?.inputTokens ??
                0;
            totalOutputTokens +=
                (secondChanceResult as any).totalUsage?.outputTokens ??
                secondChanceResult.usage?.outputTokens ??
                0;

            if (finalText) {
                logger.log({
                    message: `[AGENT-SECOND-CHANCE] Got ${finalText.length} chars response, hasJSON=${finalText.includes('"suggestions"')}`,
                    context: 'AgentLoop',
                });
            }
        } catch (err) {
            logger.warn({
                message: `[AGENT-SECOND-CHANCE] Follow-up call failed: ${err instanceof Error ? err.message : String(err)}`,
                context: 'AgentLoop',
            });
        }
    }

    if (allToolCalls.length === 0) {
        logger.warn({
            message: `[AGENT-NO-TOOLS] Agent responded without any tool calls (${result.steps?.length ?? 0} steps). Investigation was skipped.`,
            context: 'AgentLoop',
        });
    }

    logger.log({
        message: `[AGENT-FINAL] steps=${result.steps?.length ?? 0} finishReason=${result.finishReason} textLength=${finalText.length} toolCalls=${allToolCalls.length} hasJSON=${finalText.includes('"suggestions"')}`,
        context: 'AgentLoop',
        metadata: {
            steps: result.steps?.length ?? 0,
            finishReason: result.finishReason,
            textLength: finalText.length,
            toolCallsTotal: allToolCalls.length,
            textPreview: finalText.substring(0, 500),
        },
    });

    // Step 1: Try to parse JSON directly from the response
    let findings = tryParseFindings(finalText);
    let source: AgentLoopOutput['source'] = 'json-parse';

    // Step 2: If no JSON, use internal model to structure the text
    if (!findings && finalText.length > 50) {
        logger.log({
            message: `[AGENT-FALLBACK] No JSON in response, using internal model to structure text (${finalText.length} chars)`,
            context: 'AgentLoop',
        });

        const fallbackResult = await structureWithFallbackModel(
            finalText,
            secrets.byokConfig,
            input.telemetryMetadata?.organizationId,
        );
        if (fallbackResult) {
            findings = fallbackResult.findings;
            totalInputTokens += fallbackResult.usage.inputTokens;
            totalOutputTokens += fallbackResult.usage.outputTokens;
            source = 'generate-object';
        } else {
            source = 'empty';
        }
    }

    if (!findings) {
        findings = {
            reasoning: finalText || 'No findings',
            suggestions: [],
        };
        source = 'empty';
    }

    const coverageSummaryBeforeRecovery = getCoverageSummary(coverageTargets);
    if (
        coverageSummaryBeforeRecovery.pendingTargets > 0 &&
        allToolCalls.length > 0
    ) {
        logger.warn({
            message: `[AGENT-COVERAGE-GAP] ${coverageSummaryBeforeRecovery.pendingTargets}/${coverageSummaryBeforeRecovery.totalTargets} changed files still uncovered after main pass`,
            context: 'AgentLoop',
            metadata: {
                coverage: coverageSummaryBeforeRecovery,
            },
        });

        const coverageRecovery = await runCoverageRecoveryPass({
            input,
            byokConfig: secrets.byokConfig,
            tools,
            coverageTargets,
            allToolCalls,
            totalInputTokens,
            totalOutputTokens,
            totalReasoningTokens,
        });

        totalInputTokens = coverageRecovery.totalInputTokens;
        totalOutputTokens = coverageRecovery.totalOutputTokens;
        totalReasoningTokens = coverageRecovery.totalReasoningTokens;

        if (coverageRecovery.text) {
            const extraFindings = tryParseFindings(coverageRecovery.text);
            if (extraFindings) {
                findings = mergeFindings(findings, extraFindings);
                if (source === 'empty') {
                    source = 'json-parse';
                }
            }
        }
    }
    let coverageSummary = getCoverageSummary(coverageTargets);

    if (shouldRunLowCoverageSecondChance(coverageSummary)) {
        logger.warn({
            message: `[AGENT-COVERAGE-SECOND-CHANCE] Coverage still low after recovery (${coverageSummary.touchedTargets}/${coverageSummary.totalTargets}). Running one more focused inspection pass.`,
            context: 'AgentLoop',
            metadata: {
                coverage: coverageSummary,
            },
        });

        const coverageSecondChance = await runLowCoverageSecondChance({
            input,
            byokConfig: secrets.byokConfig,
            tools,
            coverageTargets,
            allToolCalls,
            totalInputTokens,
            totalOutputTokens,
            totalReasoningTokens,
        });

        totalInputTokens = coverageSecondChance.totalInputTokens;
        totalOutputTokens = coverageSecondChance.totalOutputTokens;
        totalReasoningTokens = coverageSecondChance.totalReasoningTokens;

        if (coverageSecondChance.text) {
            let extraFindings = tryParseFindings(coverageSecondChance.text);

            if (!extraFindings && coverageSecondChance.text.length > 50) {
                const fallbackResult = await structureWithFallbackModel(
                    coverageSecondChance.text,
                    secrets.byokConfig,
                    input.telemetryMetadata?.organizationId,
                );
                if (fallbackResult) {
                    extraFindings = fallbackResult.findings;
                    totalInputTokens += fallbackResult.usage.inputTokens;
                    totalOutputTokens += fallbackResult.usage.outputTokens;
                    totalReasoningTokens +=
                        fallbackResult.usage.reasoningTokens;
                }
            }

            if (extraFindings) {
                findings = mergeFindings(findings, extraFindings);
                if (source === 'empty') {
                    source = 'json-parse';
                }
            }
        }

        coverageSummary = getCoverageSummary(coverageTargets);
    }

    const synthesisRescue = await runSynthesisRescuePass({
        input,
        byokConfig: secrets.byokConfig,
        findings,
        allToolCalls,
        totalInputTokens,
        totalOutputTokens,
        totalReasoningTokens,
    });

    totalInputTokens = synthesisRescue.totalInputTokens;
    totalOutputTokens = synthesisRescue.totalOutputTokens;
    totalReasoningTokens = synthesisRescue.totalReasoningTokens;

    if (synthesisRescue.findings) {
        findings = mergeFindings(findings, synthesisRescue.findings);
        if (source === 'empty' && synthesisRescue.findings.suggestions.length) {
            source = 'json-parse';
        }
    }

    // Filter by minimum severity level BEFORE verify (saves verify tokens)
    let discardedBySeverity: FindingsOutput['suggestions'] = [];
    const severityLevelFilter = input.severityLevelFilter;
    if (
        severityLevelFilter &&
        severityLevelFilter !== 'low' &&
        findings.suggestions.length > 0
    ) {
        const acceptedLevels: Record<string, string[]> = {
            critical: ['critical'],
            high: ['critical', 'high'],
            medium: ['critical', 'high', 'medium'],
            low: ['critical', 'high', 'medium', 'low'],
        };
        const accepted =
            acceptedLevels[severityLevelFilter] || acceptedLevels.low;
        const before = findings.suggestions.length;
        discardedBySeverity = findings.suggestions.filter(
            (s) => !accepted.includes((s.severity || 'medium').toLowerCase()),
        );
        findings = {
            ...findings,
            suggestions: findings.suggestions.filter((s) =>
                accepted.includes((s.severity || 'medium').toLowerCase()),
            ),
        };
        if (discardedBySeverity.length > 0) {
            logger.log({
                message: `[AGENT-SEVERITY-FILTER] Filtered ${discardedBySeverity.length}/${before} findings below ${severityLevelFilter} threshold`,
                context: 'AgentLoop',
            });
        }
    }

    let verificationUsage = {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
    };
    let droppedByVerify: FindingsOutput['suggestions'] = [];

    if (findings.suggestions.length > 0) {
        const verificationResult = await verifyFindingsWithTools({
            findings,
            input,
            secrets,
            allToolCalls,
            tools: pickVerificationTools(tools),
        });

        findings = verificationResult.findings;
        droppedByVerify = verificationResult.droppedByVerify || [];
        totalInputTokens += verificationResult.usage.inputTokens;
        totalOutputTokens += verificationResult.usage.outputTokens;
        totalReasoningTokens += verificationResult.usage.reasoningTokens;
        verificationTrace = verificationResult.trace;
        verificationUsage = {
            inputTokens: verificationResult.usage.inputTokens,
            outputTokens: verificationResult.usage.outputTokens,
            reasoningTokens: verificationResult.usage.reasoningTokens,
        };
    }

    // Base usage from the main agent loop
    const baseInputTokens =
        (result as any).totalUsage?.inputTokens ??
        result.usage?.inputTokens ??
        0;
    const baseOutputTokens =
        (result as any).totalUsage?.outputTokens ??
        result.usage?.outputTokens ??
        0;
    const baseReasoningTokens =
        (result as any).totalUsage?.reasoningTokens ??
        result.usage?.reasoningTokens ??
        0;

    // totalInputTokens/totalOutputTokens include second-chance + fallback overhead
    // Subtract the per-step accumulation (already in base) to avoid double-counting,
    // then add only the extra tokens from second-chance and fallback calls.
    // Since totalInputTokens starts at 0 and accumulates per-step + extras,
    // and baseInputTokens is the SDK's own total, use whichever is larger.
    const finalInputTokens = Math.max(baseInputTokens, totalInputTokens);
    const finalOutputTokens = Math.max(baseOutputTokens, totalOutputTokens);
    const finalReasoningTokens = Math.max(
        baseReasoningTokens,
        totalReasoningTokens,
    );

    return {
        findings,
        text: finalText,
        steps: result.steps?.length ?? 0,
        toolCalls: allToolCalls,
        finishReason: result.finishReason,
        source,
        usage: {
            inputTokens: finalInputTokens,
            outputTokens: finalOutputTokens,
            reasoningTokens: finalReasoningTokens,
            totalTokens: finalInputTokens + finalOutputTokens,
        },
        discardedBySeverity,
        droppedByVerify,
        verificationUsage,
        coverage: coverageSummary,
        verification: verificationTrace,
        anomalies: buildAgentAnomalies({
            steps: result.steps?.length ?? 0,
            toolCalls: allToolCalls,
            coverage: coverageSummary,
        }),
    };
}

async function runCoverageRecoveryPass(params: {
    input: AgentLoopInput;
    byokConfig?: BYOKConfig;
    tools: Record<string, any>;
    coverageTargets: ReturnType<typeof buildCoverageLedger>;
    allToolCalls: AgentLoopOutput['toolCalls'];
    totalInputTokens: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
}): Promise<{
    text: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
}> {
    const {
        input,
        byokConfig,
        tools,
        coverageTargets,
        allToolCalls,
        totalInputTokens,
        totalOutputTokens,
        totalReasoningTokens,
    } = params;
    const remainingCoverageDebt = formatCoverageDebt(coverageTargets, 12);
    if (!remainingCoverageDebt) {
        return {
            text: '',
            totalInputTokens,
            totalOutputTokens,
            totalReasoningTokens,
        };
    }

    const investigationSummary = allToolCalls
        .slice(-20)
        .map((toolCall) => {
            const args =
                typeof toolCall.args === 'string'
                    ? toolCall.args
                    : JSON.stringify(toolCall.args);
            return `${toolCall.toolName || toolCall.tool}(${args.substring(0, 150)})`;
        })
        .join('\n');

    let recoveryStep = 0;
    let recoveryText = '';
    const recoverySignal = timeoutSignal(LLM_CALL_TIMEOUT_MS);

    try {
        const recoveryResult = await throttledGenerateText({
            byokConfig,
            organizationId: input.telemetryMetadata?.organizationId,
            role: 'main',
            label: `${input.agentName ?? 'agent-loop'}-coverage-recovery`,
            abortSignal: recoverySignal,
            fn: () =>
                generateText({
                    abortSignal: recoverySignal,
                    model: input.model,
                    system:
                        input.systemPrompt +
                        '\n\nIMPORTANT: This is a coverage recovery pass. You must inspect the remaining changed files before responding.',
                    prompt: `You already investigated this review, but some changed files are still uncovered.

<RecentInvestigation>
${investigationSummary || 'No prior tool calls captured.'}
</RecentInvestigation>

<RemainingCoverage>
${remainingCoverageDebt}
</RemainingCoverage>

Investigate the remaining changed files now.
- Use tools.
- Prefer readFile on each remaining file.
- After inspecting them, return ONLY JSON with ADDITIONAL findings discovered from this recovery pass.
- If no new findings appear, return an empty suggestions array.
`,
                    tools,
                    stopWhen: stepCountIs(6),
                    prepareStep: ({ stepNumber }: any) => {
                        recoveryStep = stepNumber;
                        if (stepNumber >= 5) {
                            return {
                                toolChoice: 'none' as const,
                                activeTools: [],
                                system:
                                    input.systemPrompt +
                                    '\n\nIMPORTANT: This is the final step of the coverage recovery pass. Do NOT call tools. Respond with JSON only.',
                            };
                        }

                        return {
                            system:
                                input.systemPrompt +
                                '\n\nIMPORTANT: Coverage recovery is in progress.\n' +
                                formatCoverageDebt(coverageTargets, 12),
                        };
                    },
                    onStepFinish: (event: any) => {
                        if (event.toolCalls) {
                            for (const toolCall of event.toolCalls) {
                                const args =
                                    (toolCall as any).args ||
                                    (toolCall as any).input ||
                                    {};

                                allToolCalls.push({
                                    tool: toolCall.toolName,
                                    toolName: toolCall.toolName,
                                    args,
                                    result: '',
                                });

                                markCoverageFromToolCall(
                                    coverageTargets,
                                    toolCall.toolName,
                                    args,
                                    recoveryStep,
                                );
                            }
                        }

                        if (event.text) {
                            recoveryText = event.text;
                        }
                    },
                }),
        });

        recoveryText = recoveryResult.text || recoveryText;

        return {
            text: recoveryText,
            totalInputTokens:
                totalInputTokens +
                ((recoveryResult as any).totalUsage?.inputTokens ??
                    recoveryResult.usage?.inputTokens ??
                    0),
            totalOutputTokens:
                totalOutputTokens +
                ((recoveryResult as any).totalUsage?.outputTokens ??
                    recoveryResult.usage?.outputTokens ??
                    0),
            totalReasoningTokens:
                totalReasoningTokens +
                ((recoveryResult as any).totalUsage?.reasoningTokens ??
                    recoveryResult.usage?.reasoningTokens ??
                    0),
        };
    } catch (error) {
        logger.warn({
            message: `[AGENT-COVERAGE-GAP] Recovery pass failed: ${error instanceof Error ? error.message : String(error)}`,
            context: 'AgentLoop',
        });

        return {
            text: '',
            totalInputTokens,
            totalOutputTokens,
            totalReasoningTokens,
        };
    }
}

function shouldRunLowCoverageSecondChance(
    coverage: CoverageSummary | null | undefined,
): boolean {
    if (!coverage || coverage.totalTargets < 2) return false;
    const coveragePct =
        coverage.totalTargets > 0
            ? coverage.touchedTargets / coverage.totalTargets
            : 0;

    return coverage.pendingTargets > 0 && coveragePct < 0.7;
}

async function runLowCoverageSecondChance(params: {
    input: AgentLoopInput;
    byokConfig?: BYOKConfig;
    tools: Record<string, any>;
    coverageTargets: ReturnType<typeof buildCoverageLedger>;
    allToolCalls: AgentLoopOutput['toolCalls'];
    totalInputTokens: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
}): Promise<{
    text: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
}> {
    const {
        input,
        byokConfig,
        tools,
        coverageTargets,
        allToolCalls,
        totalInputTokens,
        totalOutputTokens,
        totalReasoningTokens,
    } = params;
    const remainingCoverageDebt = formatCoverageDebt(coverageTargets, 12);
    if (!remainingCoverageDebt) {
        return {
            text: '',
            totalInputTokens,
            totalOutputTokens,
            totalReasoningTokens,
        };
    }

    const investigationSummary = allToolCalls
        .slice(-24)
        .map((toolCall) => {
            const args =
                typeof toolCall.args === 'string'
                    ? toolCall.args
                    : JSON.stringify(toolCall.args);
            return `${toolCall.toolName || toolCall.tool}(${args.substring(0, 180)})`;
        })
        .join('\n');

    let secondChanceStep = 0;
    let secondChanceText = '';
    const lowCoverageSignal = timeoutSignal(LLM_CALL_TIMEOUT_MS);

    try {
        const secondChanceResult = await throttledGenerateText({
            byokConfig,
            organizationId: input.telemetryMetadata?.organizationId,
            role: 'main',
            label: `${input.agentName ?? 'agent-loop'}-coverage-second-chance`,
            abortSignal: lowCoverageSignal,
            fn: () =>
                generateText({
                    abortSignal: lowCoverageSignal,
                    model: input.model,
                    system:
                        input.systemPrompt +
                        '\n\nIMPORTANT: Coverage is still too low. This is a final targeted inspection pass. You must inspect the remaining changed files with readFile or checkTypes before responding.',
                    prompt: `Your previous review finished with low changed-file coverage.

<RecentInvestigation>
${investigationSummary || 'No prior tool calls captured.'}
</RecentInvestigation>

<RemainingCoverage>
${remainingCoverageDebt}
</RemainingCoverage>

Instructions:
- Focus only on the remaining uncovered changed files.
- Use readFile or checkTypes on those files before responding.
- Be surgical: inspect remaining files, then return ONLY JSON with ADDITIONAL findings.
- If the remaining files are safe, return an empty suggestions array.`,
                    tools,
                    stopWhen: stepCountIs(5),
                    prepareStep: ({ stepNumber }: any) => {
                        secondChanceStep = stepNumber;
                        if (stepNumber >= 4) {
                            return {
                                toolChoice: 'none' as const,
                                activeTools: [],
                                system:
                                    input.systemPrompt +
                                    '\n\nIMPORTANT: Final step of the low-coverage second chance. Do NOT call tools. Return JSON only.',
                            };
                        }

                        return {
                            system:
                                input.systemPrompt +
                                '\n\nIMPORTANT: Low-coverage second chance in progress.\n' +
                                formatCoverageDebt(coverageTargets, 12),
                        };
                    },
                    onStepFinish: (event: any) => {
                        if (event.toolCalls) {
                            for (const toolCall of event.toolCalls) {
                                const args =
                                    (toolCall as any).args ||
                                    (toolCall as any).input ||
                                    {};

                                allToolCalls.push({
                                    tool: toolCall.toolName,
                                    toolName: toolCall.toolName,
                                    args,
                                    result: '',
                                });

                                markCoverageFromToolCall(
                                    coverageTargets,
                                    toolCall.toolName,
                                    args,
                                    secondChanceStep,
                                );
                            }
                        }

                        if (event.text) {
                            secondChanceText = event.text;
                        }
                    },
                }),
        });

        secondChanceText = secondChanceResult.text || secondChanceText;

        return {
            text: secondChanceText,
            totalInputTokens:
                totalInputTokens +
                ((secondChanceResult as any).totalUsage?.inputTokens ??
                    secondChanceResult.usage?.inputTokens ??
                    0),
            totalOutputTokens:
                totalOutputTokens +
                ((secondChanceResult as any).totalUsage?.outputTokens ??
                    secondChanceResult.usage?.outputTokens ??
                    0),
            totalReasoningTokens:
                totalReasoningTokens +
                ((secondChanceResult as any).totalUsage?.reasoningTokens ??
                    secondChanceResult.usage?.reasoningTokens ??
                    0),
        };
    } catch (error) {
        logger.warn({
            message: `[AGENT-COVERAGE-SECOND-CHANCE] Focused inspection pass failed: ${error instanceof Error ? error.message : String(error)}`,
            context: 'AgentLoop',
        });

        return {
            text: '',
            totalInputTokens,
            totalOutputTokens,
            totalReasoningTokens,
        };
    }
}

async function runSynthesisRescuePass(params: {
    input: AgentLoopInput;
    byokConfig?: BYOKConfig;
    findings: FindingsOutput;
    allToolCalls: AgentLoopOutput['toolCalls'];
    totalInputTokens: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
}): Promise<{
    findings: FindingsOutput | null;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalReasoningTokens: number;
}> {
    const {
        input,
        byokConfig,
        findings,
        allToolCalls,
        totalInputTokens: initialTotalInputTokens,
        totalOutputTokens: initialTotalOutputTokens,
        totalReasoningTokens: initialTotalReasoningTokens,
    } = params;
    let totalInputTokens = initialTotalInputTokens;
    let totalOutputTokens = initialTotalOutputTokens;
    let totalReasoningTokens = initialTotalReasoningTokens;

    const currentFindingsSummary = findings.suggestions.length
        ? findings.suggestions
              .map((suggestion, index) =>
                  [
                      `${index + 1}. ${suggestion.relevantFile}`,
                      suggestion.oneSentenceSummary ||
                          truncateText(suggestion.suggestionContent, 220),
                  ].join(' :: '),
              )
              .join('\n')
        : 'No findings reported yet.';

    const inspectedFilesSummary =
        allToolCalls.length > 0
            ? [...new Set(buildToolEvidenceSummary(allToolCalls).strongFiles)]
                  .slice(0, 24)
                  .join('\n')
            : 'No files were read.';

    const investigationSummary = allToolCalls
        .slice(-20)
        .map((toolCall) => {
            const args =
                typeof toolCall.args === 'string'
                    ? toolCall.args
                    : JSON.stringify(toolCall.args);
            return `${toolCall.toolName || toolCall.tool}(${args.substring(0, 180)}) => ${truncateText(toolCall.result || '(empty)', 240)}`;
        })
        .join('\n');
    const synthesisSignal = timeoutSignal(LLM_CALL_TIMEOUT_MS);

    try {
        const synthesisResult = await throttledGenerateText({
            byokConfig,
            organizationId: input.telemetryMetadata?.organizationId,
            role: 'main',
            label: `${input.agentName ?? 'agent-loop'}-synthesis-rescue`,
            abortSignal: synthesisSignal,
            fn: () =>
                generateText({
                    abortSignal: synthesisSignal,
                    model: input.model,
                    experimental_telemetry: {
                        isEnabled: true,
                        functionId: `${input.agentName ?? 'agent-loop'}-synthesis-rescue`,
                    },
                    providerOptions: buildLangSmithProviderOptions(
                        `${input.agentName ?? 'agent-loop'}-synthesis-rescue`,
                        input.telemetryMetadata,
                    ),
                    system:
                        input.systemPrompt +
                        '\n\nIMPORTANT: This is a synthesis pass, not an exploration pass. Do NOT call tools. Re-evaluate the diff, call graph, inspected files, and current findings to detect at most one concrete missed bug.',
                    prompt: `${input.userPrompt}

<AlreadyInspectedFiles>
${inspectedFilesSummary}
</AlreadyInspectedFiles>

<RecentInvestigation>
${investigationSummary || 'No tool calls captured.'}
</RecentInvestigation>

<CurrentFindings>
${currentFindingsSummary}
</CurrentFindings>

Your task:
- Re-think the review based on the context above.
- Do not add variants or restatements of existing findings.
- Do not add speculative risks.
- If there are concrete missed bugs, return them.
- If there is no clearly missed bug, return an empty suggestions array.

Return ONLY JSON:
\`\`\`json
{
  "reasoning": "why there are or aren't concrete missed bugs",
  "suggestions": [
    {
      "relevantFile": "path/to/file",
      "language": "ts",
      "label": "bug|security|performance",
      "suggestionContent": "describe the missed issue concretely",
      "existingCode": "problematic code",
      "improvedCode": "fix",
      "oneSentenceSummary": "brief summary",
      "relevantLinesStart": 10,
      "relevantLinesEnd": 12,
      "severity": "critical|high|medium|low"
    }
  ]
}
\`\`\``,
                    stopWhen: stepCountIs(1),
                }),
        });

        const synthesisText = synthesisResult.text || '';
        let extraFindings = tryParseFindings(synthesisText);

        if (!extraFindings && synthesisText.length > 50) {
            const fallbackResult = await structureWithFallbackModel(
                synthesisText,
                secrets.byokConfig,
                input.telemetryMetadata?.organizationId,
            );
            if (fallbackResult) {
                extraFindings = fallbackResult.findings;
                totalInputTokens += fallbackResult.usage.inputTokens;
                totalOutputTokens += fallbackResult.usage.outputTokens;
                totalReasoningTokens += fallbackResult.usage.reasoningTokens;
            }
        }

        const usage =
            synthesisResult.usage ?? (synthesisResult as any).totalUsage;
        totalInputTokens += usage?.inputTokens ?? 0;
        totalOutputTokens += usage?.outputTokens ?? 0;
        totalReasoningTokens += usage?.reasoningTokens ?? 0;

        logger.log({
            message: `[AGENT-SYNTHESIS-RESCUE] before=${findings.suggestions.length} added=${extraFindings?.suggestions.length ?? 0}`,
            context: 'AgentLoop',
            metadata: {
                currentFindings: findings.suggestions.length,
                addedFindings: extraFindings?.suggestions.length ?? 0,
                inspectedFiles: inspectedFilesSummary
                    .split('\n')
                    .filter(Boolean).length,
                textPreview: truncateText(synthesisText, 320),
            },
        });

        return {
            findings: extraFindings,
            totalInputTokens,
            totalOutputTokens,
            totalReasoningTokens,
        };
    } catch (error) {
        logger.warn({
            message: `[AGENT-SYNTHESIS-RESCUE] Failed: ${error instanceof Error ? error.message : String(error)}`,
            context: 'AgentLoop',
        });

        return {
            findings: null,
            totalInputTokens,
            totalOutputTokens,
            totalReasoningTokens,
        };
    }
}

function mergeFindings(
    base: FindingsOutput,
    extra: FindingsOutput,
): FindingsOutput {
    const seen = new Set(
        base.suggestions.map((suggestion) =>
            [
                suggestion.relevantFile,
                suggestion.relevantLinesStart ?? '',
                suggestion.relevantLinesEnd ?? '',
                suggestion.suggestionContent,
            ].join('::'),
        ),
    );

    const additionalSuggestions = extra.suggestions.filter((suggestion) => {
        const key = [
            suggestion.relevantFile,
            suggestion.relevantLinesStart ?? '',
            suggestion.relevantLinesEnd ?? '',
            suggestion.suggestionContent,
        ].join('::');

        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    return {
        reasoning: [base.reasoning, extra.reasoning]
            .filter(Boolean)
            .join('\n\n'),
        suggestions: [...base.suggestions, ...additionalSuggestions],
    };
}

async function verifyFindingsWithTools(params: {
    findings: FindingsOutput;
    input: AgentLoopInput;
    secrets: AgentLoopSecrets;
    allToolCalls: AgentLoopOutput['toolCalls'];
    tools: Record<string, any>;
}): Promise<{
    findings: FindingsOutput;
    droppedByVerify: FindingsOutput['suggestions'];
    trace: VerificationTraceSummary | null;
    usage: {
        inputTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        totalTokens: number;
    };
}> {
    const { findings, input, secrets, allToolCalls, tools } = params;
    const internalModel = getInternalModel(secrets.byokConfig);
    const reviewerEvidence = buildToolEvidenceSummary(allToolCalls);

    if (!internalModel || findings.suggestions.length === 0) {
        return {
            findings,
            droppedByVerify: [],
            trace: null,
            usage: {
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                totalTokens: 0,
            },
        };
    }

    try {
        const decisions = new Map<number, SuggestionVerificationDecision>();
        const verifierEvidenceByIndex = new Map<number, ToolEvidenceSummary>();
        const verifierParseModeByIndex = new Map<
            number,
            'direct' | 'fallback-llm' | 'default-keep'
        >();
        const verifierRawTextByIndex = new Map<number, string>();
        let totalInputTokens = 0;
        let totalOutputTokens = 0;
        let totalReasoningTokens = 0;
        const decisionTraces: VerificationDecisionTrace[] = [];

        const reviewMode = params.input.reviewMode || 'normal';

        // Route each finding based on confidence + reviewMode
        const toVerifyFull: Array<{ index: number; suggestion: any }> = [];
        const toVerifyLight: Array<{ index: number; suggestion: any }> = [];
        const toSkip: Array<{ index: number; suggestion: any }> = [];

        for (let i = 0; i < findings.suggestions.length; i++) {
            const suggestion = findings.suggestions[i];
            const confidence = suggestion.confidence ?? 5;

            if (reviewMode === 'deep') {
                toVerifyFull.push({ index: i, suggestion });
            } else if (confidence >= 9) {
                toSkip.push({ index: i, suggestion });
            } else if (confidence >= 5) {
                toVerifyLight.push({ index: i, suggestion });
            } else {
                toVerifyFull.push({ index: i, suggestion });
            }
        }

        if (toSkip.length > 0) {
            logger.log({
                message: `[AGENT-VERIFY] Skipping ${toSkip.length} very-high-confidence findings (confidence >= 9), verifying ${toVerifyLight.length} light + ${toVerifyFull.length} full`,
                context: 'AgentLoop',
            });
        }

        // Skip: auto-keep high-confidence findings
        for (const { index } of toSkip) {
            decisions.set(index, {
                index,
                keep: true,
                rationale:
                    'Very high confidence (>= 9) — skipped verification in normal mode.',
            });
            verifierParseModeByIndex.set(index, 'direct');
            verifierRawTextByIndex.set(index, '');
            verifierEvidenceByIndex.set(index, {
                strongFiles: [],
                weakFiles: [],
            });
        }

        // Light verify: 2 steps max, tools available
        const lightResults = await Promise.allSettled(
            toVerifyLight.map(({ index, suggestion }) => {
                return verifySingleFindingWithTools({
                    index,
                    suggestion,
                    input,
                    secrets,
                    allToolCalls,
                    tools,
                    maxVerifySteps: 2,
                });
            }),
        );

        for (let i = 0; i < lightResults.length; i++) {
            const result = lightResults[i];
            if (result.status !== 'fulfilled') continue;
            const vr = result.value;
            decisions.set(toVerifyLight[i].index, vr.decision);
            verifierEvidenceByIndex.set(toVerifyLight[i].index, vr.evidence);
            verifierParseModeByIndex.set(toVerifyLight[i].index, vr.parseMode);
            verifierRawTextByIndex.set(
                toVerifyLight[i].index,
                vr.rawTextPreview,
            );
            totalInputTokens += vr.usage.inputTokens;
            totalOutputTokens += vr.usage.outputTokens;
            totalReasoningTokens += vr.usage.reasoningTokens;
        }

        // Full verify: 5 steps, all tools
        const fullResults = await Promise.allSettled(
            toVerifyFull.map(({ index, suggestion }) => {
                return verifySingleFindingWithTools({
                    index,
                    suggestion,
                    input,
                    secrets,
                    allToolCalls,
                    tools,
                });
            }),
        );

        for (let i = 0; i < fullResults.length; i++) {
            const result = fullResults[i];
            if (result.status !== 'fulfilled') continue;
            const vr = result.value;
            decisions.set(toVerifyFull[i].index, vr.decision);
            verifierEvidenceByIndex.set(toVerifyFull[i].index, vr.evidence);
            verifierParseModeByIndex.set(toVerifyFull[i].index, vr.parseMode);
            verifierRawTextByIndex.set(
                toVerifyFull[i].index,
                vr.rawTextPreview,
            );
            totalInputTokens += vr.usage.inputTokens;
            totalOutputTokens += vr.usage.outputTokens;
            totalReasoningTokens += vr.usage.reasoningTokens;
        }

        let droppedByVerifier = 0;
        let droppedByEvidenceFilter = 0;
        const droppedSuggestions: FindingsOutput['suggestions'] = [];

        const verifiedSuggestions = findings.suggestions
            .map((suggestion, index) => {
                const decision = decisions.get(index);
                if (!decision) return suggestion;
                if (!decision.keep) {
                    droppedByVerifier++;
                    droppedSuggestions.push(suggestion);
                    decisionTraces.push({
                        index,
                        relevantFile: suggestion.relevantFile,
                        action: 'drop',
                        parseMode:
                            verifierParseModeByIndex.get(index) ||
                            'default-keep',
                        rationale: truncateText(decision.rationale || '', 400),
                        confidence: decision.confidence,
                        verifierEvidence:
                            verifierEvidenceByIndex.get(index) ||
                            buildToolEvidenceSummary([]),
                        rawTextPreview: verifierRawTextByIndex.get(index) || '',
                    });
                    return null;
                }

                const passesEvidenceFilter = hasEvidenceForRelevantFile(
                    reviewerEvidence,
                    suggestion.relevantFile,
                )
                    ? true
                    : hasEvidenceForRelevantFile(
                          verifierEvidenceByIndex.get(index),
                          suggestion.relevantFile,
                      );

                if (!passesEvidenceFilter) {
                    droppedByEvidenceFilter++;
                    droppedSuggestions.push(suggestion);
                    decisionTraces.push({
                        index,
                        relevantFile: suggestion.relevantFile,
                        action: 'drop',
                        parseMode:
                            verifierParseModeByIndex.get(index) ||
                            'default-keep',
                        rationale: truncateText(
                            `Dropped by evidence filter. ${decision.rationale || ''}`.trim(),
                            400,
                        ),
                        confidence: decision.confidence,
                        verifierEvidence:
                            verifierEvidenceByIndex.get(index) ||
                            buildToolEvidenceSummary([]),
                        rawTextPreview: verifierRawTextByIndex.get(index) || '',
                    });
                    logger.warn({
                        message: `[EVIDENCE-FILTER] Dropping finding ${index} for ${suggestion.relevantFile} — neither reviewer nor verifier touched the file`,
                        context: 'AgentLoop',
                        metadata: {
                            index,
                            relevantFile: suggestion.relevantFile,
                            reviewerEvidence,
                            verifierEvidence:
                                verifierEvidenceByIndex.get(index) || null,
                            verifierRationale: decision.rationale,
                        },
                    });
                    return null;
                }

                decisionTraces.push({
                    index,
                    relevantFile: suggestion.relevantFile,
                    action: 'keep',
                    parseMode:
                        verifierParseModeByIndex.get(index) || 'default-keep',
                    rationale: truncateText(decision.rationale || '', 400),
                    confidence: decision.confidence,
                    verifierEvidence:
                        verifierEvidenceByIndex.get(index) ||
                        buildToolEvidenceSummary([]),
                    rawTextPreview: verifierRawTextByIndex.get(index) || '',
                });

                return suggestion;
            })
            .filter(Boolean) as FindingsOutput['suggestions'];

        const droppedCount = droppedByVerifier + droppedByEvidenceFilter;

        logger.log({
            message: `[AGENT-VERIFY] Verified ${findings.suggestions.length} candidate findings, kept ${verifiedSuggestions.length}, dropped ${droppedCount}`,
            context: 'AgentLoop',
            metadata: {
                suggestionsBefore: findings.suggestions.length,
                suggestionsAfter: verifiedSuggestions.length,
                droppedCount,
                droppedByVerifier,
                droppedByEvidenceFilter,
            },
        });

        return {
            findings: {
                reasoning:
                    droppedCount > 0
                        ? `${findings.reasoning}\n\nFinal verifier kept ${verifiedSuggestions.length}/${findings.suggestions.length} candidate findings after tool-based verification and evidence filtering.`
                        : findings.reasoning,
                suggestions: verifiedSuggestions,
            },
            droppedByVerify: droppedSuggestions,
            trace: {
                beforeCount: findings.suggestions.length,
                afterCount: verifiedSuggestions.length,
                droppedByVerifier,
                droppedByEvidenceFilter,
                decisions: decisionTraces,
            },
            usage: {
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
                reasoningTokens: totalReasoningTokens,
                totalTokens: totalInputTokens + totalOutputTokens,
            },
        };
    } catch (error) {
        logger.warn({
            message: `[AGENT-VERIFY] Final finding verification failed: ${error instanceof Error ? error.message : String(error)}`,
            context: 'AgentLoop',
        });

        return {
            findings,
            droppedByVerify: [],
            trace: null,
            usage: {
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                totalTokens: 0,
            },
        };
    }
}

async function verifySingleFindingWithTools(params: {
    index: number;
    suggestion: FindingsOutput['suggestions'][number];
    input: AgentLoopInput;
    secrets: AgentLoopSecrets;
    allToolCalls: AgentLoopOutput['toolCalls'];
    tools: Record<string, any>;
    maxVerifySteps?: number;
}): Promise<{
    decision: SuggestionVerificationDecision;
    evidence: ToolEvidenceSummary;
    parseMode: 'direct' | 'fallback-llm' | 'default-keep';
    rawTextPreview: string;
    usage: {
        inputTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        totalTokens: number;
    };
}> {
    const { index, suggestion, input, secrets, allToolCalls, tools } = params;
    const internalModel = getInternalModel(secrets.byokConfig);
    const evidenceBundle = buildSuggestionEvidenceBundle(
        index,
        suggestion,
        input.changedFiles,
        allToolCalls,
        input.callGraph,
    );

    logger.log({
        message: `[AGENT-VERIFY-CONTEXT] finding=${index} file=${suggestion.relevantFile} investigationLines=${evidenceBundle.relevantInvestigationCount} callGraphHintChars=${evidenceBundle.callGraphHint === 'N/A' ? 0 : evidenceBundle.callGraphHint.length}`,
        context: 'AgentLoop',
        metadata: {
            index,
            relevantFile: suggestion.relevantFile,
            relevantLinesStart: suggestion.relevantLinesStart,
            relevantLinesEnd: suggestion.relevantLinesEnd,
            investigationLines: evidenceBundle.relevantInvestigationCount,
            investigationLogPreview: truncateText(
                evidenceBundle.relevantInvestigationLog,
                320,
            ),
            callGraphHintChars:
                evidenceBundle.callGraphHint === 'N/A'
                    ? 0
                    : evidenceBundle.callGraphHint.length,
            callGraphHintPreview: truncateText(
                evidenceBundle.callGraphHint,
                320,
            ),
        },
    });

    if (!internalModel) {
        return {
            decision: {
                index,
                keep: true,
                rationale:
                    'No verifier model available; keeping finding by default.',
            },
            evidence: buildToolEvidenceSummary([]),
            parseMode: 'default-keep',
            rawTextPreview: '',
            usage: {
                inputTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
                totalTokens: 0,
            },
        };
    }

    let finalText = '';
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalReasoningTokens = 0;
    let verifierSteps = 0;
    const verifierToolCalls: AgentLoopOutput['toolCalls'] = [];
    const verifierStepTexts: string[] = [];
    const verificationPrompt = buildVerifierPrompt(
        evidenceBundle.bundle,
        index,
    );
    const verifierSignal = timeoutSignal(LLM_CALL_TIMEOUT_MS);

    const verificationRun: any = await throttledGenerateText({
        byokConfig: secrets.byokConfig,
        organizationId: input.telemetryMetadata?.organizationId,
        role: 'internal',
        label: `${input.agentName ?? 'agent-loop'}-verify-finding`,
        abortSignal: verifierSignal,
        fn: () =>
            generateText({
                abortSignal: verifierSignal,
                model: internalModel as any,
                experimental_telemetry: {
                    isEnabled: true,
                    functionId: `${input.agentName ?? 'agent-loop'}-verify-finding`,
                },
                providerOptions: buildLangSmithProviderOptions(
                    `${input.agentName ?? 'agent-loop'}-verify-finding`,
                    input.telemetryMetadata,
                ),
                system: verificationPrompt.system,
                prompt: verificationPrompt.prompt,
                tools,
                stopWhen: stepCountIs(params.maxVerifySteps || 5),
                prepareStep: ({ stepNumber }: any) => {
                    const maxSteps = params.maxVerifySteps || 5;
                    verifierSteps = stepNumber;
                    if (stepNumber >= maxSteps - 1) {
                        return {
                            toolChoice: 'none' as const,
                            activeTools: [],
                            system: 'You are a surgical code review verifier.\n\nIMPORTANT: Final step. Do NOT call tools. Return JSON only.',
                        };
                    }
                    return {};
                },
                onStepFinish: (event: any) => {
                    if (event.text) {
                        finalText = event.text;
                        verifierStepTexts.push(event.text);
                    }
                    if (event.usage) {
                        totalInputTokens += event.usage.inputTokens ?? 0;
                        totalOutputTokens += event.usage.outputTokens ?? 0;
                        totalReasoningTokens +=
                            event.usage.reasoningTokens ?? 0;
                    }
                    if (event.toolCalls) {
                        const resultLookup = new Map<string, string>();
                        const toolResults: any[] = event.toolResults || [];

                        for (const tr of toolResults) {
                            const id = tr?.toolCallId || tr?.id || '';
                            const val =
                                tr?.result ?? tr?.output ?? tr?.content ?? '';
                            if (id) resultLookup.set(id, String(val));
                        }

                        for (const toolCall of event.toolCalls) {
                            const args =
                                (toolCall as any).args ||
                                (toolCall as any).input ||
                                {};
                            const callId =
                                (toolCall as any).toolCallId ||
                                (toolCall as any).id ||
                                '';
                            let resultStr = resultLookup.get(callId) || '';

                            if (
                                !resultStr &&
                                toolResults.length === event.toolCalls.length
                            ) {
                                const idx = event.toolCalls.indexOf(toolCall);
                                if (idx >= 0 && toolResults[idx]) {
                                    const tr = toolResults[idx];
                                    resultStr = String(
                                        tr?.result ??
                                            tr?.output ??
                                            tr?.content ??
                                            '',
                                    );
                                }
                            }

                            verifierToolCalls.push({
                                tool: toolCall.toolName,
                                toolName: toolCall.toolName,
                                args,
                                result: resultStr.substring(0, 500),
                            });

                            logger.log({
                                message: `[AGENT-VERIFY-TOOL] finding=${index} step=${verifierSteps} ${toolCall.toolName}(${JSON.stringify((toolCall as any).args || (toolCall as any).input || {}).substring(0, 180)})`,
                                context: 'AgentLoop',
                            });
                        }
                    }
                },
            }),
    });

    let verificationText =
        verificationRun.text ||
        finalText ||
        verifierStepTexts[verifierStepTexts.length - 1] ||
        verifierStepTexts.join('\n\n');

    if (!verificationText && verifierToolCalls.length > 0) {
        const investigationSummary = verifierToolCalls
            .map((toolCall) => {
                const args =
                    typeof toolCall.args === 'string'
                        ? toolCall.args
                        : JSON.stringify(toolCall.args);
                const resultStr =
                    typeof toolCall.result === 'string'
                        ? toolCall.result.substring(0, 320)
                        : '';
                return `${toolCall.toolName || toolCall.tool}(${args.substring(0, 180)}) => ${resultStr || '(empty)'}`;
            })
            .join('\n');

        try {
            const verifierSecondChanceSignal =
                timeoutSignal(LLM_CALL_TIMEOUT_MS);
            const secondChanceResult: any = await throttledGenerateText({
                byokConfig: secrets.byokConfig,
                organizationId: input.telemetryMetadata?.organizationId,
                role: 'internal',
                label: `${input.agentName ?? 'agent-loop'}-verify-finding-second-chance`,
                abortSignal: verifierSecondChanceSignal,
                fn: () =>
                    generateText({
                        abortSignal: verifierSecondChanceSignal,
                        model: internalModel as any,
                        experimental_telemetry: {
                            isEnabled: true,
                            functionId: `${input.agentName ?? 'agent-loop'}-verify-finding-second-chance`,
                        },
                        providerOptions: buildLangSmithProviderOptions(
                            `${input.agentName ?? 'agent-loop'}-verify-finding-second-chance`,
                            input.telemetryMetadata,
                        ),
                        system: `You are a surgical code review verifier.

You already investigated the candidate finding with tools. Do NOT call any more tools.

Your job now is only to return the final verdict as JSON.`,
                        prompt: `${evidenceBundle.bundle}

<VerifierInvestigation>
${investigationSummary}
</VerifierInvestigation>

Based on the investigation above, return ONLY JSON:
\`\`\`json
{
  "index": ${index},
  "keep": true,
  "rationale": "why the evidence supports keep/drop",
  "confidence": "high|medium|low"
}
\`\`\`

Rules:
- Drop only if you found concrete evidence against the candidate.
- If you cannot refute it, keep it.
- No prose outside JSON.`,
                        stopWhen: stepCountIs(1),
                    }),
            });

            verificationText = secondChanceResult.text || verificationText;
            totalInputTokens +=
                (secondChanceResult as any).totalUsage?.inputTokens ??
                secondChanceResult.usage?.inputTokens ??
                0;
            totalOutputTokens +=
                (secondChanceResult as any).totalUsage?.outputTokens ??
                secondChanceResult.usage?.outputTokens ??
                0;
            totalReasoningTokens +=
                (secondChanceResult as any).totalUsage?.reasoningTokens ??
                secondChanceResult.usage?.reasoningTokens ??
                0;

            if (verificationText) {
                logger.log({
                    message: `[AGENT-VERIFY-SECOND-CHANCE] finding=${index} recovered text response after tool-only verifier run`,
                    context: 'AgentLoop',
                });
            }
        } catch (error) {
            logger.warn({
                message: `[AGENT-VERIFY-SECOND-CHANCE] finding=${index} failed: ${error instanceof Error ? error.message : String(error)}`,
                context: 'AgentLoop',
            });
        }
    }

    let decision = parseVerificationDecision(verificationText, index);
    let parseMode: 'direct' | 'fallback-llm' | 'default-keep' = 'direct';

    if (!decision && verificationText?.trim()) {
        const fallbackDecision =
            await structureVerificationDecisionWithFallbackModel(
                verificationText,
                index,
                secrets.byokConfig,
                input.telemetryMetadata?.organizationId,
            );

        if (fallbackDecision) {
            decision = fallbackDecision.decision;
            parseMode = 'fallback-llm';
            totalInputTokens += fallbackDecision.usage.inputTokens;
            totalOutputTokens += fallbackDecision.usage.outputTokens;
            totalReasoningTokens += fallbackDecision.usage.reasoningTokens;

            logger.log({
                message: `[AGENT-VERIFY-FALLBACK] finding=${index} recovered verifier decision via LLM fallback`,
                context: 'AgentLoop',
            });
        }
    }

    const rawTextPreview = truncateText(verificationText || '', 600);
    if (!decision) {
        logger.warn({
            message: `[AGENT-VERIFY-DEFAULT-KEEP] finding=${index} verifier output was not parseable; keeping by default`,
            context: 'AgentLoop',
            metadata: {
                index,
                relevantFile: suggestion.relevantFile,
                rawTextPreview,
                verifierToolCalls: verifierToolCalls.length,
            },
        });
    }

    const baseUsage = verificationRun.usage ?? verificationRun.totalUsage ?? {};

    return {
        decision:
            decision ||
            ({
                index,
                keep: true,
                rationale:
                    'Verifier did not return a parseable verdict; keeping finding by default.',
            } satisfies SuggestionVerificationDecision),
        evidence: buildToolEvidenceSummary(verifierToolCalls),
        parseMode: decision ? parseMode : 'default-keep',
        rawTextPreview,
        usage: {
            inputTokens: Math.max(baseUsage.inputTokens ?? 0, totalInputTokens),
            outputTokens: Math.max(
                baseUsage.outputTokens ?? 0,
                totalOutputTokens,
            ),
            reasoningTokens: Math.max(
                baseUsage.reasoningTokens ?? 0,
                totalReasoningTokens,
            ),
            totalTokens:
                Math.max(baseUsage.inputTokens ?? 0, totalInputTokens) +
                Math.max(baseUsage.outputTokens ?? 0, totalOutputTokens),
        },
    };
}

export function buildVerifierPrompt(
    evidenceBundle: string,
    index: number,
): {
    system: string;
    prompt: string;
} {
    return {
        system: `You are a surgical code review verifier.

Your task is to verify ONE candidate finding.

Rules:
- You may use only a few tool calls. Be surgical.
- Use tools to confirm or refute the candidate finding.
- Treat call graph hints as fast navigation hints, not as final proof.
- You must NOT create a new finding unrelated to the candidate.
- Do NOT rewrite the finding text, summary, severity, or suggested fix.

Drop criteria — drop the finding if ANY of these apply:
- The finding is speculative: it describes a theoretical concern without pointing to a concrete failure path in the changed code (e.g. "lacks rate limiting", "could cause performance issues", "consider adding validation").
- The finding is a pure efficiency concern without a failure path: O(N) queries, N+1 queries, redundant allocations, eager evaluation, synchronous operations in async context — UNLESS it causes a crash, timeout, or data corruption under normal usage.
- The finding describes a missing defensive measure (missing CSRF, missing rate limit, missing input validation, missing authentication) without evidence that the omission is exploitable in the specific changed code.
- The finding describes a pre-existing pattern that is NOT made worse by this PR.
- The finding is about code style, naming, documentation, or best practices rather than a concrete bug.
- The root cause described is factually wrong (e.g. claims something is not imported when it is).

Keep criteria — keep the finding only if ALL of these apply:
- The finding identifies a concrete defect: wrong behavior, crash, data corruption, or security vulnerability.
- The root cause is in lines added or modified by this PR.
- You can trace a specific failure path from the changed code to the bad outcome.
- The failure can happen under normal usage, not just under adversarial or extreme conditions.

When in doubt between a speculative concern and a real bug, DROP. Precision matters more than recall at this stage — a downstream reviewer exists.

Return JSON only at the end.`,
        prompt: `${evidenceBundle}

You may use up to 4 tool-call steps.

Recommended approach:
1. Read the cited file/range if needed.
2. Search for the key symbol or caller if the claim depends on flow.
3. Read one relevant caller/callee file if needed.
4. Return a final JSON verdict.

Output JSON:
\`\`\`json
{
  "index": ${index},
  "keep": true,
  "rationale": "why the evidence supports keep/drop",
  "confidence": "high|medium|low"
}
\`\`\`
`,
    };
}

function pickVerificationTools(
    tools: Record<string, any>,
): Record<string, any> {
    const allowed = ['grep', 'readFile', 'checkTypes'];
    return Object.fromEntries(
        Object.entries(tools).filter(([name]) => allowed.includes(name)),
    );
}

function buildSuggestionEvidenceBundle(
    index: number,
    suggestion: FindingsOutput['suggestions'][number],
    changedFiles: FileChange[] = [],
    allToolCalls: AgentLoopOutput['toolCalls'],
    callGraph?: string,
): SuggestionEvidenceBundle {
    const file = changedFiles.find(
        (changedFile) => changedFile.filename === suggestion.relevantFile,
    );
    const basename =
        suggestion.relevantFile.split('/').pop() || suggestion.relevantFile;
    const relevantToolCalls = allToolCalls
        .filter((toolCall) => {
            const args = JSON.stringify(toolCall.args || {});
            const result = toolCall.result || '';
            return (
                args.includes(suggestion.relevantFile) ||
                args.includes(basename) ||
                result.includes(suggestion.relevantFile) ||
                result.includes(basename)
            );
        })
        .slice(-8)
        .map((toolCall) => {
            const args =
                typeof toolCall.args === 'string'
                    ? toolCall.args
                    : JSON.stringify(toolCall.args);
            return `- ${toolCall.toolName || toolCall.tool}(${truncateText(args, 180)}) => ${truncateText(toolCall.result || '(empty)', 280)}`;
        });

    const diffSnippet = truncateText(
        file?.patchWithLinesStr || file?.patch || '',
        1800,
    );
    const fileSnippet = truncateText(
        extractFileWindow(
            file?.fileContent || '',
            suggestion.relevantLinesStart,
            suggestion.relevantLinesEnd,
        ),
        1600,
    );
    const callGraphSnippet = truncateText(
        extractRelevantCallGraphContext(callGraph, suggestion),
        1400,
    );

    const relevantInvestigationLog =
        relevantToolCalls.length > 0
            ? relevantToolCalls.join('\n')
            : '- No file-specific tool log found';
    const callGraphHint = callGraphSnippet || 'N/A';

    return {
        relevantInvestigationLog,
        relevantInvestigationCount: relevantToolCalls.length,
        callGraphHint,
        bundle: `<Finding index="${index}">
File: ${suggestion.relevantFile}
Lines: ${suggestion.relevantLinesStart ?? 'unknown'}-${suggestion.relevantLinesEnd ?? 'unknown'}
Candidate hypothesis (may be wrong):
Summary: ${suggestion.oneSentenceSummary || 'N/A'}
${suggestion.suggestionContent}

Existing code:
\`\`\`
${truncateText(suggestion.existingCode || '', 800)}
\`\`\`

Diff snippet:
\`\`\`diff
${diffSnippet || 'N/A'}
\`\`\`

File snippet:
\`\`\`
${fileSnippet || 'N/A'}
\`\`\`

Relevant investigation log:
${relevantInvestigationLog}

Call graph hints:
\`\`\`text
${callGraphHint}
\`\`\`
</Finding>`,
    };
}

function buildToolEvidenceSummary(
    toolCalls: AgentLoopOutput['toolCalls'],
): ToolEvidenceSummary {
    const strongFiles = new Set<string>();
    const weakFiles = new Set<string>();

    for (const toolCall of toolCalls) {
        const normalizedTool = (toolCall.toolName || toolCall.tool || '')
            .trim()
            .toLowerCase();
        const args = (toolCall.args || {}) as Record<string, unknown>;

        if (normalizedTool === 'readfile' || normalizedTool === 'checktypes') {
            const explicitPath =
                (args.path as string) ||
                (args.filePath as string) ||
                (args.file as string) ||
                '';
            const normalizedPath = normalizeFilePath(explicitPath);
            if (normalizedPath) {
                strongFiles.add(normalizedPath);
            }
        }

        if (normalizedTool === 'grep' && typeof toolCall.result === 'string') {
            for (const resultLine of toolCall.result.split('\n')) {
                const match = resultLine.match(/^([^:]+):\d+:/);
                if (!match?.[1]) continue;
                const normalizedPath = normalizeFilePath(match[1]);
                if (normalizedPath) {
                    weakFiles.add(normalizedPath);
                }
            }
        }
    }

    return {
        strongFiles: [...strongFiles],
        weakFiles: [...weakFiles],
    };
}

function buildAgentAnomalies(params: {
    steps: number;
    toolCalls: AgentLoopOutput['toolCalls'];
    coverage: CoverageSummary;
}): AgentAnomalySummary {
    const { steps, toolCalls, coverage } = params;
    const evidence = buildToolEvidenceSummary(toolCalls);
    const touchedTargets = coverage?.touchedTargets || 0;
    const totalTargets = coverage?.totalTargets || 0;
    const coveragePct = totalTargets > 0 ? touchedTargets / totalTargets : 0;

    return {
        stepsLe2: steps <= 2,
        zeroToolCalls: toolCalls.length === 0,
        zeroStrongEvidenceFiles: evidence.strongFiles.length === 0,
        zeroCoverage: touchedTargets === 0,
        lowCoverage: totalTargets > 0 && coveragePct < 0.7,
        lowStrongEvidenceFiles:
            totalTargets >= 2 && evidence.strongFiles.length < 2,
    };
}

function hasEvidenceForRelevantFile(
    evidence: ToolEvidenceSummary | undefined,
    relevantFile: string,
): boolean {
    if (!evidence || !relevantFile) return false;

    return [...evidence.strongFiles, ...evidence.weakFiles].some((candidate) =>
        pathsReferToSameFile(candidate, relevantFile),
    );
}

function normalizeFilePath(filePath: string): string {
    if (!filePath) return '';
    return filePath
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')
        .trim()
        .toLowerCase();
}

function pathsReferToSameFile(
    candidate: string,
    relevantFile: string,
): boolean {
    const normalizedCandidate = normalizeFilePath(candidate);
    const normalizedRelevant = normalizeFilePath(relevantFile);

    if (!normalizedCandidate || !normalizedRelevant) return false;
    if (normalizedCandidate === normalizedRelevant) return true;

    return (
        normalizedCandidate.endsWith(`/${normalizedRelevant}`) ||
        normalizedRelevant.endsWith(`/${normalizedCandidate}`)
    );
}

function extractRelevantCallGraphContext(
    callGraph: string | undefined,
    suggestion: FindingsOutput['suggestions'][number],
): string {
    if (!callGraph?.trim()) return '';

    const normalizedRelevantFile = normalizeFilePath(suggestion.relevantFile);
    const basename = normalizedRelevantFile.split('/').pop() || '';
    const shortPath = normalizedRelevantFile.split('/').slice(-2).join('/');
    const symbolHints = extractSuggestionHintTokens(suggestion);

    const rawSections = callGraph
        .split(/\n{2,}/)
        .map((section) => section.trim())
        .filter(Boolean);

    if (rawSections.length === 0) return '';

    const heading = rawSections[0].toLowerCase().startsWith('changed functions')
        ? rawSections[0]
        : '';
    const sections = heading ? rawSections.slice(1) : rawSections;

    const rankedSections = sections
        .map((section) => {
            const lower = section.toLowerCase();
            let score = 0;

            if (shortPath && lower.includes(shortPath)) score += 5;
            if (basename && lower.includes(basename)) score += 4;

            for (const token of symbolHints) {
                if (lower.includes(token)) score += 1;
            }

            return { section, score };
        })
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score);

    if (rankedSections.length === 0) {
        return '';
    }

    return [
        heading,
        ...rankedSections.slice(0, 3).map((entry) => entry.section),
    ]
        .filter(Boolean)
        .join('\n\n');
}

function extractSuggestionHintTokens(
    suggestion: FindingsOutput['suggestions'][number],
): string[] {
    const commonNoise = new Set([
        'what',
        'why',
        'how',
        'this',
        'that',
        'with',
        'from',
        'into',
        'when',
        'where',
        'null',
        'true',
        'false',
        'return',
        'const',
        'class',
        'function',
        'async',
        'await',
        'string',
        'number',
        'error',
        'value',
        'result',
        'line',
        'code',
    ]);

    const text = [
        suggestion.oneSentenceSummary,
        suggestion.suggestionContent,
        suggestion.existingCode,
        suggestion.improvedCode,
    ]
        .filter(Boolean)
        .join('\n');

    const tokens =
        text
            .match(/[A-Za-z_][A-Za-z0-9_]{3,}/g)
            ?.map((token) => token.toLowerCase()) || [];

    return [...new Set(tokens)]
        .filter((token) => !commonNoise.has(token))
        .slice(0, 10);
}

function parseVerificationDecision(
    text: string,
    index: number,
): SuggestionVerificationDecision | null {
    if (!text) return null;

    const tryParse = (raw: string): SuggestionVerificationDecision | null => {
        try {
            const parsed = JSON.parse(raw);
            if (typeof parsed?.keep !== 'boolean') return null;
            return {
                index: typeof parsed.index === 'number' ? parsed.index : index,
                keep: parsed.keep,
                rationale: parsed.rationale || '',
                confidence: parsed.confidence,
            };
        } catch {
            return null;
        }
    };

    try {
        const parsed: any = EnhancedJSONParser.parse(text);
        if (parsed && typeof parsed.keep === 'boolean') {
            return {
                index: typeof parsed.index === 'number' ? parsed.index : index,
                keep: parsed.keep,
                rationale: parsed.rationale || '',
                confidence: parsed.confidence,
            };
        }
    } catch {
        // fall through
    }

    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (codeBlockMatch?.[1]) {
        const parsed = tryParse(codeBlockMatch[1].trim());
        if (parsed) return parsed;
    }

    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        const parsed = tryParse(text.substring(firstBrace, lastBrace + 1));
        if (parsed) return parsed;
    }

    return null;
}

async function structureVerificationDecisionWithFallbackModel(
    verificationText: string,
    index: number,
    byokConfig?: BYOKConfig,
    organizationId?: string,
): Promise<{
    decision: SuggestionVerificationDecision;
    usage: {
        inputTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        totalTokens: number;
    };
} | null> {
    try {
        const internalModel = getInternalModel(byokConfig);
        const verifierFallbackSignal = timeoutSignal(LLM_CALL_TIMEOUT_MS);

        if (!internalModel) {
            logger.warn({
                message:
                    '[AGENT-VERIFY-FALLBACK] No internal model available for verifier fallback',
                context: 'AgentLoop',
            });
            return null;
        }

        const result: any = await throttledGenerateText({
            byokConfig,
            organizationId,
            role: 'internal',
            label: 'verify-structure-fallback',
            abortSignal: verifierFallbackSignal,
            fn: () =>
                generateText({
                    abortSignal: verifierFallbackSignal,
                    model: internalModel as any,
                    output: Output.object({
                        schema: jsonSchema({
                            type: 'object',
                            properties: {
                                index: { type: 'number' },
                                keep: { type: 'boolean' },
                                rationale: { type: 'string' },
                                confidence: {
                                    type: 'string',
                                    enum: ['high', 'medium', 'low'],
                                },
                            },
                            required: ['keep', 'rationale'],
                        }),
                    }) as any,
                    system: `You are a JSON extraction assistant.

You receive the raw text output of a code-review verifier and must extract only its final verdict.

Rules:
- Recover the verifier's intended keep/drop decision exactly when possible.
- Do not invent a new bug or a new rationale not supported by the text.
- Preserve refined suggestion text only if the verifier clearly provided it.
- If the text contains uncertainty, keep the rationale faithful to that uncertainty.
- Output only the structured decision object.`,
                    prompt: `Extract the verifier verdict from this text:

---
${verificationText}
---

Return:
- index
- keep
- rationale
- confidence (if present)`,
                }),
        });

        const output: any = (result as any).object ?? (result as any).output;
        const coerceKeep = (value: unknown): boolean | null => {
            if (typeof value === 'boolean') return value;
            if (typeof value === 'string') {
                const normalized = value.trim().toLowerCase();
                if (normalized === 'true') return true;
                if (normalized === 'false') return false;
            }
            return null;
        };

        let keep = coerceKeep(output?.keep);
        let rationale = output?.rationale || '';
        let confidence = output?.confidence;

        if (keep === null && typeof result?.text === 'string') {
            const parsedFromText = parseVerificationDecision(
                result.text,
                index,
            );
            if (parsedFromText) {
                keep = parsedFromText.keep;
                rationale = parsedFromText.rationale || '';
                confidence = parsedFromText.confidence;
            }
        }

        if (keep === null) {
            return null;
        }

        const fallbackUsage = result.usage ?? (result as any).totalUsage;

        return {
            decision: {
                index: typeof output?.index === 'number' ? output.index : index,
                keep,
                rationale,
                confidence,
            },
            usage: {
                inputTokens: fallbackUsage?.inputTokens ?? 0,
                outputTokens: fallbackUsage?.outputTokens ?? 0,
                reasoningTokens: fallbackUsage?.reasoningTokens ?? 0,
                totalTokens:
                    fallbackUsage?.totalTokens ??
                    (fallbackUsage?.inputTokens ?? 0) +
                        (fallbackUsage?.outputTokens ?? 0),
            },
        };
    } catch (error) {
        logger.warn({
            message: `[AGENT-VERIFY-FALLBACK] Failed to structure verifier output: ${error instanceof Error ? error.message : String(error)}`,
            context: 'AgentLoop',
        });
        return null;
    }
}

function extractFileWindow(
    fileContent: string,
    startLine?: number,
    endLine?: number,
    padding = 12,
): string {
    if (!fileContent) return '';
    if (!startLine || startLine <= 0) {
        return fileContent.split('\n').slice(0, 80).join('\n');
    }

    const lines = fileContent.split('\n');
    const start = Math.max(0, startLine - padding - 1);
    const end = Math.min(lines.length, (endLine || startLine) + padding);
    return lines
        .slice(start, end)
        .map((line, index) => `${start + index + 1}: ${line}`)
        .join('\n');
}

function truncateText(text: string, maxChars: number): string {
    if (!text) return '';
    if (text.length <= maxChars) return text;
    return `${text.substring(0, maxChars)}...`;
}

/**
 * Try to parse findings JSON from the model's text response.
 */
function tryParseFindings(text: string): FindingsOutput | null {
    if (!text) return null;

    // Strategy 1: EnhancedJSONParser (handles code blocks, json5, jsonrepair)
    try {
        const parsed: any = EnhancedJSONParser.parse(text);
        if (parsed?.suggestions && Array.isArray(parsed.suggestions)) {
            return {
                reasoning: parsed.reasoning || '',
                suggestions: parsed.suggestions,
            };
        }
    } catch {
        // Not valid JSON — try next strategy
    }

    // Strategy 2: Extract JSON from markdown code blocks manually
    // Some models wrap JSON in ```json ... ``` with text before/after that confuses the parser
    try {
        const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
        if (codeBlockMatch?.[1]) {
            const jsonStr = codeBlockMatch[1].trim();
            const parsed = JSON.parse(jsonStr);
            if (parsed?.suggestions && Array.isArray(parsed.suggestions)) {
                return {
                    reasoning: parsed.reasoning || '',
                    suggestions: parsed.suggestions,
                };
            }
        }
    } catch {
        // Malformed JSON in code block
    }

    // Strategy 3: Find the outermost { ... } that contains "suggestions"
    try {
        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
            const jsonStr = text.substring(firstBrace, lastBrace + 1);
            if (jsonStr.includes('"suggestions"')) {
                const parsed = JSON.parse(jsonStr);
                if (parsed?.suggestions && Array.isArray(parsed.suggestions)) {
                    return {
                        reasoning: parsed.reasoning || '',
                        suggestions: parsed.suggestions,
                    };
                }
            }
        }
    } catch {
        // Still not parseable — will go to fallback
    }

    return null;
}

/**
 * Check if text looks like it contains actual findings vs just investigation notes.
 * Used to gate the fallback LLM — prevents fabricating suggestions from
 * "I'm looking at file X..." investigation text.
 */
function looksLikeFindings(text: string): boolean {
    const lower = text.toLowerCase();
    // Must mention at least 2 of these to look like actual findings
    const signals = [
        /\b(bug|issue|vulnerability|problem|error|flaw|defect)\b/,
        /\b(fix|should|must|incorrect|missing|broken|unsafe|race condition)\b/,
        /\b(line\s*\d+|\.ts\b|\.js\b|\.go\b|\.rb\b|\.py\b)/,
        /\b(severity|critical|high|medium|low)\b/,
        /\b(existing.?code|improved.?code|suggestion)\b/,
        /```/,
    ];
    const matches = signals.filter((r) => r.test(lower)).length;
    return matches >= 2;
}

/**
 * Use a cheap, fast model to structure free-text review into JSON.
 * This is the fallback when the BYOK model doesn't output JSON.
 */
async function structureWithFallbackModel(
    reviewText: string,
    byokConfig?: BYOKConfig,
    organizationId?: string,
): Promise<{
    findings: FindingsOutput;
    usage: {
        inputTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        totalTokens: number;
    };
} | null> {
    try {
        const nullableStringSchema = {
            type: ['string', 'null'],
        } as const;
        const nullableNumberSchema = {
            type: ['number', 'null'],
        } as const;
        const nullableLabelSchema = {
            anyOf: [
                {
                    type: 'string',
                    enum: ['bug', 'security', 'performance'],
                },
                { type: 'null' },
            ],
        } as const;
        const nullableSeveritySchema = {
            anyOf: [
                {
                    type: 'string',
                    enum: ['critical', 'high', 'medium', 'low'],
                },
                { type: 'null' },
            ],
        } as const;
        const internalModel = getInternalModel(byokConfig);
        const structureFallbackSignal = timeoutSignal(LLM_CALL_TIMEOUT_MS);

        if (!internalModel) {
            logger.warn({
                message:
                    '[AGENT-FALLBACK] No internal model available for fallback',
                context: 'AgentLoop',
            });
            return null;
        }

        const result: any = await throttledGenerateText({
            byokConfig,
            organizationId,
            role: 'internal',
            label: 'review-structure-fallback',
            abortSignal: structureFallbackSignal,
            fn: () =>
                generateText({
                    abortSignal: structureFallbackSignal,
                    model: internalModel as any,
                    output: Output.object({
                        schema: jsonSchema({
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                reasoning: { type: 'string' },
                                suggestions: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        additionalProperties: false,
                                        properties: {
                                            relevantFile: { type: 'string' },
                                            language: nullableStringSchema,
                                            label: nullableLabelSchema,
                                            suggestionContent: {
                                                type: 'string',
                                            },
                                            existingCode: { type: 'string' },
                                            improvedCode: { type: 'string' },
                                            oneSentenceSummary:
                                                nullableStringSchema,
                                            relevantLinesStart:
                                                nullableNumberSchema,
                                            relevantLinesEnd:
                                                nullableNumberSchema,
                                            severity: nullableSeveritySchema,
                                        },
                                        required: [
                                            'relevantFile',
                                            'language',
                                            'label',
                                            'suggestionContent',
                                            'existingCode',
                                            'improvedCode',
                                            'oneSentenceSummary',
                                            'relevantLinesStart',
                                            'relevantLinesEnd',
                                            'severity',
                                        ],
                                    },
                                },
                            },
                            required: ['reasoning', 'suggestions'],
                        }),
                    }) as any,
                    system: `You are a JSON extraction assistant. You receive code review text and extract structured findings.

Rules:
- Extract EVERY issue/bug/vulnerability mentioned into a separate suggestion
- Use exact file paths from the text (e.g. "src/auth/login.ts", not just "login.ts")
- Copy code snippets exactly as written in the text
- If line numbers are mentioned, include them
- If no issues found, return empty suggestions array
- Never invent issues not in the text`,
                    prompt: `Extract all code review findings from this text:

---
${reviewText}
---

For each issue found, extract: relevantFile, language, label (bug/security/performance when present), suggestionContent (full description), existingCode, improvedCode, oneSentenceSummary, relevantLinesStart, relevantLinesEnd, severity (critical/high/medium/low).`,
                }),
        });

        const rawOutput: any = (result as any).object ?? (result as any).output;
        const output = {
            reasoning: rawOutput?.reasoning ?? '',
            suggestions: Array.isArray(rawOutput?.suggestions)
                ? rawOutput.suggestions.map((suggestion: any) => ({
                      relevantFile: suggestion?.relevantFile ?? '',
                      suggestionContent: suggestion?.suggestionContent ?? '',
                      existingCode: suggestion?.existingCode ?? '',
                      improvedCode: suggestion?.improvedCode ?? '',
                      ...(suggestion?.language == null
                          ? {}
                          : { language: suggestion.language }),
                      ...(suggestion?.label == null
                          ? {}
                          : { label: suggestion.label }),
                      ...(suggestion?.oneSentenceSummary == null
                          ? {}
                          : {
                                oneSentenceSummary:
                                    suggestion.oneSentenceSummary,
                            }),
                      ...(suggestion?.relevantLinesStart == null
                          ? {}
                          : {
                                relevantLinesStart:
                                    suggestion.relevantLinesStart,
                            }),
                      ...(suggestion?.relevantLinesEnd == null
                          ? {}
                          : {
                                relevantLinesEnd: suggestion.relevantLinesEnd,
                            }),
                      ...(suggestion?.severity == null
                          ? {}
                          : { severity: suggestion.severity }),
                  }))
                : [],
        };

        const fallbackUsage = result.usage ?? (result as any).totalUsage;

        logger.log({
            message: `[AGENT-FALLBACK] structured output returned ${output?.suggestions?.length ?? 0} suggestions (input=${fallbackUsage?.inputTokens ?? 0}, output=${fallbackUsage?.outputTokens ?? 0})`,
            context: 'AgentLoop',
        });

        return {
            findings: output as FindingsOutput,
            usage: {
                inputTokens: fallbackUsage?.inputTokens ?? 0,
                outputTokens: fallbackUsage?.outputTokens ?? 0,
                reasoningTokens: fallbackUsage?.reasoningTokens ?? 0,
                totalTokens:
                    fallbackUsage?.totalTokens ??
                    (fallbackUsage?.inputTokens ?? 0) +
                        (fallbackUsage?.outputTokens ?? 0),
            },
        };
    } catch (error) {
        logger.error({
            message: `[AGENT-FALLBACK] generateObject failed`,
            context: 'AgentLoop',
            error,
        });
        return null;
    }
}

// Tools are defined in agent-tools.factory.ts (buildAgentTools)
