import { createLogger, createThreadId } from '@kodus/flow';
import { BusinessRulesValidationAgentProvider } from '@libs/agents/infrastructure/services/kodus-flow/business-rules-validation/businessRulesValidationAgent';
import { LabelType } from '@libs/common/utils/codeManagement/labels';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { PipelineError } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-context.interface';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { ISuggestionByPR } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

/**
 * Validates that the code in the PR matches the business requirements
 * declared in the PR description (linked tickets, requirement keywords).
 *
 * Surface as a top-level pipeline stage in the agent (v4) engine so the
 * UI can show what happened: ran with a gap, ran clean, or skipped with
 * a concrete reason (no ticket link, feature off, unchanged description).
 *
 * In the legacy EE engine this is still done inside
 * ProcessFilesPrLevelReviewStage alongside kody rules and cross-file
 * analysis. Once the EE engine is retired this can become the sole owner.
 */
@Injectable()
export class BusinessLogicValidationStage extends BasePipelineStage<CodeReviewPipelineContext> {
    private readonly logger = createLogger(BusinessLogicValidationStage.name);
    readonly stageName = 'BusinessLogicValidationStage';
    readonly label = 'Validating Business Logic';
    readonly visibility = StageVisibility.PRIMARY;
    readonly errorSeverity = 'partial' as const;

    private static readonly REQUIREMENT_KEYWORDS = [
        'requirement',
        'acceptance criteria',
        'user story',
        'given',
        'when',
        'then',
    ];
    private static readonly TIMEOUT_MS = 300_000; // 5 min

    constructor(
        private readonly businessRulesValidationAgentProvider: BusinessRulesValidationAgentProvider,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        // IMPORTANT: do NOT mutate context.statusInfo from this stage.
        // The pipeline executor treats statusInfo.status === SKIPPED as
        // "abort the pipeline" / start jump-to-stage logic. Setting it
        // here would skip every stage downstream (CreateSandbox,
        // AgentReview, ValidateSuggestions, ...). Instead, surface the
        // outcome via logs + the businessLogicOutcome field that the
        // observer can pick up for per-stage UI metadata.
        const skipDecision = await this.evaluateSkip(context);
        if (skipDecision) {
            this.logger.log({
                message: `[BUSINESS-LOGIC] Skipped: ${skipDecision.message}`,
                context: this.stageName,
                metadata: {
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    prNumber: context.pullRequest?.number,
                    reason: skipDecision.reason,
                },
            });

            return this.updateContext(context, (draft) => {
                draft.businessLogicResults = [];
                draft.businessLogicOutcome = {
                    kind: 'skipped',
                    reason: skipDecision.reason,
                    message: skipDecision.message,
                };
            });
        }

        const prBody = context.pullRequest.body ?? '';
        const prBodyHash = this.computePrBodyHash(prBody);
        const signals = this.detectSignals(prBody);

        try {
            const prepareContext = {
                userQuestion: '@kody -v business-logic',
                pullRequest: {
                    pullRequestNumber: context.pullRequest.number,
                    headRef: context.pullRequest?.head?.ref,
                    baseRef: context.pullRequest?.base?.ref,
                },
                repository: context.repository,
                pullRequestDescription: prBody,
                platformType: context.platformType,
                defaultBranch: context.pullRequest?.base?.ref,
                businessSignals: signals,
            };
            const thread = this.createBusinessLogicThread(context);

            const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(
                    () => reject(new Error('BusinessLogicValidation timeout')),
                    BusinessLogicValidationStage.TIMEOUT_MS,
                ),
            );

            const agentPromise =
                this.businessRulesValidationAgentProvider.execute({
                    organizationAndTeamData: context.organizationAndTeamData,
                    prepareContext,
                    thread,
                });

            const result = await Promise.race([agentPromise, timeoutPromise]);
            const classification = this.classifyResult(result);

            if (classification.kind === 'limitation') {
                // Surface the actual reason the agent gave up (MCP connection
                // failed, missing task context, etc.) at WARN level with a
                // preview of the agent's response. Without this the only
                // signal that the validation did not run is a separate WARN
                // from BusinessRulesValidationAgentProvider, which is easy
                // to miss when triaging a pipeline run.
                this.logger.warn({
                    message: `[BUSINESS-LOGIC] Skipped — agent could not validate: ${classification.message}`,
                    context: this.stageName,
                    metadata: {
                        organizationId:
                            context.organizationAndTeamData?.organizationId,
                        prNumber: context.pullRequest?.number,
                        outcome: classification.kind,
                        reason: 'agent_limitation',
                        agentResponsePreview: this.firstNonEmptyLine(result),
                        signals,
                    },
                });

                // Still surface the agent's response as a PR-level suggestion
                // so the user knows why business logic validation could not run
                // and what information is needed.
                const limitationSuggestion: ISuggestionByPR = {
                    id: uuidv4(),
                    suggestionContent: result,
                    oneSentenceSummary:
                        'Business logic gap detected based on PR requirements.',
                    label: LabelType.BUSINESS_LOGIC,
                    severity: SeverityLevel.MEDIUM,
                    deliveryStatus: DeliveryStatus.NOT_SENT,
                };

                return this.updateContext(context, (draft) => {
                    draft.businessLogicResults = [limitationSuggestion];
                    // Do NOT bump businessLogicPrBodyHash: the agent never
                    // actually validated this description, so the next run
                    // should still try.
                    draft.businessLogicOutcome = {
                        kind: 'skipped',
                        reason: 'agent_limitation',
                        message: `Skipped: business logic validation could not run (${classification.message}).`,
                    };
                });
            }

            this.logger.log({
                message: `[BUSINESS-LOGIC] Validation finished (outcome=${classification.kind})`,
                context: this.stageName,
                metadata: {
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                    prNumber: context.pullRequest?.number,
                    outcome: classification.kind,
                    signals,
                },
            });

            if (classification.kind === 'no_gap') {
                return this.updateContext(context, (draft) => {
                    draft.businessLogicResults = [];
                    draft.businessLogicPrBodyHash = prBodyHash;
                    draft.businessLogicOutcome = {
                        kind: 'success',
                        message:
                            'PR aligns with the requirements stated in the description.',
                    };
                });
            }

            const suggestion: ISuggestionByPR = {
                id: uuidv4(),
                suggestionContent: result,
                oneSentenceSummary:
                    'Business logic gap detected based on PR requirements.',
                label: LabelType.BUSINESS_LOGIC,
                severity: SeverityLevel.MEDIUM,
                deliveryStatus: DeliveryStatus.NOT_SENT,
            };

            return this.updateContext(context, (draft) => {
                draft.businessLogicResults = [suggestion];
                draft.businessLogicPrBodyHash = prBodyHash;
                draft.businessLogicOutcome = {
                    kind: 'gap_found',
                    message:
                        'Business logic gap detected — see PR-level comment.',
                };
            });
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);

