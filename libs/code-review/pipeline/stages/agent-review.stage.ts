import { createLogger } from '@kodus/flow';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { getInternalModel } from '@libs/code-review/infrastructure/agents/llm/byok-to-vercel';

import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { CodeReviewVersion } from '@libs/core/domain/enums/code-review.enum';
import {
    CodeSuggestion,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    ReviewOrchestratorService,
} from '@libs/code-review/infrastructure/agents/review-orchestrator.service';
import { DocumentationSearchAdapter } from '@libs/code-review/infrastructure/agents/tools/sandbox-tools';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

/**
 * Extract valid line ranges from a unified diff patch.
 * Returns an array of [start, end] tuples representing lines on the RIGHT side
 * that GitHub allows for inline comments.
 *
 * For each hunk, we track which RIGHT-side lines exist (context + added).
 * GitHub only allows comments on lines that appear in the diff.
 */
function extractValidDiffLines(patch?: string): Array<[number, number]> {
    if (!patch) return [];

    const ranges: Array<[number, number]> = [];
    const lines = patch.split('\n');
    let rightLine = 0;
    let hunkStart = 0;

    for (const line of lines) {
        // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
        const hunkMatch = line.match(
            /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/,
        );
        if (hunkMatch) {
            // Save previous hunk
            if (hunkStart > 0 && rightLine > hunkStart) {
                ranges.push([hunkStart, rightLine - 1]);
            }
            rightLine = parseInt(hunkMatch[1], 10);
            hunkStart = rightLine;
            continue;
        }

        if (hunkStart === 0) continue; // before first hunk

        if (line.startsWith('-')) {
            // Deleted line — only exists on LEFT side, skip
            continue;
        }

        if (line.startsWith('\\')) {
            // "No newline at end of file" — skip
            continue;
        }

        // Context line (space prefix) or added line (+) — exists on RIGHT
        rightLine++;
    }

    // Save last hunk
    if (hunkStart > 0 && rightLine > hunkStart) {
        ranges.push([hunkStart, rightLine - 1]);
    }

    return ranges;
}

/**
 * Snap suggestion line numbers to the closest valid diff range.
 * If the suggestion lines don't overlap any diff range, finds the nearest one.
 */
function snapLinesToDiff(
    suggestion: Partial<CodeSuggestion>,
    validRanges: Array<[number, number]>,
): Partial<CodeSuggestion> {
    if (validRanges.length === 0) return suggestion;

    const start = suggestion.relevantLinesStart;
    const end = suggestion.relevantLinesEnd;

    if (!start || !end) {
        // No lines specified — use the first valid range
        const [rs, re] = validRanges[0];
        return {
            ...suggestion,
            relevantLinesStart: rs,
            relevantLinesEnd: Math.min(re, rs + 5),
        };
    }

    // Find all overlapping ranges and pick the best one (largest overlap)
    let bestOverlap: [number, number] | null = null;
    let bestOverlapSize = 0;

    for (const [rs, re] of validRanges) {
        if (start <= re && end >= rs) {
            const overlapStart = Math.max(start, rs);
            const overlapEnd = Math.min(end, re);
            const overlapSize = overlapEnd - overlapStart;
            if (overlapSize > bestOverlapSize) {
                bestOverlapSize = overlapSize;
                bestOverlap = [overlapStart, overlapEnd];
            }
        }
    }

    if (bestOverlap) {
        return {
            ...suggestion,
            relevantLinesStart: bestOverlap[0],
            relevantLinesEnd: bestOverlap[1],
        };
    }

    // No overlap — find the closest range
    let closestRange = validRanges[0];
    let closestDist = Infinity;

    for (const [rs, re] of validRanges) {
        const dist = Math.min(Math.abs(start - rs), Math.abs(start - re));
        if (dist < closestDist) {
            closestDist = dist;
            closestRange = [rs, re];
        }
    }

    const [rs, re] = closestRange;
    const clampedStart = Math.max(rs, Math.min(start, re));
    const clampedEnd = Math.min(re, Math.max(clampedStart, end));

    return {
        ...suggestion,
        relevantLinesStart: clampedStart,
        relevantLinesEnd: clampedEnd,
    };
}

export const DOCUMENTATION_SEARCH_ADAPTER_TOKEN = Symbol(
    'DOCUMENTATION_SEARCH_ADAPTER_TOKEN',
);

/**
 * Pipeline stage that runs the agent-based code review.
 *
 * Replaces ProcessFilesReview for v3-agent mode:
 * - Passes all changed files + sandbox to the ReviewOrchestrator
 * - Orchestrator dispatches specialized agents (bug, security, performance) in parallel
 * - Agents investigate the codebase using sandbox tools before suggesting
 * - Results are stored in context.fileAnalysisResults for downstream stages
 */
