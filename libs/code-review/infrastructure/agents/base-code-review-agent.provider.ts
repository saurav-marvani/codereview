import { createLogger } from '@kodus/flow';
import { BYOKConfig, PromptRunnerService } from '@kodus/kodus-common/llm';
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
import { DocumentationSearchAdapter } from './tools/sandbox-tools';
import { byokToVercelModel, getModelName } from './llm/byok-to-vercel';
import { runAgentLoop } from './llm/agent-loop';

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
export interface ReviewAgentInput {
    organizationAndTeamData: OrganizationAndTeamData;
    changedFiles: FileChange[];
    remoteCommands: RemoteCommands;
    prNumber: number;
    repositoryFullName: string;
    languageResultPrompt: string;
    memoryRules?: Partial<IKodyRule>[];
    v2PromptOverrides?: CodeReviewConfig['v2PromptOverrides'];
    generationMain?: string;
    documentationSearchService?: DocumentationSearchAdapter;
}

/**
 * Output from a single agent execution.
 */
export interface ReviewAgentOutput {
    suggestions: Partial<CodeSuggestion>[];
    agentName: string;
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
    protected byokConfig?: BYOKConfig;

    constructor(
        protected readonly promptRunnerService: PromptRunnerService,
        protected readonly permissionValidationService: PermissionValidationService,
        protected readonly observabilityService: ObservabilityService,
    ) {}

    protected abstract getIdentity(): ReviewAgentIdentity;
    protected abstract getCategoryPrompt(): string;
    protected abstract getCategoryLabel(): string;

    /**
     * Execute the agent against the provided changed files.
     */
    async execute(input: ReviewAgentInput): Promise<ReviewAgentOutput> {
        const startTime = Date.now();
        const identity = this.getIdentity();

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

        // Resolve BYOK config
        this.byokConfig =
            await this.permissionValidationService.getBYOKConfig(
                input.organizationAndTeamData,
            );

        // Create Vercel AI SDK model from BYOK config
        const model = byokToVercelModel(this.byokConfig);
        const modelName = getModelName(this.byokConfig);

        this.agentLogger.log({
            message: `[AGENT] ${identity.name} using model: ${modelName}`,
            context: identity.name,
        });

        const systemPrompt = this.buildSystemPrompt(input);
        const userPrompt = this.buildUserPrompt(input);

        this.agentLogger.log({
            message: `[AGENT] ${identity.name} prompt context: memoryRules=${input.memoryRules?.length ?? 0}, overrides=${!!input.v2PromptOverrides}, language=${input.languageResultPrompt || 'default'}`,
            context: identity.name,
        });

        try {
            const agentResult = await runAgentLoop({
                model,
                systemPrompt,
                userPrompt,
                remoteCommands: input.remoteCommands,
                documentationSearchService:
                    input.documentationSearchService,
                documentationSearchOptions: {
                    organizationAndTeamData:
                        input.organizationAndTeamData,
                    byokConfig: this.byokConfig,
                },
                byokConfig: this.byokConfig,
                onStepFinish: (step: any) => {
                    if (step.toolCalls) {
                        for (const tc of step.toolCalls) {
                            this.agentLogger.log({
                                message: `[AGENT-TOOL] PR#${input.prNumber} ${identity.name} tool=${tc.toolName}`,
                                context: identity.name,
                            });
                        }
                    }
                },
            });

            const durationMs = Date.now() - startTime;

            // Record token usage to observability span
            // Uses runInSpan directly (not runLLMInSpan which depends on LangChain callbacks)
            try {
                const span = this.observabilityService.startSpan(
                    `${identity.name}::review`,
                    {
                        'gen_ai.usage.input_tokens': agentResult.usage.inputTokens,
                        'gen_ai.usage.output_tokens': agentResult.usage.outputTokens,
                        'gen_ai.usage.total_tokens': agentResult.usage.totalTokens,
                        'gen_ai.response.model': modelName,
                        'gen_ai.run.name': `code-review-${this.getCategoryLabel()}`,
                        type: this.byokConfig ? 'byok' : 'system',
                        organizationId:
                            input.organizationAndTeamData?.organizationId,
                        teamId: input.organizationAndTeamData?.teamId,
                        prNumber: input.prNumber,
                        steps: agentResult.steps,
                        toolCalls: agentResult.toolCalls.length,
                        finishReason: agentResult.finishReason,
                        source: agentResult.source,
                        durationMs,
                    },
                );
                span?.end?.();
            } catch {
                // Observability is best-effort
            }

            // Map findings to CodeSuggestion format
            const validFiles = new Set(
                input.changedFiles.map((f) => f.filename),
            );
            const rawSuggestions = (
                agentResult.findings?.suggestions || []
            ).filter(
                (s) =>
                    s.relevantFile &&
                    s.suggestionContent &&
                    validFiles.has(s.relevantFile),
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
                label: this.getCategoryLabel(),
                severity: s.severity || 'medium',
                llmPrompt: s.suggestionContent,
            }));

