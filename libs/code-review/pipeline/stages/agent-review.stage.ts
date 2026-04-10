import { createLogger } from '@kodus/flow';
import { Output, jsonSchema } from 'ai';
import { Inject, Injectable } from '@nestjs/common';
import {
    tracedGenerateText,
    buildLangSmithProviderOptions,
} from '@libs/code-review/infrastructure/agents/llm/agent-loop';
import type { LangSmithTelemetryMetadata } from '@libs/code-review/infrastructure/agents/llm/agent-loop';

import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { CodeSuggestion } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';
import { ReviewOrchestratorService } from '@libs/code-review/infrastructure/agents/review-orchestrator.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { AgentProgressEvent } from '@libs/code-review/infrastructure/agents/base-code-review-agent.provider';

import { KodusGraphService } from '@libs/code-review/infrastructure/adapters/services/kodusGraph.service';
import { RepositoryRepository } from '@libs/code-review/infrastructure/adapters/repositories/repository.repository';
import { AstGraphStatus } from '@libs/code-review/infrastructure/adapters/repositories/schemas/repository.model';
import {
    resolveKodyRuleSeverityLevel,
    SeverityLevel,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    CodeReviewPipelineContext,
    DedupTraceGroupSummary,
    DedupTraceSuggestionSummary,
    DedupTraceSummary,
} from '../context/code-review-pipeline.context';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';

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
        const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
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

