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
import { z } from 'zod';
import { createLogger } from '@kodus/flow';
import { EnhancedJSONParser } from '@kodus/flow';
import { BYOKConfig } from '@kodus/kodus-common/llm';
import { getInternalModel } from './byok-to-vercel';
import { RemoteCommands } from '../../adapters/services/collectCrossFileContexts.service';
import { DocumentationSearchAdapter } from '../tools/sandbox-tools';

const logger = createLogger('AgentLoop');

const MAX_STEPS = 35;
const AGENT_TIMEOUT_MS = 8 * 60 * 1000; // 8 minutes max per agent — some models (Gemini) need 30+ tool calls

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
    severity: z.enum(['critical', 'high', 'medium', 'low']).optional(), // V2 compat
    level: z.enum(['issue', 'warning']).optional(), // V3: binary classification
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
    agentName?: string; // e.g. 'kodus-bug-review-agent' — used for LangSmith trace identification
    maxSteps?: number;
    onStepFinish?: (event: any) => void;
}

export interface AgentLoopOutput {
    findings: FindingsOutput;
    text: string;
    steps: number;
    toolCalls: Array<{ tool: string; toolName?: string; args: Record<string, unknown>; result?: string }>;
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
    const allStepTexts: string[] = []; // Accumulate ALL text steps for better timeout recovery
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

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
        result = await generateText({
            model: input.model,
            abortSignal: abortController.signal,
            system: input.systemPrompt,
            prompt: input.userPrompt,
            tools,
            stopWhen: stepCountIs(input.maxSteps || MAX_STEPS),
            // Last 2 steps: remove tools entirely to force text response.
            // toolChoice: 'none' doesn't work with all providers (e.g., Gemini ignores it).
            // Removing tools entirely guarantees the model can only respond with text.
            prepareStep: ({ stepNumber }: any) => {
                const maxSteps = input.maxSteps || MAX_STEPS;
                const forceTextAfter = maxSteps - 2;

                if (stepNumber >= forceTextAfter) {
                    logger.log({
                        message: `[AGENT-FORCE-TEXT] step=${stepNumber}/${maxSteps} — removing tools, forcing text response`,
                        context: 'AgentLoop',
                    });
                    return { toolChoice: 'none' as const, activeTools: [] };
                }
                return {};
            },
            onStepFinish: (event: any) => {
                stepCount++;

                if (event.toolCalls) {
                    for (const tc of event.toolCalls) {
                        const args =
                            (tc as any).args || (tc as any).input || {};
                        const toolResult = (event.toolResults || []).find(
                            (tr: any) =>
                                tr.toolCallId === tc.toolCallId ||
                                tr.toolCallId === (tc as any).id,
                        );
                        const resultStr = toolResult?.result
                            ? String(toolResult.result)
                            : '';
                        allToolCalls.push({
                            tool: tc.toolName,
                            toolName: tc.toolName,
                            args,
                            result: resultStr.substring(0, 300),
                        });

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
                            input.byokConfig,
                        );
                        if (fallbackResult && fallbackResult.findings.suggestions.length > 0) {
                            findings = fallbackResult.findings;
                            totalInputTokens += fallbackResult.usage.inputTokens;
                            totalOutputTokens += fallbackResult.usage.outputTokens;
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
                    totalTokens: totalInputTokens + totalOutputTokens,
                },
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
            // Build a summary of what the agent investigated
            const investigationSummary = allToolCalls
                .map((tc) => {
                    const args =
                        typeof tc.args === 'string'
                            ? tc.args
                            : JSON.stringify(tc.args);
                    const resultStr =
                        typeof tc.result === 'string'
                            ? tc.result?.substring(0, 200)
                            : '';
                    return `${tc.toolName}(${args.substring(0, 150)}) → ${resultStr || '(empty)'}`;
                })
                .join('\n');

            const secondChanceResult = await generateText({
                model: input.model,
                system: input.systemPrompt,
                prompt: `You have already investigated this code review task using ${allToolCalls.length} tool calls. Here is a summary of your investigation:

<InvestigationLog>
${investigationSummary.substring(0, 8000)}
</InvestigationLog>

Based on your investigation above, respond NOW with your findings as a JSON block. Do NOT call any tools. Respond with ONLY the JSON:

\`\`\`json
{
  "reasoning": "Summary of what you investigated and found",
  "suggestions": [
    {
      "relevantFile": "path/to/file",
      "language": "java",
      "suggestionContent": "Description of the issue with evidence",
      "existingCode": "problematic code",
      "improvedCode": "fixed code",
      "oneSentenceSummary": "Brief summary",
      "relevantLinesStart": 10,
      "relevantLinesEnd": 15,
      "severity": "critical|high|medium|low"
    }
  ]
}
\`\`\`

If no issues were found during investigation, respond with \`{"reasoning": "...", "suggestions": []}\`.`,
                stopWhen: stepCountIs(1), // No tools, just respond
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
            input.byokConfig,
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
        findings = { reasoning: finalText || 'No findings', suggestions: [] };
        source = 'empty';
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

    // totalInputTokens/totalOutputTokens include second-chance + fallback overhead
    // Subtract the per-step accumulation (already in base) to avoid double-counting,
    // then add only the extra tokens from second-chance and fallback calls.
    // Since totalInputTokens starts at 0 and accumulates per-step + extras,
    // and baseInputTokens is the SDK's own total, use whichever is larger.
    const finalInputTokens = Math.max(baseInputTokens, totalInputTokens);
    const finalOutputTokens = Math.max(baseOutputTokens, totalOutputTokens);

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
            totalTokens: finalInputTokens + finalOutputTokens,
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
        /\b(severity|critical|high|medium|issue|warning)\b/,
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
): Promise<{ findings: FindingsOutput; usage: { inputTokens: number; outputTokens: number; totalTokens: number } } | null> {
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
            output: Output.object({
                schema: jsonSchema({
                    type: 'object',
                    properties: {
                        reasoning: { type: 'string' },
                        suggestions: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    relevantFile: { type: 'string' },
                                    language: { type: 'string' },
                                    suggestionContent: { type: 'string' },
                                    existingCode: { type: 'string' },
                                    improvedCode: { type: 'string' },
                                    oneSentenceSummary: { type: 'string' },
                                    relevantLinesStart: { type: 'number' },
                                    relevantLinesEnd: { type: 'number' },
                                    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
                                    level: { type: 'string', enum: ['issue', 'warning'] },
                                },
                                required: ['relevantFile', 'suggestionContent', 'existingCode', 'improvedCode'],
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

For each issue found, extract: relevantFile, language, suggestionContent (full description), existingCode, improvedCode, oneSentenceSummary, relevantLinesStart, relevantLinesEnd, severity (critical/high/medium/low), level (issue or warning).`,
        });

        const output: any = (result as any).object ?? (result as any).output;

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
                totalTokens: fallbackUsage?.totalTokens ?? (fallbackUsage?.inputTokens ?? 0) + (fallbackUsage?.outputTokens ?? 0),
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
