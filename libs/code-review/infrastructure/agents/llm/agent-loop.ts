/**
 * Simple agent loop using Vercel AI SDK with native function calling.
 *
 * 1. `generateText` with tools — model investigates using BYOK model
 * 2. Parse JSON from response text — zero cost if model cooperates
 * 3. If JSON parse fails — `generateText` with `Output.object` (cheap model) to structure the text
 */
import {
    generateText,
    tool,
    stepCountIs,
    Output,
    type LanguageModel,
} from 'ai';
import { z } from 'zod';
import { createLogger } from '@kodus/flow';
import { EnhancedJSONParser } from '@kodus/flow';
import { BYOKConfig } from '@kodus/kodus-common/llm';
import { getInternalModel } from './byok-to-vercel';
import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { DocumentationSearchAdapter } from '../tools/sandbox-tools';

const logger = createLogger('AgentLoop');

const MAX_STEPS = 35;
const MAX_GREP_MATCHES = 30;
const MAX_READ_LENGTH = 30_000;
const MAX_LIST_LENGTH = 15_000;
const MAX_SHELL_OUTPUT = 15_000;

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
    const tools = buildTools(
        input.remoteCommands,
        input.documentationSearchService,
        input.documentationSearchOptions,
    );

    const allToolCalls: AgentLoopOutput['toolCalls'] = [];
    let stepCount = 0;

    // Timeout: 5 minutes max per agent to prevent hanging on slow/dead providers
    const AGENT_TIMEOUT_MS = 5 * 60 * 1000;
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
            // After 80% of steps, disable tools and force the model to respond with text.
            // This prevents models that keep calling tools indefinitely from never producing output.
            prepareStep: ({ stepNumber }: any) => {
                const maxSteps = input.maxSteps || MAX_STEPS;
                const forceTextAfter = maxSteps - 2; // Last 2 steps: force text response
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
                        const args = (tc as any).args || (tc as any).input || {};
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

                input.onStepFinish?.(event);
            },
        });
    } catch (error) {
        clearTimeout(timeoutHandle);
        if (abortController.signal.aborted) {
            logger.warn({
                message: `[AGENT-TIMEOUT] Agent timed out after ${AGENT_TIMEOUT_MS / 1000}s (${stepCount} steps, ${allToolCalls.length} tool calls)`,
                context: 'AgentLoop',
            });
            return {
                findings: { reasoning: 'Agent timed out', suggestions: [] },
                text: '',
                steps: stepCount,
                toolCalls: allToolCalls,
                finishReason: 'timeout',
                source: 'empty',
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            };
        }
        throw error;
    }
    clearTimeout(timeoutHandle);

    const finalText = result.text || '';

    logger.log({
        message: `[AGENT-FINAL] steps=${result.steps?.length ?? 0} finishReason=${result.finishReason} textLength=${finalText.length} hasJSON=${finalText.includes('"suggestions"')}`,
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

        findings = await structureWithFallbackModel(finalText, input.byokConfig);
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
            inputTokens: (result as any).totalUsage?.inputTokens ?? result.usage?.inputTokens ?? 0,
            outputTokens: (result as any).totalUsage?.outputTokens ?? result.usage?.outputTokens ?? 0,
            totalTokens: (result as any).totalUsage?.totalTokens ?? result.usage?.totalTokens ?? 0,
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
                message: '[AGENT-FALLBACK] No internal model available for fallback',
                context: 'AgentLoop',
            });
            return null;
        }

        const result = await generateText({
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

        const output = (result as any).object ?? (result as any).output;

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

/**
 * Build the tool set for the agent from RemoteCommands.
 */
function buildTools(
    remoteCommands: RemoteCommands,
    docSearchService?: DocumentationSearchAdapter,
    docSearchOptions?: Record<string, unknown>,
): Record<string, any> {
    const tools: Record<string, any> = {
        grep: (tool as any)({
            description:
                'Search the repository for a regex pattern. Returns matching lines with file paths.',
            parameters: z.object({
                pattern: z.string().describe('Regex pattern to search for'),
                glob: z
                    .string()
                    .optional()
                    .describe('Optional glob to filter files (e.g. "*.ts")'),
                path: z
                    .string()
                    .optional()
                    .describe('Optional directory to scope the search'),
            }),
            execute: async ({ pattern, glob, path }: any) => {
                let result = await remoteCommands.grep(
                    pattern,
                    path || '.',
                    glob,
                );
                const lines = result.split('\n');
                if (lines.length > MAX_GREP_MATCHES) {
                    result =
                        lines.slice(0, MAX_GREP_MATCHES).join('\n') +
                        `\n... (${lines.length - MAX_GREP_MATCHES} more matches)`;
                }
                return result;
            },
        }),

        readFile: (tool as any)({
            description:
                'Read file contents. Use startLine/endLine for specific sections. Omit both for entire file.',
            parameters: z.object({
                path: z.string().describe('File path relative to repo root'),
                startLine: z.number().optional().describe('Start line (1-based)'),
                endLine: z.number().optional().describe('End line (1-based)'),
            }),
            execute: async ({ path, startLine, endLine }: any) => {
                let result = await remoteCommands.read(
                    path,
                    startLine || 0,
                    endLine || 0,
                );
                if (result.length > MAX_READ_LENGTH) {
                    result =
                        result.substring(0, MAX_READ_LENGTH) +
                        `\n... (truncated)`;
                }
                return result;
            },
        }),

        listDir: (tool as any)({
            description:
                'List files and directories. Use maxDepth to control recursion (default 2).',
            parameters: z.object({
                path: z
                    .string()
                    .optional()
                    .describe('Directory path (default: ".")'),
                maxDepth: z
                    .number()
                    .optional()
                    .describe('Max recursion depth (default: 2, max: 4)'),
            }),
            execute: async ({ path, maxDepth }: any) => {
                const depth = Math.min(maxDepth || 2, 4);
                let result = await remoteCommands.listDir(path || '.', depth);
                if (result.length > MAX_LIST_LENGTH) {
                    result =
                        result.substring(0, MAX_LIST_LENGTH) +
                        `\n... (truncated)`;
                }
                return result;
            },
        }),
    };

    // Add exec-based tools if available
    if (remoteCommands.exec) {
        const exec = remoteCommands.exec;

        tools.shell = (tool as any)({
            description:
                'Execute a read-only shell command. Allowed: tsc, eslint, npx, python, go vet, cargo check.',
            parameters: z.object({
                command: z
                    .string()
                    .describe('Command to run (e.g. "npx tsc --noEmit src/file.ts")'),
            }),
            execute: async ({ command }: any) => {
                const ALLOWED = [
                    'tsc ', 'npx ', 'eslint ', 'python ', 'python3 ',
                    'go ', 'cargo ', 'cat ', 'wc ', 'head ', 'tail ', 'file ',
                ];
                const isAllowed = ALLOWED.some((p) =>
                    command.trimStart().startsWith(p),
                );
                if (!isAllowed) {
                    return `Command not allowed. Allowed prefixes: ${ALLOWED.join(', ')}`;
                }
                if (/[;&|`$>]|\brm\b|\bsudo\b/.test(command)) {
                    return 'Command contains blocked patterns.';
                }
                const { stdout } = await exec(command);
                return stdout.length > MAX_SHELL_OUTPUT
                    ? stdout.substring(0, MAX_SHELL_OUTPUT) + '\n... (truncated)'
                    : stdout;
            },
        });
    }

    // Add searchDocs if available
    if (docSearchService) {
        tools.searchDocs = (tool as any)({
            description:
                'Search external documentation for a package/library.',
            parameters: z.object({
                packageName: z.string().describe('Package name (e.g. "express")'),
                query: z.string().describe('What to search for in docs'),
            }),
            execute: async ({ packageName, query }: any) => {
                if (!packageName || !query)
                    return 'Both packageName and query are required.';
                try {
                    const results = await docSearchService.searchByFilePlan(
                        { agent: { queryTasks: [{ packageName, query }] } },
                        docSearchOptions,
                    );
                    const docs = results['agent'] || [];
                    if (docs.length === 0)
                        return `No docs found for "${packageName}": ${query}`;
                    return docs
                        .map((d) => `### ${d.title}\n${d.url}\n${d.snippet}`)
                        .join('\n---\n');
                } catch (e) {
                    return `Doc search error: ${e instanceof Error ? e.message : String(e)}`;
                }
            },
        });
    }

    return tools;
}