/**
 * Pipeline stage that runs the agent-based code review.
 *
 * Agent-based code review:
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

    private summarizeDedupSuggestion(
        suggestion?: Partial<CodeSuggestion>,
    ): DedupTraceSuggestionSummary {
        return {
            relevantFile: suggestion?.relevantFile,
            relevantLinesStart: suggestion?.relevantLinesStart,
            relevantLinesEnd: suggestion?.relevantLinesEnd,
            label: suggestion?.label,
            severity: suggestion?.severity,
            oneSentenceSummary:
                suggestion?.oneSentenceSummary ||
                suggestion?.suggestionContent?.substring(0, 200),
        };
    }

    private normalizeSeverity(severity?: string): SeverityLevel {
        switch ((severity || '').toLowerCase()) {
            case 'critical':
            case SeverityLevel.CRITICAL:
                return SeverityLevel.CRITICAL;
            case 'high':
            case SeverityLevel.ISSUE:
                return SeverityLevel.HIGH;
            case 'medium':
                return SeverityLevel.MEDIUM;
            case 'low':
            case SeverityLevel.WARNING:
                return SeverityLevel.LOW;
            default:
                return SeverityLevel.MEDIUM;
        }
    }

    constructor(
        private readonly reviewOrchestrator: ReviewOrchestratorService,
        private readonly observabilityService: ObservabilityService,
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,
        private readonly kodusGraphService: KodusGraphService,
        private readonly repositoryRepository: RepositoryRepository,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
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
            // Build progress callback for real-time agent traces in PR timeline
            const executionUuid =
                context.pipelineMetadata?.lastExecution?.uuid ||
                context.correlationId;
            const repositoryId = context.repository?.id;

            // Shared telemetry metadata for all LangSmith-traced calls in this pipeline run
            const telemetryMeta: LangSmithTelemetryMetadata = {
                organizationId: context.organizationAndTeamData?.organizationId,
                teamId: context.organizationAndTeamData?.teamId,
                pullRequestId: prNumber,
                repositoryId,
            };

            const onAgentProgress = this.createAgentProgressCallback(
                executionUuid,
                prNumber,
                repositoryId,
            );

            // Generate call graph context from AST graph in DB (via kodus-graph in E2B sandbox)
            let callGraph = '';
            try {
                const sandboxType = context.sandboxHandle?.type ?? 'unknown';
                const hasSandboxObj = !!context.sandboxHandle?.sandboxHandle;
                this.logger.log({
                    message: `[AGENT] sandboxHandle check: type=${sandboxType}, hasSandboxHandle=${hasSandboxObj}, platform=${context.platformType}, repoId=${context.repository?.id}`,
                    context: this.stageName,
                    metadata: {
                        sandboxType,
                        hasSandboxObj,
                        platform: context.platformType,
                        repoExternalId: context.repository?.id,
                    },
                });

                if (context.sandboxHandle?.sandboxHandle) {
                    const repo =
                        await this.repositoryRepository.findByExternalId(
                            context.platformType,
                            String(context.repository?.id || ''),
                        );

                    this.logger.log({
                        message: `[AGENT] repo lookup: found=${!!repo}, astGraphStatus=${repo?.astGraphStatus ?? 'N/A'}, uuid=${repo?.uuid ?? 'N/A'}`,
                        context: this.stageName,
                        metadata: {
                            repoExternalId: context.repository?.id,
                            repoUuid: repo?.uuid,
                            astGraphStatus: repo?.astGraphStatus,
                        },
                    });

                    if (repo?.astGraphStatus === AstGraphStatus.READY) {
                        callGraph =
                            await this.kodusGraphService.generateContext(
                                context.sandboxHandle.sandboxHandle,
                                changedFiles,
                                repo.uuid,
                            );
                    } else {
                        this.logger.log({
                            message: `[AGENT] No AST graph in DB for PR#${prNumber} (status=${repo?.astGraphStatus || 'not found'}), falling back to legacy (changed-files only)`,
                            context: this.stageName,
                        });
                        callGraph =
                            await this.kodusGraphService.generateContextLegacy(
                                context.sandboxHandle.sandboxHandle,
                                changedFiles,
                                context.sandboxHandle?.baseBranch ||
                                    context.pullRequest?.base?.ref ||
                                    context.repository?.defaultBranch,
                            );
                    }
                } else {
                    this.logger.warn({
                        message: `[AGENT] No sandboxHandle object (type=${sandboxType}), skipping kodus-graph for PR#${prNumber}`,
                        context: this.stageName,
                    });
                }

                if (callGraph) {
                    this.logger.log({
                        message: `[AGENT] kodus-graph context: ${callGraph.length} chars for PR#${prNumber}`,
                        context: this.stageName,
                        metadata: {
                            prNumber,
                            callGraphChars: callGraph.length,
                            callGraphPreview: callGraph.substring(0, 320),
                        },
                    });
                }
            } catch (err) {
                this.logger.warn({
                    message: `[AGENT] Call graph failed for PR#${prNumber}, proceeding without it`,
                    context: this.stageName,
                    error: err,
                    metadata: {
                        sandboxType: context.sandboxHandle?.type,
                        hasSandboxObj: !!context.sandboxHandle?.sandboxHandle,
                    },
                });
            }

            const result = await this.reviewOrchestrator.execute({
                organizationAndTeamData: context.organizationAndTeamData,
                changedFiles,
                remoteCommands: context.sandboxHandle.remoteCommands,
                prNumber,
                repositoryId,
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
                prTitle: context.pullRequest?.title,
                prBody: context.pullRequest?.body,
                kodyRules: context.codeReviewConfig?.kodyRules,
                reviewOptions,
                onAgentProgress,
                gitHubToken: await this.resolveGitHubToken(context),
                baseBranch:
                    context.sandboxHandle?.baseBranch ||
                    context.pullRequest?.base?.ref ||
                    context.repository?.defaultBranch,
                callGraph,
                reviewMode: context.codeReviewConfig?.reviewMode || 'normal',
                severityLevelFilter:
                    context.codeReviewConfig?.suggestionControl
                        ?.severityLevelFilter,
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
                        category: r.agentCategory,
                        replicaIndex: r.agentReplicaIndex,
                        replicaTotal: r.agentReplicaTotal,
                        suggestions: r.suggestions.length,
                        turns: r.turnsUsed,
                        durationMs: r.durationMs,
                    })),
                    durationMs,
                },
            });

            // Collect suggestions discarded by severity filter and verify
            const allDiscarded: Partial<CodeSuggestion>[] = [];
            for (const agentResult of result.agentResults) {
                if (agentResult.discardedBySeverity?.length) {
                    for (const s of agentResult.discardedBySeverity) {
                        allDiscarded.push({
                            ...s,
                            priorityStatus:
                                PriorityStatus.DISCARDED_BY_SEVERITY,
                        });
                    }
                }
                if (agentResult.discardedByVerify?.length) {
                    for (const s of agentResult.discardedByVerify) {
                        allDiscarded.push({
                            ...s,
                            priorityStatus:
                                PriorityStatus.DISCARDED_BY_SAFEGUARD,
                        });
                    }
                }
            }

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

            // Verify/Discover removed — was hurting recall across all models.
            // Benchmark showed F1 drops of -5.7pp to -18.3pp with verify enabled.
            const reflectedSuggestions = validatedSuggestions;

            const kodyRulesSuggestions = reflectedSuggestions.filter(
                (s) => s.label === 'kody_rules',
            );
            const nonKodyRulesSuggestions = reflectedSuggestions.filter(
                (s) => s.label !== 'kody_rules',
            );

            // Normalize Kody Rules legacy severity (critical/issue/warning) into the
            // v2 severity scale (critical/high/medium/low). The agent returns the rule
            // UUID in brokenKodyRulesIds — use it for exact matching.
            const kodyRulesById = new Map(
                (context.codeReviewConfig?.kodyRules ?? [])
                    .filter((r) => r.uuid)
                    .map((r) => [r.uuid!, r]),
            );
            const kodyRulesWithSeverity = kodyRulesSuggestions.map((s) => {
                const ruleUuid = s.brokenKodyRulesIds?.[0];
                const matchedRule = ruleUuid
                    ? kodyRulesById.get(ruleUuid)
                    : undefined;
                const legacySeverity = matchedRule
                    ? resolveKodyRuleSeverityLevel(matchedRule)
                    : SeverityLevel.ISSUE;

                return {
                    ...s,
                    severity: this.normalizeSeverity(legacySeverity),
                };
            });

            const severityNormalizedNonRules = nonKodyRulesSuggestions.map(
                (suggestion) => ({
                    ...suggestion,
                    severity: this.normalizeSeverity(suggestion.severity),
                }),
            );

            const severityNormalized = [
                ...severityNormalizedNonRules,
                ...kodyRulesWithSeverity,
            ];

            // Deduplicate suggestions that describe the same issue.
            // Kody Rules skip dedup — they are user-defined rules that must always be reported.
            const kodyRulesForDedup = severityNormalized.filter(
                (s) => s.label === 'kody_rules',
            );
            const nonKodyRulesForDedup = severityNormalized.filter(
                (s) => s.label !== 'kody_rules',
            );

            let dedupedNonRules = nonKodyRulesForDedup;
            let dedupTrace: DedupTraceSummary = {
                status:
                    nonKodyRulesForDedup.length <= 1 ? 'skipped' : 'success',
                totalClassifiedCount: severityNormalized.length,
                kodyRulesSkippedCount: kodyRulesForDedup.length,
                nonKodyInputCount: nonKodyRulesForDedup.length,
                nonKodyOutputCount: nonKodyRulesForDedup.length,
                finalOutputCount: severityNormalized.length,
                uniqueCount: nonKodyRulesForDedup.length,
                groupsCount: 0,
                removedCount: 0,
                unique: nonKodyRulesForDedup.map((suggestion) =>
                    this.summarizeDedupSuggestion(suggestion),
                ),
            };
            try {
                const dedupResult = await this.deduplicateSuggestions(
                    nonKodyRulesForDedup,
                    prNumber,
                    context.codeReviewConfig?.byokConfig,
                    telemetryMeta,
                );
                dedupedNonRules = dedupResult.suggestions;
                dedupTrace = {
                    ...dedupResult.trace,
                    totalClassifiedCount: severityNormalized.length,
                    kodyRulesSkippedCount: kodyRulesForDedup.length,
                    nonKodyInputCount: nonKodyRulesForDedup.length,
                    nonKodyOutputCount: dedupResult.suggestions.length,
                    finalOutputCount:
                        dedupResult.suggestions.length +
                        kodyRulesForDedup.length,
                };
            } catch (dedupError) {
                this.logger.warn({
                    message: `[DEDUP] Failed for PR#${prNumber}, keeping all suggestions`,
                    context: this.stageName,
                    error: dedupError,
                });
                dedupTrace = {
                    ...dedupTrace,
                    status: 'failed-keep-all',
                    errorMessage:
                        dedupError instanceof Error
                            ? dedupError.message
                            : String(dedupError),
                };
            }

            const deduped = [...dedupedNonRules, ...kodyRulesForDedup];

            // Enrich kody_rules suggestions with links to the rule page
            const baseUrl = process.env.API_USER_INVITE_BASE_URL || '';
            for (const s of deduped) {
                if (s.label !== 'kody_rules' || !s.brokenKodyRulesIds?.[0])
                    continue;
                const ruleId = s.brokenKodyRulesIds[0];
                const rule = kodyRulesById.get(ruleId);
                if (!rule?.title) continue;

                const repoPath =
                    rule.repositoryId === 'global'
                        ? 'global'
                        : rule.repositoryId;
                const ruleLink = `${baseUrl}/settings/code-review/${repoPath}/kody-rules/${ruleId}`;
                const escapedTitle = rule.title.replace(
                    /([[\]\\`*_{}()#+\-.!])/g,
                    '\\$1',
                );
                const markdownLink = `[${escapedTitle}](${ruleLink})`;

                let content = s.suggestionContent || '';
                if (content.includes(rule.title)) {
                    // Replace the first occurrence of the title with the link
                    content = content.replace(rule.title, markdownLink);
                } else {
                    // Append a link line at the end
                    content += `\n\nKody rule violation: ${markdownLink}`;
                }
                s.suggestionContent = content;
            }

            // Reclassify severity using dedicated criteria (Gemini Flash)
            // The agent assigns rough severity during investigation; this step
            // applies the definitive criteria (default or client-custom) without
            // biasing the agent's bug-finding behavior.
            try {
                const {
                    classifySeverity,
                } = require('@libs/code-review/infrastructure/agents/llm/classify-severity');
                const severityMap = await classifySeverity(
                    deduped.map((s) => ({
                        relevantFile: s.relevantFile || '',
                        suggestionContent: s.suggestionContent || '',
                        oneSentenceSummary: s.oneSentenceSummary || '',
                        existingCode: s.existingCode || '',
                        improvedCode: s.improvedCode || '',
                    })),
                    context.codeReviewConfig?.v2PromptOverrides,
                );
                for (let i = 0; i < deduped.length; i++) {
                    const classified = severityMap.get(i);
                    if (classified) deduped[i].severity = classified;
                }
                this.logger.log({
                    message: `[AGENT] Reclassified severity for ${deduped.length} suggestions`,
                    context: this.stageName,
                });
            } catch (err) {
                this.logger.warn({
                    message: `[AGENT] Severity classification failed, keeping agent-assigned severity: ${err instanceof Error ? err.message : String(err)}`,
                    context: this.stageName,
                });
            }

            // Clean up suggestion text: remove WHAT/WHY/HOW labels, merge into natural prose
            try {
                const {
                    formatSuggestionContent,
                } = require('@libs/code-review/infrastructure/agents/llm/format-suggestion-content');
                const formatted = await formatSuggestionContent(
                    deduped.map((s) => ({
                        suggestionContent: s.suggestionContent || '',
                        existingCode: s.existingCode || '',
                        improvedCode: s.improvedCode || '',
                        relevantFile: s.relevantFile || '',
                        language: s.language || '',
                    })),
                    {
                        customWritingGuidelines:
                            context.codeReviewConfig?.v2PromptOverrides
                                ?.generation?.main,
                        byokConfig: context.codeReviewConfig?.byokConfig,
                        languageResultPrompt:
                            context.codeReviewConfig?.languageResultPrompt,
                    },
                );
                for (const [i, fmt] of formatted) {
                    if (deduped[i]) {
                        deduped[i].suggestionContent = fmt.suggestionContent;
                    }
                }
                this.logger.log({
                    message: `[AGENT] Formatted ${formatted.size}/${deduped.length} suggestion contents`,
                    context: this.stageName,
                });
            } catch (err) {
                this.logger.warn({
                    message: `[AGENT] Content formatting failed, keeping original text: ${err instanceof Error ? err.message : String(err)}`,
                    context: this.stageName,
                });
            }

            // Separate PR-level kody rules (no file/lines) from file-level suggestions.
            // PR-level suggestions go to validSuggestionsByPR → CreatePrLevelCommentsStage.
            const prLevelSuggestions = deduped.filter(
                (s) =>
                    s.label === 'kody_rules' &&
                    !s.relevantFile &&
                    !s.relevantLinesStart,
            );
            const fileLevelSuggestions = deduped.filter(
                (s) =>
                    !(
                        s.label === 'kody_rules' &&
                        !s.relevantFile &&
                        !s.relevantLinesStart
                    ),
            );

            // Sort file-level suggestions: kody_rules first, then by severity
            // (critical > high > medium > low).
            const severityOrder: Record<string, number> = {
                critical: 0,
                high: 1,
                medium: 2,
                low: 3,
            };
            fileLevelSuggestions.sort((a, b) => {
                // kody_rules always first within the same file
                const aIsRule = a.label === 'kody_rules' ? 0 : 1;
                const bIsRule = b.label === 'kody_rules' ? 0 : 1;
                if (aIsRule !== bIsRule) return aIsRule - bIsRule;
                // Then by severity
                const aSeverity =
                    severityOrder[this.normalizeSeverity(a.severity)];
                const bSeverity =
                    severityOrder[this.normalizeSeverity(b.severity)];
                return aSeverity - bSeverity;
            });

            return this.updateContext(context, (draft) => {
                const byFile = new Map<string, Partial<CodeSuggestion>[]>();
                for (const s of fileLevelSuggestions) {
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
                        const discardedForFile = allDiscarded.filter(
                            (s) => s.relevantFile === filename,
                        );
                        draft.fileAnalysisResults.push({
                            validSuggestionsToAnalyze: suggestions,
                            discardedSuggestionsBySafeGuard: discardedForFile,
                            file,
                        });
                    }
                }

                // PR-level kody rules go to validSuggestionsByPR for CreatePrLevelCommentsStage
                if (prLevelSuggestions.length > 0) {
                    if (!draft.validSuggestionsByPR) {
                        draft.validSuggestionsByPR = [];
                    }
                    draft.validSuggestionsByPR.push(
                        ...prLevelSuggestions.map((s) => ({
                            id:
                                s.brokenKodyRulesIds?.[0] ||
                                crypto.randomUUID(),
                            suggestionContent: s.suggestionContent || '',
                            oneSentenceSummary: s.oneSentenceSummary || '',
                            label: (s.label as any) || 'kody_rules',
                            severity: this.normalizeSeverity(s.severity),
                            brokenKodyRulesIds: s.brokenKodyRulesIds,
                            deliveryStatus: DeliveryStatus.NOT_SENT,
                        })),
                    );
                }

                draft.dedupTrace = dedupTrace;
                draft.validSuggestions = deduped;
                draft.discardedSuggestions = allDiscarded;
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
        telemetryMeta?: LangSmithTelemetryMetadata,
    ): Promise<{
        suggestions: Partial<CodeSuggestion>[];
        trace: DedupTraceSummary;
    }> {
        if (suggestions.length <= 1) {
            return {
                suggestions,
                trace: {
                    status: 'skipped',
                    totalClassifiedCount: suggestions.length,
                    kodyRulesSkippedCount: 0,
                    nonKodyInputCount: suggestions.length,
                    nonKodyOutputCount: suggestions.length,
                    finalOutputCount: suggestions.length,
                    uniqueCount: suggestions.length,
                    groupsCount: 0,
                    removedCount: 0,
                    unique: suggestions.map((suggestion) =>
                        this.summarizeDedupSuggestion(suggestion),
                    ),
                },
            };
        }

        // Use Gemini 3 Flash for dedup — excellent structured output + code understanding
        const googleKey =
            process.env.API_GOOGLE_AI_API_KEY ||
            process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        if (!googleKey) {
            return {
                suggestions,
                trace: {
                    status: 'failed-keep-all',
                    totalClassifiedCount: suggestions.length,
                    kodyRulesSkippedCount: 0,
                    nonKodyInputCount: suggestions.length,
                    nonKodyOutputCount: suggestions.length,
                    finalOutputCount: suggestions.length,
                    uniqueCount: suggestions.length,
                    groupsCount: 0,
                    removedCount: 0,
                    errorMessage: 'Missing Google AI API key for dedup',
                    unique: suggestions.map((suggestion) =>
                        this.summarizeDedupSuggestion(suggestion),
                    ),
                },
            };
        }

        const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
        const model = createGoogleGenerativeAI({ apiKey: googleKey })(
            'gemini-3-flash-preview',
        );

        try {
            // Build summaries with file + lines for cross-file comparison
            const summaries = suggestions
                .map(
                    (s, i) =>
                        `[${i}] ${s.relevantFile || 'unknown'}:${s.relevantLinesStart}-${s.relevantLinesEnd} [${s.label || 'unknown'}/${this.normalizeSeverity(s.severity)}]: ${s.oneSentenceSummary || s.suggestionContent?.substring(0, 200)}${s.improvedCode ? `\n    fix: ${s.improvedCode.substring(0, 100)}` : ''}`,
                )
                .join('\n');

            const dedupResult: any = await tracedGenerateText({
                model: model as any,
                experimental_telemetry: {
                    isEnabled: true,
                    functionId: 'dedup-suggestions',
                },
                providerOptions: buildLangSmithProviderOptions(
                    'dedup-suggestions',
                    telemetryMeta,
                ),
                output: Output.object({
                    schema: jsonSchema({
                        type: 'object',
                        properties: {
                            groups: {
                                type: 'array',
                                description:
                                    'Groups of suggestions. Each group has a representative and its duplicates.',
                                items: {
                                    type: 'object',
                                    properties: {
                                        keep: {
                                            type: 'number',
                                            description:
                                                'Index of the best suggestion to keep as representative',
                                        },
                                        duplicates: {
                                            type: 'array',
                                            items: { type: 'number' },
                                            description:
                                                'Indices of duplicate suggestions (same bug, same or different locations)',
                                        },
                                    },
                                    required: ['keep', 'duplicates'],
                                    additionalProperties: false,
                                },
                            },
                            unique: {
                                type: 'array',
                                items: { type: 'number' },
                                description:
                                    'Indices of suggestions that have no duplicates',
                            },
                        },
                        required: ['groups', 'unique'],
                        additionalProperties: false,
                    }),
                }) as any,
                prompt: `You have ${suggestions.length} code review suggestions across multiple files in a PR. Identify duplicates and group them.

BE CONSERVATIVE — when in doubt, do NOT group. Only group when you are highly confident they describe the exact same bug.

There are TWO types of duplicates:

1. **EXACT DUPLICATES** (same bug, same location): Multiple suggestions pointing to the same file and overlapping lines describing the same issue. Keep the one with the most detail, discard the rest.

2. **CROSS-LOCATION DUPLICATES** (same bug pattern, different locations): Suggestions describing the EXACT SAME code pattern/bug but applied in different files (e.g., "forEach with async callback" found in 3 different files, or "missing null check on the same API call" in 2 files). These should be GROUPED — keep the best one as representative, list the others as duplicates.

NOT duplicates (keep both):
- Different bugs in the same file or nearby lines (e.g., "nil pointer" and "missing validation" in the same controller — these are DIFFERENT bugs)
- Different root causes even if they sound similar (e.g., "add nil check" vs "fix typo" — different problems)
- Suggestions about different code even if the description sounds similar

IGNORE the category label (bug/security/performance) when deciding — two agents can independently find the same issue.
Prefer keeping the suggestion with the most detail or clearest fix as the representative.

${summaries}`,
            });

            // Track token usage
            try {
                const dedupUsage = dedupResult.usage ?? dedupResult.totalUsage;
                if (dedupUsage) {
                    await this.observabilityService.runInSpan(
                        'dedup-suggestions',
                        async () => dedupResult,
                        {
                            'gen_ai.usage.input_tokens':
                                dedupUsage.inputTokens ?? 0,
                            'gen_ai.usage.output_tokens':
                                dedupUsage.outputTokens ?? 0,
                            'gen_ai.usage.total_tokens':
                                dedupUsage.totalTokens ??
                                (dedupUsage.inputTokens ?? 0) +
                                    (dedupUsage.outputTokens ?? 0),
                            'gen_ai.response.model': 'internal-dedup',
                            'gen_ai.run.name': 'code-review-dedup',
                            'type': 'system',
                            'prNumber': prNumber,
                        },
                    );
                }
            } catch {
                // Observability is best-effort
            }

            const dedupOutput =
                (dedupResult as any).object ?? (dedupResult as any).output;

            this.logger.log({
                message: `[DEDUP-DEBUG] PR#${prNumber}: input=${suggestions.length}, groups=${dedupOutput?.groups?.length ?? 0}, unique=${dedupOutput?.unique?.length ?? 0}`,
                context: this.stageName,
            });

            const groups: Array<{
                keep: number;
                duplicates: number[];
            }> = dedupOutput?.groups || [];
            const unique: number[] = dedupOutput?.unique || [];

            // Safety: if LLM returns nothing useful, keep all
            if (groups.length === 0 && unique.length === 0) {
                this.logger.warn({
                    message: `[DEDUP] PR#${prNumber}: LLM returned empty result, keeping all ${suggestions.length} suggestions`,
                    context: this.stageName,
                });
                return {
                    suggestions,
                    trace: {
                        status: 'empty-keep-all',
                        totalClassifiedCount: suggestions.length,
                        kodyRulesSkippedCount: 0,
                        nonKodyInputCount: suggestions.length,
                        nonKodyOutputCount: suggestions.length,
                        finalOutputCount: suggestions.length,
                        uniqueCount: 0,
                        groupsCount: 0,
                        removedCount: 0,
                        unique: suggestions.map((suggestion) =>
                            this.summarizeDedupSuggestion(suggestion),
                        ),
                    },
                };
            }

            const result: Partial<CodeSuggestion>[] = [];
            const uniqueSuggestions: DedupTraceSuggestionSummary[] = [];
            const groupSummaries: DedupTraceGroupSummary[] = [];

            // Add unique suggestions as-is
            for (const idx of unique) {
                if (idx >= 0 && idx < suggestions.length) {
                    result.push(suggestions[idx]);
                    uniqueSuggestions.push(
                        this.summarizeDedupSuggestion(suggestions[idx]),
                    );
                }
            }

            // Process groups
            for (const group of groups) {
                const keepIdx = group.keep;
                const dupIndices = group.duplicates || [];

                if (keepIdx < 0 || keepIdx >= suggestions.length) continue;

                const kept = { ...suggestions[keepIdx] };
                const duplicateSummaries: DedupTraceSuggestionSummary[] = [];

                // Collect locations from duplicates that are in DIFFERENT locations
                const otherLocations: string[] = [];
                for (const dupIdx of dupIndices) {
                    if (dupIdx < 0 || dupIdx >= suggestions.length) continue;
                    const dup = suggestions[dupIdx];
                    duplicateSummaries.push(this.summarizeDedupSuggestion(dup));
                    const dupLocation = `${dup.relevantFile}:${dup.relevantLinesStart}-${dup.relevantLinesEnd}`;
                    const keptLocation = `${kept.relevantFile}:${kept.relevantLinesStart}-${kept.relevantLinesEnd}`;

                    if (dupLocation !== keptLocation) {
                        otherLocations.push(dupLocation);
                    }

                    this.logger.log({
                        message: `[DEDUP-REMOVED] PR#${prNumber} ${dup.relevantFile}:${dup.relevantLinesStart}-${dup.relevantLinesEnd} [${dup.label}/${dup.severity}] "${dup.oneSentenceSummary || dup.suggestionContent?.substring(0, 80)}"`,
                        context: this.stageName,
                    });
                }

                // Append other locations to the suggestion content
                if (otherLocations.length > 0) {
                    const locationsList = otherLocations
                        .map((loc) => `- \`${loc}\``)
                        .join('\n');
                    kept.suggestionContent = `${kept.suggestionContent}\n\n**Also found in:**\n${locationsList}`;
                }

                groupSummaries.push({
                    keep: this.summarizeDedupSuggestion(kept),
                    duplicates: duplicateSummaries,
                });
                result.push(kept);
            }

            const totalRemoved = suggestions.length - result.length;
            if (totalRemoved > 0) {
                this.logger.log({
                    message: `[DEDUP] PR#${prNumber}: ${suggestions.length} → ${result.length} (removed ${totalRemoved} duplicates, ${groups.length} groups merged)`,
                    context: this.stageName,
                });
            }

            return {
                suggestions: result,
                trace: {
                    status: 'success',
                    totalClassifiedCount: suggestions.length,
                    kodyRulesSkippedCount: 0,
                    nonKodyInputCount: suggestions.length,
                    nonKodyOutputCount: result.length,
                    finalOutputCount: result.length,
                    uniqueCount: uniqueSuggestions.length,
                    groupsCount: groupSummaries.length,
                    removedCount: totalRemoved,
                    groups: groupSummaries,
                    unique: uniqueSuggestions,
                },
            };
        } catch (error) {
            this.logger.warn({
                message: `[DEDUP] PR#${prNumber}: Failed, keeping all ${suggestions.length} suggestions`,
                context: this.stageName,
                error,
            });
            return {
                suggestions,
                trace: {
                    status: 'failed-keep-all',
                    totalClassifiedCount: suggestions.length,
                    kodyRulesSkippedCount: 0,
                    nonKodyInputCount: suggestions.length,
                    nonKodyOutputCount: suggestions.length,
                    finalOutputCount: suggestions.length,
                    uniqueCount: suggestions.length,
                    groupsCount: 0,
                    removedCount: 0,
                    errorMessage:
                        error instanceof Error ? error.message : String(error),
                    unique: suggestions.map((suggestion) =>
                        this.summarizeDedupSuggestion(suggestion),
                    ),
                },
            };
        }
    }

    /**
     * Creates a callback that writes agent progress to the PR timeline.
     * Each agent gets its own timeline entry (visibility: secondary).
     * Tool calls are batched — updates happen every 5 steps, not every call.
     */
    private createAgentProgressCallback(
        executionUuid: string | undefined,
        prNumber: number | undefined,
        repositoryId: string | undefined,
    ): (event: AgentProgressEvent) => void {
        // Track accumulated tool calls per agent for the final entry
        const agentToolCalls = new Map<
            string,
            Array<{ tool: string; args: string }>
        >();

        return (event: AgentProgressEvent) => {
            const stageName = this.getAgentStageName(event);
            const label = this.formatAgentLabel(event);

            // Fire-and-forget — don't block the agent loop
            this.writeAgentTrace(
                executionUuid,
                prNumber,
                repositoryId,
                stageName,
                event,
                label,
                agentToolCalls,
            ).catch(() => {
                // Best effort — don't fail the review if timeline write fails
            });
        };
    }

    private getAgentStageName(event: AgentProgressEvent): string {
        const baseName =
            event.agentCategory ||
            event.agentName.replace('kodus-', '').replace('-review-agent', '');

        if (
            event.agentReplicaTotal &&
            event.agentReplicaTotal > 1 &&
            event.agentReplicaIndex
        ) {
            return `AgentReview::${baseName}-r${event.agentReplicaIndex}`;
        }

        return `AgentReview::${baseName}`;
    }

    private formatAgentLabel(event: AgentProgressEvent): string {
        const name =
            event.agentCategory ||
            event.agentName.replace('kodus-', '').replace('-review-agent', '');
        const icon =
            name === 'bug'
                ? 'Bug'
                : name === 'security'
                  ? 'Security'
                  : name === 'generalist'
                    ? 'Generalist'
                    : name === 'rules'
                      ? 'Rules'
                      : name === 'kody_rules'
                        ? 'Rules'
                        : 'Performance';
        const replicaSuffix =
            event.agentReplicaTotal &&
            event.agentReplicaTotal > 1 &&
            event.agentReplicaIndex
                ? ` #${event.agentReplicaIndex}/${event.agentReplicaTotal}`
                : '';

        const duration = event.durationMs
            ? `in ${Math.round(event.durationMs / 1000)}s`
            : '';

        switch (event.status) {
            case 'started':
                return `${icon} Agent${replicaSuffix} — investigating...`;
            case 'investigating':
                return `${icon} Agent${replicaSuffix} — step ${event.step}, ${event.toolCalls?.length ?? 0} tool calls`;
            case 'completed': {
                const suffix =
                    event.source === 'second-chance'
                        ? ' (recovered via second-chance)'
                        : event.source === 'generate-object'
                          ? ' (structured by fallback)'
                          : '';
                return `${icon} Agent${replicaSuffix} — ${event.findings ?? 0} findings ${duration}${suffix}`;
            }
            case 'error': {
                if (event.finishReason === 'timeout') {
                    return `${icon} Agent${replicaSuffix} — timed out after ${duration} (${event.step ?? 0} steps)`;
                }
                if (event.finishReason === 'max-steps') {
                    return `${icon} Agent${replicaSuffix} — hit step limit (${event.step ?? 0} steps, no findings)`;
                }
                return `${icon} Agent${replicaSuffix} — failed ${duration}`;
            }
            default:
                return `${icon} Agent${replicaSuffix}`;
        }
    }

    private async writeAgentTrace(
        executionUuid: string | undefined,
        prNumber: number | undefined,
        repositoryId: string | undefined,
        stageName: string,
        event: AgentProgressEvent,
        label: string,
        agentToolCalls: Map<string, Array<{ tool: string; args: string }>>,
    ): Promise<void> {
        if (!executionUuid && !prNumber) return;

        // Accumulate tool calls
        if (event.toolCalls) {
            const existing = agentToolCalls.get(event.agentName) || [];
            existing.push(...event.toolCalls);
            agentToolCalls.set(event.agentName, existing);
        }

        const status =
            event.status === 'completed'
                ? AutomationStatus.SUCCESS
                : event.status === 'error'
                  ? AutomationStatus.ERROR
                  : AutomationStatus.IN_PROGRESS;

        const metadata: Record<string, any> = {
            visibility: 'secondary',
            label,
        };

        // On completion/error, include full tool trace summary
        if (event.status === 'completed' || event.status === 'error') {
            const allCalls = agentToolCalls.get(event.agentName) || [];
            metadata.agentTrace = {
                category: event.agentCategory,
                replicaIndex: event.agentReplicaIndex,
                replicaTotal: event.agentReplicaTotal,
                steps: event.step,
                findings: event.findings,
                durationMs: event.durationMs,
                totalTokens: event.totalTokens,
                toolCalls: allCalls.slice(-30), // Keep last 30 to avoid huge payloads
                toolSummary: this.summarizeToolCalls(allCalls),
                suggestionsPreview: event.suggestionsPreview,
                coverage: event.coverage,
                verification: event.verification,
                anomalies: event.anomalies,
            };
        }

        const filter = executionUuid
            ? { uuid: executionUuid }
            : { pullRequestNumber: prNumber, repositoryId };

        try {
            // First event → create entry. Subsequent events → update existing.
            if (event.status === 'started') {
                await this.automationExecutionService.updateCodeReview(
                    filter,
                    { status },
                    label,
                    stageName,
                    metadata,
                );
            } else {
                // Find existing entry and update it (don't create duplicates)
                const existing = executionUuid
                    ? await this.automationExecutionService.findLatestStageLog(
                          executionUuid,
                          stageName,
                      )
                    : null;

                if (existing) {
                    const updateData: any = {
                        status,
                        message: label,
                        metadata: { ...existing.metadata, ...metadata },
                    };
                    if (
                        status === AutomationStatus.SUCCESS ||
                        status === AutomationStatus.ERROR
                    ) {
                        updateData.finishedAt = new Date();
                    }
                    await this.automationExecutionService.updateStageLog(
                        existing.uuid,
                        updateData,
                    );
                } else {
                    // Fallback: create if not found
                    await this.automationExecutionService.updateCodeReview(
                        filter,
                        { status },
                        label,
                        stageName,
                        metadata,
                    );
                }
            }
        } catch {
            // Best effort
        }
    }

    /**
     * Resolve GitHub token for cross-repo file reading (readReference tool).
     * Uses the same token that was used to clone the repo for the sandbox.
     */
    private async resolveGitHubToken(
        context: CodeReviewPipelineContext,
    ): Promise<string | undefined> {
        try {
            if (context.getFreshCloneParams) {
                const params = await context.getFreshCloneParams();
                return params?.authToken;
            }
        } catch {
            // Best effort — tool just won't be available
        }
        return undefined;
    }

    private summarizeToolCalls(
        calls: Array<{ tool: string; args: string }>,
    ): Record<string, number> {
        const summary: Record<string, number> = {};
        for (const c of calls) {
            summary[c.tool] = (summary[c.tool] || 0) + 1;
        }
        return summary;
    }
}