            this.logger.error({
                message: `[BUSINESS-LOGIC] Validation failed for PR#${context.pullRequest?.number}: ${message}`,
                context: this.stageName,
                error,
            });

            const pipelineError: PipelineError = {
                stage: this.stageName,
                substage: 'BusinessRulesValidationAgent',
                error:
                    error instanceof Error ? error : new Error(String(error)),
                metadata: { prNumber: context.pullRequest?.number },
            };

            return this.updateContext(context, (draft) => {
                draft.businessLogicResults = [];
                draft.errors.push(pipelineError);
                draft.businessLogicOutcome = {
                    kind: 'error',
                    message: `Business logic validation failed: ${message}`,
                };
            });
        }
    }

    private async evaluateSkip(
        context: CodeReviewPipelineContext,
    ): Promise<{ reason: string; message: string } | null> {
        if (!context?.organizationAndTeamData) {
            return {
                reason: 'missing_org',
                message: 'Missing organization context.',
            };
        }
        if (!context?.pullRequest?.number) {
            return {
                reason: 'missing_pr',
                message: 'Missing pull request data.',
            };
        }
        if (!context?.repository?.id) {
            return {
                reason: 'missing_repo',
                message: 'Missing repository data.',
            };
        }

        if (!context.codeReviewConfig?.reviewOptions?.business_logic) {
            return {
                reason: 'option_off',
                message:
                    'Business logic validation is disabled in the code review configuration.',
            };
        }

        const prBody = context.pullRequest?.body ?? '';
        if (!this.hasBusinessSignals(prBody)) {
            return {
                reason: 'no_signals',
                message:
                    'Skipped: no ticket key (e.g. ABC-123), task link, or requirement keyword found in the PR description.',
            };
        }

        const currentHash = this.computePrBodyHash(prBody);
        const lastHash = (context.pipelineMetadata?.lastExecution as any)
            ?.businessLogicHash;
        if (lastHash && lastHash === currentHash) {
            return {
                reason: 'unchanged_body',
                message:
                    'Skipped: PR description has not changed since the last review.',
            };
        }

        return null;
    }

    private hasBusinessSignals(body: string): boolean {
        return (
            this.detectTicketKeys(body).length > 0 ||
            this.detectTaskLinks(body).length > 0
        );
    }

    private detectSignals(body: string): Record<string, string[]> {
        return {
            ticketKeys: this.detectTicketKeys(body),
            taskLinks: this.detectTaskLinks(body),
            requirementKeywords: this.detectRequirementKeywords(body),
        };
    }

    private detectTicketKeys(body: string): string[] {
        const matches = body.match(/[A-Z]{2,}-\d+/g);
        return matches ?? [];
    }

    private detectTaskLinks(body: string): string[] {
        const matches = body.match(/https?:\/\/[^\s)>\]"']+/g);
        return matches ?? [];
    }

    private detectRequirementKeywords(body: string): string[] {
        const lower = body.toLowerCase();
        return BusinessLogicValidationStage.REQUIREMENT_KEYWORDS.filter((kw) =>
            lower.includes(kw),
        );
    }

    private computePrBodyHash(body: string): string {
        return crypto.createHash('sha256').update(body).digest('hex');
    }

    /**
     * Classify the agent's output into one of three outcomes:
     *  - 'gap_found'  → a real business-logic gap was detected
     *  - 'no_gap'     → the PR is aligned with the requirements
     *  - 'limitation' → the agent could not validate (MCP down, missing
     *                   task context, etc.). This MUST NOT be reported as
     *                   success — the UI would claim the review passed
     *                   when no validation actually ran.
     */
    private classifyResult(
        result: string,
    ):
        | { kind: 'gap_found' }
        | { kind: 'no_gap' }
        | { kind: 'limitation'; message: string } {
        if (!result || result.trim().length === 0) {
            return {
                kind: 'limitation',
                message: 'Business logic agent returned an empty response.',
            };
        }

        const lower = result.toLowerCase();
        const limitationIndicators = [
            'need task information',
            'need pull request diff',
            'insufficient task context',
            'limited task context',
            'could not validate',
            'without the actual code changes, i can',
            'preciso do diff da pull request',
            'preciso de informacoes da task',
            'contexto insuficiente da task',
            'contexto limitado da task',
            'nao consegui validar',
            'sem as alteracoes de codigo',
            'mcp connection failed',
            'mcp integration required',
            'no compatible mcp integration',
        ];
        for (const indicator of limitationIndicators) {
            if (lower.includes(indicator)) {
                return {
                    kind: 'limitation',
                    message: this.firstNonEmptyLine(result),
                };
            }
        }

        const noGapIndicators = [
            'no gaps',
            'no issues',
            'fully compliant',
            'no business logic gap',
            'all requirements met',
            'implementation is complete',
            'no violations',
            '✅ compliant',
            'status: ✅',
            'sem bloqueios identificados',
            'requirements covered',
            '"needsmoreinfo": false',
        ];
        if (noGapIndicators.some((indicator) => lower.includes(indicator))) {
            return { kind: 'no_gap' };
        }

        return { kind: 'gap_found' };
    }

    private firstNonEmptyLine(text: string): string {
        for (const line of text.split('\n')) {
            // Strip markdown heading markers, leading emoji, and trailing
            // colons so the message reads as a plain sentence when embedded
            // into logs and UI status messages.
            const trimmed = line
                .replace(/^\s*#{1,6}\s*/, '')
                .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*/u, '')
                .replace(/\s*[:：]\s*$/, '')
                .trim();
            if (trimmed) {
                return trimmed.length > 240
                    ? trimmed.slice(0, 237) + '…'
                    : trimmed;
            }
        }
        return text.slice(0, 240);
    }

    private createBusinessLogicThread(context: CodeReviewPipelineContext) {
        try {
            const identifiers: Record<string, string | number> = {
                organizationId: context.organizationAndTeamData.organizationId,
                teamId: context.organizationAndTeamData.teamId,
                repositoryId: context.repository.id,
                pullRequestNumber: context.pullRequest.number,
            };

            if (context.userGitId) {
                identifiers.userId = context.userGitId;
            }

            return createThreadId(identifiers, { prefix: 'vbl' });
        } catch (error) {
            this.logger.warn({
                message: `Failed to create business logic thread for PR#${context.pullRequest?.number}`,
                context: this.stageName,
                error,
            });
            return undefined;
        }
    }
}