@Injectable()
export class AgentReviewStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'AgentReviewStage';
    readonly label = 'Agent-Based Code Review';
    readonly visibility = StageVisibility.PRIMARY;

    private readonly logger = createLogger(AgentReviewStage.name);

    constructor(
        private readonly reviewOrchestrator: ReviewOrchestratorService,
        @Optional()
        @Inject(DOCUMENTATION_SEARCH_ADAPTER_TOKEN)
        private readonly documentationSearchService?: DocumentationSearchAdapter,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        // Guard: only runs in v3-agent mode
        if (
            context.codeReviewConfig?.codeReviewVersion !==
            CodeReviewVersion.V3_AGENT
        ) {
            return context;
        }

        const prNumber = context.pullRequest?.number;
        const changedFiles = context.changedFiles;

        if (!changedFiles?.length) {
            this.logger.log({
                message: `[AGENT] Skipping agent review: no changed files for PR#${prNumber}`,
                context: this.stageName,
            });
            return context;
        }

        if (!context.sandboxHandle?.remoteCommands) {
            this.logger.warn({
                message: `[AGENT] Skipping agent review: no sandbox available for PR#${prNumber}. Agent review requires a sandbox for code investigation.`,
                context: this.stageName,
                metadata: {
                    prNumber,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });
            return context;
        }

        const reviewOptions = context.codeReviewConfig?.reviewOptions || {
            bug: true,
            security: true,
            performance: true,
        };

        const startTime = Date.now();

        this.logger.log({
            message: `[AGENT] Starting agent review for PR#${prNumber} with ${changedFiles.length} files`,
            context: this.stageName,
            metadata: {
                prNumber,
                filesCount: changedFiles.length,
                reviewOptions,
                organizationId: context.organizationAndTeamData?.organizationId,
                teamId: context.organizationAndTeamData?.teamId,
            },
        });

        try {
            const result = await this.reviewOrchestrator.execute({
                organizationAndTeamData: context.organizationAndTeamData,
                changedFiles,
                remoteCommands: context.sandboxHandle.remoteCommands,
                prNumber,
                repositoryFullName:
                    context.repository?.fullName ||
                    context.pullRequest?.base?.repo?.fullName ||
                    '',
                languageResultPrompt:
                    context.codeReviewConfig?.languageResultPrompt || 'en-US',
                memoryRules: context.codeReviewConfig?.kodyMemoryRules,
                v2PromptOverrides: context.codeReviewConfig?.v2PromptOverrides,
                generationMain:
                    context.codeReviewConfig?.v2PromptOverrides?.generation
                        ?.main,
                documentationSearchService:
                    this.documentationSearchService || undefined,
                reviewOptions,
            });

            const durationMs = Date.now() - startTime;

            this.logger.log({
                message: `[TIMING] AgentReviewStage completed for PR#${prNumber}: ${result.suggestions.length} suggestions in ${durationMs}ms`,
                context: this.stageName,
                metadata: {
                    prNumber,
                    suggestionsCount: result.suggestions.length,
                    agentResults: result.agentResults.map((r) => ({
                        agent: r.agentName,
                        suggestions: r.suggestions.length,
                        turns: r.turnsUsed,
                        durationMs: r.durationMs,
                    })),
                    durationMs,
                },
            });

            // Snap suggestion line numbers to valid diff ranges before passing downstream.
            // GitHub rejects inline comments on lines that aren't part of the diff.
            const validatedSuggestions = result.suggestions.map((s) => {
                const file = changedFiles.find(
                    (f) => f.filename === s.relevantFile,
                );
                if (!file) return s;
                const validRanges = extractValidDiffLines(file.patch);
                const snapped = snapLinesToDiff(s, validRanges);
                if (
                    snapped.relevantLinesStart !== s.relevantLinesStart ||
                    snapped.relevantLinesEnd !== s.relevantLinesEnd
                ) {
                    this.logger.log({
                        message: `[AGENT] Snapped lines for ${s.relevantFile}: ${s.relevantLinesStart}-${s.relevantLinesEnd} → ${snapped.relevantLinesStart}-${snapped.relevantLinesEnd}`,
                        context: this.stageName,
                    });
                }
                return snapped;
            });

            // Deduplicate suggestions that describe the same issue
            let deduped = validatedSuggestions;
            try {
                deduped = await this.deduplicateSuggestions(
                    validatedSuggestions,
                    prNumber,
                    context.codeReviewConfig?.byokConfig,
                );
            } catch (dedupError) {
                this.logger.warn({
                    message: `[DEDUP] Failed for PR#${prNumber}, keeping all suggestions`,
                    context: this.stageName,
                    error: dedupError,
                });
            }

            return this.updateContext(context, (draft) => {
                const byFile = new Map<
                    string,
                    Partial<CodeSuggestion>[]
                >();
                for (const s of deduped) {
                    const file = s.relevantFile || '';
                    if (!byFile.has(file)) byFile.set(file, []);
                    byFile.get(file)!.push(s);
                }

                draft.fileAnalysisResults = [];
                for (const [filename, suggestions] of byFile) {
                    const file = changedFiles.find(
                        (f) => f.filename === filename,
                    );
                    if (file) {
                        draft.fileAnalysisResults.push({
                            validSuggestionsToAnalyze: suggestions,
                            discardedSuggestionsBySafeGuard: [],
                            file,
                        });
                    }
                }

                draft.validSuggestions = deduped;
            });
        } catch (error) {
            const durationMs = Date.now() - startTime;
            this.logger.error({
                message: `[AGENT] Agent review failed for PR#${prNumber} after ${durationMs}ms, continuing with empty results`,
                context: this.stageName,
                error,
                metadata: {
                    prNumber,
                    durationMs,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });

            // Non-fatal: return context with empty results
            return this.updateContext(context, (draft) => {
                draft.fileAnalysisResults = [];
            });
        }
    }

    /**
     * Deduplicate suggestions that describe the same issue using LLM.
     * Groups by file, then asks Gemini Flash which suggestions are duplicates.
     */
    private async deduplicateSuggestions(
        suggestions: Partial<CodeSuggestion>[],
        prNumber: number,
        byokConfig?: any,
    ): Promise<Partial<CodeSuggestion>[]> {
        if (suggestions.length <= 1) return suggestions;

        // Group by file
        const byFile = new Map<string, Partial<CodeSuggestion>[]>();
        for (const s of suggestions) {
            const f = s.relevantFile || '';
            if (!byFile.has(f)) byFile.set(f, []);
            byFile.get(f)!.push(s);
        }

        const result: Partial<CodeSuggestion>[] = [];

        for (const [filename, fileSuggestions] of byFile) {
            if (fileSuggestions.length <= 1) {
                result.push(...fileSuggestions);
                continue;
            }

            // Use LLM to find duplicates
            try {
                const model = getInternalModel(byokConfig);

                if (!model) {
                    result.push(...fileSuggestions);
                    continue;
                }

                const summaries = fileSuggestions
                    .map(
                        (s, i) =>
                            `[${i}] ${s.oneSentenceSummary || s.suggestionContent?.substring(0, 150)}`,
                    )
                    .join('\n');

                const dedupSchema = z.object({
                    keep: z
                        .array(z.number())
                        .describe(
                            'Indices of suggestions to keep (remove duplicates, keep the most detailed one)',
                        ),
                });

                const dedupResult = await generateText({
                    model: model as any,
                    output: Output.object({ schema: dedupSchema }) as any,
                    prompt: `These suggestions are for the same file "${filename}". Identify duplicates (suggestions describing the same issue) and return only the indices to KEEP. When two suggestions describe the same issue, keep the one with more detail.

${summaries}`,
                });

                const dedupOutput = (dedupResult as any).object ?? (dedupResult as any).output;
                const keepIndices = new Set(
                    dedupOutput?.keep || [],
                );
                const kept = fileSuggestions.filter((_, i) =>
                    keepIndices.has(i),
                );
                const removed = fileSuggestions.length - kept.length;

                if (removed > 0) {
                    const removedSuggestions = fileSuggestions.filter(
                        (_, i) => !keepIndices.has(i),
                    );
                    for (const s of removedSuggestions) {
                        this.logger.log({
                            message: `[DEDUP-REMOVED] PR#${prNumber} ${filename}:${s.relevantLinesStart}-${s.relevantLinesEnd} [${s.label}/${s.severity}] "${s.oneSentenceSummary || s.suggestionContent?.substring(0, 80)}"`,
                            context: this.stageName,
                        });
                    }
                    this.logger.log({
                        message: `[DEDUP] PR#${prNumber} ${filename}: ${fileSuggestions.length} → ${kept.length} (removed ${removed} duplicates)`,
                        context: this.stageName,
                    });
                }

                result.push(...kept);
            } catch (error) {
                this.logger.warn({
                    message: `[DEDUP] Failed for ${filename}, keeping all`,
                    context: this.stageName,
                    error,
                });
                result.push(...fileSuggestions);
            }
        }

        return result;
    }
}