            this.agentLogger.log({
                message: `[AGENT] ${identity.name} completed for PR#${input.prNumber}: ${suggestions.length} suggestions in ${durationMs}ms (source=${agentResult.source}, steps=${agentResult.steps}, tools=${agentResult.toolCalls.length}, tokens=${agentResult.usage.totalTokens})`,
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
                    tokens: agentResult.usage.totalTokens,
                    finishReason: agentResult.finishReason,
                    model: modelName,
                },
            });

            return {
                suggestions,
                agentName: identity.name,
                turnsUsed: agentResult.steps,
                durationMs,
            };
        } catch (error) {
            const durationMs = Date.now() - startTime;
            this.agentLogger.error({
                message: `[AGENT] ${identity.name} failed for PR#${input.prNumber} after ${durationMs}ms`,
                context: identity.name,
                error,
                metadata: {
                    prNumber: input.prNumber,
                    durationMs,
                    model: modelName,
                },
            });
            return {
                suggestions: [],
                agentName: identity.name,
                turnsUsed: 0,
                durationMs,
            };
        }
    }

    private buildSystemPrompt(input: ReviewAgentInput): string {
        const identity = this.getIdentity();
        const categoryPrompt = this.getCategoryPrompt();
        const overridesSection = this.formatOverrides(input);
        const memoryRulesSection = this.formatMemoryRules(input.memoryRules);

        const langInstruction = input.languageResultPrompt
            ? `\nIMPORTANT: Write all review comments in ${input.languageResultPrompt}.`
            : '';

        return `You are ${identity.name}, ${identity.description}.

Date: ${new Date().toLocaleDateString('en-GB')}.

${categoryPrompt}

${overridesSection}

${memoryRulesSection}

## Scope — CRITICAL

You are reviewing ONLY the lines that changed in the diff (lines with + or -).
- Use tools to read surrounding code for CONTEXT, but only report issues in CHANGED lines.
- Do NOT suggest improvements to existing code that was not modified in this PR.
- If unchanged code has a bug, only report it if the PR changes make it worse or newly reachable.
- The \`relevantLinesStart\`/\`relevantLinesEnd\` MUST point to lines shown in the diff hunks (lines starting with + or context lines in the @@ sections).

## How to work

1. **Investigate**: Use tools (grep, readFile, listDir) to understand the CONTEXT around changed code. Search for callers, related code, tests.
2. **Decide**: Only report issues in CHANGED lines that you confirmed with evidence. Skip style opinions, theoretical concerns, and issues in unchanged code.
3. **Respond**: After investigating, respond with a JSON block containing your findings.${langInstruction}`;
    }

    private buildUserPrompt(input: ReviewAgentInput): string {
        const diffsSection = this.formatDiffs(input.changedFiles);

        return `Review the following pull request changes.

${diffsSection}

After investigating with tools, respond with ONLY a JSON block:

\`\`\`json
{
  "reasoning": "Summary of what you investigated and found",
  "suggestions": [
    {
      "relevantFile": "path/to/file.ts",
      "language": "typescript",
      "suggestionContent": "Description of the issue with evidence",
      "existingCode": "problematic code snippet",
      "improvedCode": "fixed code snippet",
      "oneSentenceSummary": "Brief summary",
      "relevantLinesStart": 10,
      "relevantLinesEnd": 15,
      "severity": "critical|high|medium|low"
    }
  ]
}
\`\`\`

If no issues found, respond with \`{"reasoning": "...", "suggestions": []}\`.

RULES:
- You MUST use tools to investigate before responding.
- ONLY report issues in code that was CHANGED in this PR (lines with + or - in the diff).
- Use readFile/grep for context, but do NOT suggest fixes for unchanged code.
- Every suggestion's relevantFile and line numbers MUST match a file and lines from the diff above.`;
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

        const categoryLabel = this.getCategoryLabel();
        const categoryDesc =
            input.v2PromptOverrides?.categories?.descriptions?.[
                categoryLabel as keyof typeof input.v2PromptOverrides.categories.descriptions
            ];
        if (categoryDesc) {
            parts.push(`## Category Guidelines\n${categoryDesc}`);
        }

        // Severity criteria from client config — agent classifies during analysis
        // because it has full context (code, callers, impact)
        const severityFlags = input.v2PromptOverrides?.severity?.flags;
        if (severityFlags) {
            const flags = Object.entries(severityFlags)
                .filter(([, v]) => v)
                .map(([k, v]) => `- **${k}**: ${v}`)
                .join('\n');
            if (flags) {
                parts.push(`## Severity Classification\nClassify each suggestion using these criteria:\n${flags}`);
            }
        }

        const generationMain =
            input.generationMain ??
            input.v2PromptOverrides?.generation?.main;
        if (generationMain) {
            parts.push(`## Writing Guidelines\n${generationMain}`);
        }

        return parts.join('\n\n');
    }

}
