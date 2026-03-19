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

        // No deterministic dedup here — LLM dedup in AgentReviewStage handles it better.
        // Deterministic dedup by line overlap was too aggressive, removing findings from
        // different categories (bug vs security) that happened to be on the same lines.

        const totalDurationMs = Date.now() - startTime;

        this.logger.log({
            message: `[AGENT] Orchestrator completed for PR#${agentInput.prNumber}: ${allSuggestions.length} suggestions in ${totalDurationMs}ms`,
            context: ReviewOrchestratorService.name,
            metadata: {
                prNumber: agentInput.prNumber,
                totalSuggestions: allSuggestions.length,
                totalDurationMs,
            },
        });

        return {
            suggestions: allSuggestions,
            agentResults,
            totalDurationMs,
        };
    }

    /**
     * Deduplicate suggestions from different agents that target the same
     * file + overlapping line range + same category. Only removes true
     * duplicates (same category, high line overlap). Keeps suggestions
     * from different categories even if they overlap in lines — a bug
     * and a security issue on the same line are different findings.
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
                const isDuplicate = kept.some(
                    (existing) =>
                        this.sameCategory(existing, candidate) &&
                        this.highLineOverlap(existing, candidate),
                );
                if (!isDuplicate) {
                    kept.push(candidate);
                }
            }

            result.push(...kept);
        }

        return result;
    }

    /**
     * Check if two suggestions are from the same category (bug, security, performance).
     * Different categories = different findings, even on the same lines.
     */
    private sameCategory(
        a: Partial<CodeSuggestion>,
        b: Partial<CodeSuggestion>,
    ): boolean {
        const catA = (a.label || '').toLowerCase();
        const catB = (b.label || '').toLowerCase();
        if (!catA || !catB) return true; // If no label, assume same to be safe
        return catA === catB;
    }

    /**
     * Check if two suggestions have >70% line overlap.
     * Small overlaps (e.g., adjacent functions) are not duplicates.
     */
    private highLineOverlap(
        a: Partial<CodeSuggestion>,
        b: Partial<CodeSuggestion>,
    ): boolean {
        const aStart = a.relevantLinesStart ?? 0;
        const aEnd = a.relevantLinesEnd ?? aStart;
        const bStart = b.relevantLinesStart ?? 0;
        const bEnd = b.relevantLinesEnd ?? bStart;

        if (aStart === 0 || bStart === 0) return false;

        // No overlap at all
        if (aStart > bEnd || bStart > aEnd) return false;

        // Calculate overlap percentage
        const overlapStart = Math.max(aStart, bStart);
        const overlapEnd = Math.min(aEnd, bEnd);
        const overlapSize = overlapEnd - overlapStart + 1;
        const smallerRange = Math.min(aEnd - aStart + 1, bEnd - bStart + 1);

        // Only deduplicate if >70% of the smaller range overlaps
        return overlapSize / smallerRange > 0.7;
    }
}
