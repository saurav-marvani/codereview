import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';

import {
    CodeSuggestion,
    ReviewOptions,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { BugAgentProvider } from './bug-agent.provider';
import { SecurityAgentProvider } from './security-agent.provider';
import { PerformanceAgentProvider } from './performance-agent.provider';
import {
    ReviewAgentInput,
    ReviewAgentOutput,
} from './base-code-review-agent.provider';

export interface OrchestratorInput extends ReviewAgentInput {
    reviewOptions: ReviewOptions;
}

export interface OrchestratorOutput {
    suggestions: Partial<CodeSuggestion>[];
    agentResults: ReviewAgentOutput[];
    totalDurationMs: number;
}

/**
 * Orchestrates the code review agents.
 *
 * - Checks which categories are enabled in reviewOptions
 * - Dispatches enabled agents in parallel
 * - Collects and deduplicates results
 */
@Injectable()
export class ReviewOrchestratorService {
    private readonly logger = createLogger(ReviewOrchestratorService.name);

    constructor(
        private readonly bugAgent: BugAgentProvider,
        private readonly securityAgent: SecurityAgentProvider,
        private readonly performanceAgent: PerformanceAgentProvider,
    ) {}

    async execute(input: OrchestratorInput): Promise<OrchestratorOutput> {
        const startTime = Date.now();
        const { reviewOptions, ...agentInput } = input;

        // Determine which agents to run based on review options
        const agentTasks: Array<{
            name: string;
            provider: BugAgentProvider | SecurityAgentProvider | PerformanceAgentProvider;
        }> = [];

        if (reviewOptions.bug !== false) {
            agentTasks.push({ name: 'bug', provider: this.bugAgent });
        }
        if (reviewOptions.security !== false) {
            agentTasks.push({
                name: 'security',
                provider: this.securityAgent,
            });
        }
        if (reviewOptions.performance !== false) {
            agentTasks.push({
                name: 'performance',
                provider: this.performanceAgent,
            });
        }

        if (agentTasks.length === 0) {
            this.logger.log({
                message: `[AGENT] No agent categories enabled, skipping agent review for PR#${agentInput.prNumber}`,
                context: ReviewOrchestratorService.name,
            });
            return {
                suggestions: [],
                agentResults: [],
                totalDurationMs: Date.now() - startTime,
            };
        }

        this.logger.log({
            message: `[AGENT] Dispatching ${agentTasks.length} agents in parallel for PR#${agentInput.prNumber}: ${agentTasks.map((t) => t.name).join(', ')}`,
            context: ReviewOrchestratorService.name,
            metadata: {
                prNumber: agentInput.prNumber,
                agents: agentTasks.map((t) => t.name),
                filesCount: agentInput.changedFiles.length,
            },
        });

        // Dispatch all agents in parallel
        const results = await Promise.allSettled(
            agentTasks.map(async (task) => {
                try {
                    return await task.provider.execute(agentInput);
                } catch (error) {
                    this.logger.error({
                        message: `[AGENT] ${task.name} agent failed for PR#${agentInput.prNumber}`,
                        context: ReviewOrchestratorService.name,
                        error,
                        metadata: { agent: task.name, prNumber: agentInput.prNumber },
                    });
                    throw error;
                }
            }),
        );

        // Collect successful results
        const agentResults: ReviewAgentOutput[] = [];
        const allSuggestions: Partial<CodeSuggestion>[] = [];

        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            const agentName = agentTasks[i].name;

            if (result.status === 'fulfilled') {
                agentResults.push(result.value);
                allSuggestions.push(...result.value.suggestions);
                this.logger.log({
                    message: `[AGENT] ${agentName} returned ${result.value.suggestions.length} suggestions in ${result.value.durationMs}ms`,
                    context: ReviewOrchestratorService.name,
                });
            } else {
                this.logger.error({
                    message: `[AGENT] ${agentName} failed: ${result.reason?.message || 'Unknown error'}`,
                    context: ReviewOrchestratorService.name,
                    error: result.reason,
                });
            }
        }

        // Deduplicate cross-agent suggestions by file + line range overlap
        const deduped = this.deduplicateSuggestions(allSuggestions);

        // Log which suggestions were removed by dedup
        if (deduped.length < allSuggestions.length) {
            const dedupedSet = new Set(deduped);
            const removed = allSuggestions.filter((s) => !dedupedSet.has(s));
            for (const s of removed) {
                this.logger.log({
                    message: `[DEDUP-REMOVED] PR#${agentInput.prNumber} ${s.relevantFile}:${s.relevantLinesStart}-${s.relevantLinesEnd} [${s.label}/${s.severity}] "${s.oneSentenceSummary || s.suggestionContent?.substring(0, 80)}"`,
                    context: ReviewOrchestratorService.name,
                });
            }
        }

        const totalDurationMs = Date.now() - startTime;

        this.logger.log({
            message: `[AGENT] Orchestrator completed for PR#${agentInput.prNumber}: ${deduped.length} suggestions (${allSuggestions.length} before dedup) in ${totalDurationMs}ms`,
            context: ReviewOrchestratorService.name,
            metadata: {
                prNumber: agentInput.prNumber,
                totalSuggestions: allSuggestions.length,
                afterDedup: deduped.length,
                totalDurationMs,
            },
        });

        return {
            suggestions: deduped,
            agentResults,
            totalDurationMs,
        };
    }

    /**
     * Deduplicate suggestions from different agents that target the same
     * file + overlapping line range. Keeps the one with higher severity.
     */
    private deduplicateSuggestions(
        suggestions: Partial<CodeSuggestion>[],
    ): Partial<CodeSuggestion>[] {
        if (suggestions.length <= 1) return suggestions;

        const severityOrder: Record<string, number> = {
            critical: 4,
            high: 3,
            medium: 2,
            low: 1,
        };

        // Group by file
        const byFile = new Map<string, Partial<CodeSuggestion>[]>();
        for (const s of suggestions) {
            const file = s.relevantFile || '';
            if (!byFile.has(file)) byFile.set(file, []);
            byFile.get(file)!.push(s);
        }

        const result: Partial<CodeSuggestion>[] = [];

        for (const [, fileSuggestions] of byFile) {
            // Sort by severity descending so higher severity is kept
            fileSuggestions.sort(
                (a, b) =>
                    (severityOrder[b.severity || 'medium'] || 2) -
                    (severityOrder[a.severity || 'medium'] || 2),
            );

            const kept: Partial<CodeSuggestion>[] = [];

            for (const candidate of fileSuggestions) {
                const overlaps = kept.some((existing) =>
                    this.linesOverlap(existing, candidate),
                );
                if (!overlaps) {
                    kept.push(candidate);
                }
                // If overlaps, the higher-severity one is already in `kept`
            }

            result.push(...kept);
        }

        return result;
    }

    private linesOverlap(
        a: Partial<CodeSuggestion>,
        b: Partial<CodeSuggestion>,
    ): boolean {
        const aStart = a.relevantLinesStart ?? 0;
        const aEnd = a.relevantLinesEnd ?? aStart;
        const bStart = b.relevantLinesStart ?? 0;
        const bEnd = b.relevantLinesEnd ?? bStart;

        if (aStart === 0 || bStart === 0) return false;

        return aStart <= bEnd && bStart <= aEnd;
    }
}
