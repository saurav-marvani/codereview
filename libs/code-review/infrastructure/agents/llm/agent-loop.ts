import { buildAgentTools } from './agent-tools.factory';
/**
 * Simple agent loop using Vercel AI SDK with native function calling.
 *
 * 1. `generateText` with tools — model investigates using BYOK model
 * 2. Parse JSON from response text — zero cost if model cooperates
 * 3. If JSON parse fails — `generateText` with `Output.object` (cheap model) to structure the text
 */
import { generateText, stepCountIs, Output, type LanguageModel } from 'ai';
import { z } from 'zod';
import { createLogger } from '@kodus/flow';
import { EnhancedJSONParser } from '@kodus/flow';
import { BYOKConfig } from '@kodus/kodus-common/llm';
import { getInternalModel } from './byok-to-vercel';
import { RemoteCommands } from '../../adapters/services/collectCrossFileContexts.service';
import { DocumentationSearchAdapter } from '../tools/sandbox-tools';

const logger = createLogger('AgentLoop');

const MAX_STEPS = 35;
const AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max per agent to prevent hanging on slow/dead providers

/** Schema for structured output */
const suggestionSchema = z.object({
    relevantFile: z.string(),
    language: z.string().optional(),
    suggestionContent: z.string(),
    existingCode: z.string(),
    improvedCode: z.string(),
    oneSentenceSummary: z.string().optional(),
    relevantLinesStart: z.number().optional(),
    relevantLinesEnd: z.number().optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
});

const findingsSchema = z.object({
    reasoning: z.string(),
    suggestions: z.array(suggestionSchema),
});

export type FindingsOutput = z.infer<typeof findingsSchema>;

export interface AgentLoopInput {
    model: LanguageModel;
    systemPrompt: string;
    userPrompt: string;
    remoteCommands: RemoteCommands;
    documentationSearchService?: DocumentationSearchAdapter;
    documentationSearchOptions?: Record<string, unknown>;
    byokConfig?: BYOKConfig;
    maxSteps?: number;
    onStepFinish?: (event: any) => void;
}

export interface AgentLoopOutput {
    findings: FindingsOutput;
    text: string;
    steps: number;
    toolCalls: Array<{ tool: string; args: Record<string, unknown> }>;
    finishReason: string;
    /** Whether findings came from direct JSON parse or fallback generateObject */
    source: 'json-parse' | 'generate-object' | 'empty';
    usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    };
}

/**
 * Run the agent loop with native function calling.
 */
