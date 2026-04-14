import { Injectable, Inject } from '@nestjs/common';
import {
    COMMENT_MANAGER_SERVICE_TOKEN,
    ICommentManagerService,
} from '@libs/code-review/domain/contracts/CommentManagerService.contract';
import { createLogger } from '@kodus/flow';
import { PullRequestMessageStatus } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import { BehaviourForNewCommits } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { PipelineError } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-context.interface';

@Injectable()
export class UpdateCommentsAndGenerateSummaryStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'UpdateCommentsAndGenerateSummaryStage';
    readonly label = 'Generating Summary';
    readonly visibility = StageVisibility.PRIMARY;

    private readonly logger = createLogger(
        UpdateCommentsAndGenerateSummaryStage.name,
    );

    constructor(
        @Inject(COMMENT_MANAGER_SERVICE_TOKEN)
        private readonly commentManagerService: ICommentManagerService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const {
            lastExecution,
            codeReviewConfig,
            repository,
            pullRequest,
            organizationAndTeamData,
            platformType,
            initialCommentData,
            lineComments,
        } = context;

        const isCommitRun = Boolean(lastExecution);
        const commitBehaviour =
            codeReviewConfig?.summary?.behaviourForNewCommits ??
            BehaviourForNewCommits.NONE;

        const shouldGenerateOrUpdateSummary =
            (!isCommitRun && codeReviewConfig?.summary?.generatePRSummary) ||
            (isCommitRun &&
                codeReviewConfig?.summary?.generatePRSummary &&
                commitBehaviour !== BehaviourForNewCommits.NONE);

        if (
            !initialCommentData &&
            !context.pullRequestMessagesConfig?.startReviewMessage
        ) {
            this.logger.warn({
                message: `Missing initialCommentData for PR#${pullRequest.number}`,
                context: this.stageName,
            });
            return context;
        }

        if (shouldGenerateOrUpdateSummary) {
            try {
                this.logger.log({
                    message: `Generating summary for PR#${pullRequest.number}`,
                    context: this.stageName,
                    metadata: {
                        organizationAndTeamData,
                        prNumber: context.pullRequest.number,
                        repository: context.repository,
                    },
                });

                const changedFiles = context.changedFiles.map((file) => ({
                    filename: file.filename,
                    patch: file.patch,
                    status: file.status,
                }));

                const summaryPR =
                    await this.commentManagerService.generateSummaryPR(
                        pullRequest,
                        repository,
                        changedFiles,
                        organizationAndTeamData,
                        codeReviewConfig.languageResultPrompt,
                        codeReviewConfig.summary,
                        codeReviewConfig?.byokConfig ?? null,
                        isCommitRun,
                        false,
                        context.externalPromptContext,
                    );

                await this.commentManagerService.updateSummarizationInPR(
                    organizationAndTeamData,
                    pullRequest.number,
                    repository,
                    summaryPR,
                    context.dryRun,
                );
            } catch (error) {
                this.logger.error({
                    message: `Failed to generate summary for PR#${pullRequest.number}`,
                    context: this.stageName,
                    error,
                });

                const pipelineError: PipelineError = {
                    stage: this.stageName,
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    metadata: {
                        message: 'Failed to generate summary',
                        reason: 'summary_generation_failed',
                    },
                };

                if (!context.errors) {
                    context.errors = [];
                }
                context.errors.push(pipelineError);
            }
        }

        const startReviewMessage =
            context.pullRequestMessagesConfig?.startReviewMessage;
        const endReviewMessage =
            context.pullRequestMessagesConfig?.endReviewMessage;

        if (!endReviewMessage) {
            await this.commentManagerService.updateOverallComment(
                organizationAndTeamData,
                pullRequest.number,
                repository,
                initialCommentData.commentId,
                initialCommentData.noteId,
                platformType,
                lineComments,
                codeReviewConfig,
                initialCommentData.threadId,
                undefined,
                context.dryRun,
            );
            return context;
        }

        if (
            endReviewMessage.status === PullRequestMessageStatus.OFF ||
            endReviewMessage.status === PullRequestMessageStatus.INACTIVE
        ) {
            return context;
        }

        if (
            endReviewMessage.status ===
                PullRequestMessageStatus.ONLY_WHEN_OPENED &&
            context.lastExecution
        ) {
            return context;
        }

        if (
            (endReviewMessage.status === PullRequestMessageStatus.ACTIVE ||
                endReviewMessage.status ===
                    PullRequestMessageStatus.EVERY_PUSH ||
                (endReviewMessage.status ===
                    PullRequestMessageStatus.ONLY_WHEN_OPENED &&
                    !context.lastExecution)) &&
            startReviewMessage &&
            (startReviewMessage.status === PullRequestMessageStatus.ACTIVE ||
                startReviewMessage.status ===
                    PullRequestMessageStatus.EVERY_PUSH ||
                (startReviewMessage.status ===
                    PullRequestMessageStatus.ONLY_WHEN_OPENED &&
                    !context.lastExecution))
        ) { 
            const finalCommentBody =
                await this.commentManagerService.processEndReviewMessageTemplate(
                    endReviewMessage.content,
                    context.changedFiles,
                    organizationAndTeamData,
                    pullRequest.number,
                    codeReviewConfig,
                    codeReviewConfig?.languageResultPrompt ?? 'en-US',
                    platformType,
                    lineComments,
                );

            await this.commentManagerService.updateOverallComment(
                organizationAndTeamData,
                pullRequest.number,
                repository,
                initialCommentData.commentId,
                initialCommentData.noteId,
                platformType,
                lineComments,
                codeReviewConfig,
                initialCommentData.threadId,
                finalCommentBody,
                context.dryRun,
            );
            return context;
        }

        if (
            (endReviewMessage.status === PullRequestMessageStatus.ACTIVE ||
                endReviewMessage.status ===
                    PullRequestMessageStatus.EVERY_PUSH ||
                (endReviewMessage.status ===
                    PullRequestMessageStatus.ONLY_WHEN_OPENED &&
                    !context.lastExecution)) &&
            (!startReviewMessage ||
                startReviewMessage.status ===
                    PullRequestMessageStatus.INACTIVE ||
                startReviewMessage.status === PullRequestMessageStatus.OFF ||
                (startReviewMessage.status ===
                    PullRequestMessageStatus.ONLY_WHEN_OPENED &&
                    context.lastExecution))
        ) {
            const finalCommentBody = endReviewMessage.content;

            await this.commentManagerService.createComment(
                organizationAndTeamData,
                pullRequest.number,
                repository,
                platformType,
                context.changedFiles,
                context.codeReviewConfig?.languageResultPrompt ?? 'en-US',
                lineComments,
                codeReviewConfig,
                finalCommentBody,
                context.pullRequestMessagesConfig,
                context.dryRun,
                context.prLevelCommentResults ?? [],
            );
        }

        return context;
    }
}