export async function runAgentLoop(
    input: AgentLoopInput,
): Promise<AgentLoopOutput> {
    const tools = buildAgentTools(
        input.remoteCommands,
        input.documentationSearchService,
        input.documentationSearchOptions,
    );

    const allToolCalls: AgentLoopOutput['toolCalls'] = [];
    let stepCount = 0;
    let lastStepText = ''; // Capture text from intermediate steps for timeout recovery
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    // Timeout: 5 minutes max per agent to prevent hanging on slow/dead providers
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
        result = await generateText({
            model: input.model,
            abortSignal: abortController.signal,
            system: input.systemPrompt,
            prompt: input.userPrompt,
            tools,
            stopWhen: stepCountIs(input.maxSteps || MAX_STEPS),
            // Last 2 steps: force text response (prevent infinite tool loops)
            prepareStep: ({ stepNumber }: any) => {
                const maxSteps = input.maxSteps || MAX_STEPS;
                const forceTextAfter = maxSteps - 2;

                if (stepNumber >= forceTextAfter) {
                    logger.log({
                        message: `[AGENT-FORCE-TEXT] step=${stepNumber}/${maxSteps} — disabling tools, forcing text response`,
                        context: 'AgentLoop',
                    });
                    return { toolChoice: 'none' as const };
                }
                return {};
            },
            onStepFinish: (event: any) => {
                stepCount++;

                if (event.toolCalls) {
                    for (const tc of event.toolCalls) {
                        const args =
                            (tc as any).args || (tc as any).input || {};
                        allToolCalls.push({ tool: tc.toolName, args });

                        const toolResult = (event.toolResults || []).find(
                            (tr: any) =>
                                tr.toolCallId === tc.toolCallId ||
                                tr.toolCallId === (tc as any).id,
                        );
                        const resultStr = toolResult?.result
                            ? String(toolResult.result)
                            : '';

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
                }

                input.onStepFinish?.(event);
            },
        });
    } catch (error) {
        clearTimeout(timeoutHandle);
        if (abortController.signal.aborted) {
            // Try to recover findings from the last text the model produced before timeout
            let findings: FindingsOutput | null = null;
            let source: AgentLoopOutput['source'] = 'empty';

            if (lastStepText) {
                // Strategy 1: Try to parse JSON directly (safe — no hallucination risk)
                findings = tryParseFindings(lastStepText);
                if (findings && findings.suggestions.length > 0) {
                    source = 'json-parse';
                    logger.log({
                        message: `[AGENT-TIMEOUT-RECOVERY] Recovered ${findings.suggestions.length} suggestions from last step text (${lastStepText.length} chars)`,
                        context: 'AgentLoop',
                    });
                }
                // Strategy 2: Only use fallback LLM if text clearly contains findings
                // (not just investigation text). This prevents the LLM from fabricating
                // suggestions to fill the schema when the agent was still investigating.
                if (
                    !findings &&
                    lastStepText.length > 100 &&
                    looksLikeFindings(lastStepText)
                ) {
                    try {
                        findings = await structureWithFallbackModel(
                            lastStepText,
                            input.byokConfig,
                        );
                        if (findings && findings.suggestions.length > 0) {
                            source = 'generate-object';
                            logger.log({
                                message: `[AGENT-TIMEOUT-RECOVERY] Recovered ${findings.suggestions.length} suggestions via fallback model`,
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
                    totalTokens: totalInputTokens + totalOutputTokens,
                },
            };
        }
        throw error;
    }
    clearTimeout(timeoutHandle);

    const finalText = result.text || '';

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

        findings = await structureWithFallbackModel(
            finalText,
            input.byokConfig,
        );
        source = findings ? 'generate-object' : 'empty';
    }

    if (!findings) {
        findings = { reasoning: finalText || 'No findings', suggestions: [] };
        source = 'empty';
    }

    return {
        findings,
        text: finalText,
        steps: result.steps?.length ?? 0,
        toolCalls: allToolCalls,
        finishReason: result.finishReason,
        source,
        usage: {
            inputTokens:
                (result as any).totalUsage?.inputTokens ??
                result.usage?.inputTokens ??
                0,
            outputTokens:
                (result as any).totalUsage?.outputTokens ??
                result.usage?.outputTokens ??
                0,
            totalTokens:
                (result as any).totalUsage?.totalTokens ??
                result.usage?.totalTokens ??
                0,
        },
    };
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
        /\b(severity|critical|high|medium)\b/,
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
): Promise<FindingsOutput | null> {
    try {
        const internalModel = getInternalModel(byokConfig);

        if (!internalModel) {
            logger.warn({
                message:
                    '[AGENT-FALLBACK] No internal model available for fallback',
                context: 'AgentLoop',
            });
            return null;
        }

        const result: any = await generateText({
            model: internalModel as any,
            output: Output.object({ schema: findingsSchema }) as any,
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

For each issue found, extract: relevantFile, language, suggestionContent (full description), existingCode, improvedCode, oneSentenceSummary, relevantLinesStart, relevantLinesEnd, severity (critical/high/medium/low).`,
        });

        const output: any = (result as any).object ?? (result as any).output;

        logger.log({
            message: `[AGENT-FALLBACK] structured output returned ${output?.suggestions?.length ?? 0} suggestions`,
            context: 'AgentLoop',
        });

        return output as FindingsOutput;
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
