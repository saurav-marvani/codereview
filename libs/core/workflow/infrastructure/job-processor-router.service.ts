import { Injectable, Inject } from '@nestjs/common';
import { createLogger } from '@kodus/flow';

import { IJobProcessorRouter } from '@libs/core/workflow/domain/contracts/job-processor-router.contract';
import { IJobProcessorService } from '@libs/core/workflow/domain/contracts/job-processor.service.contract';
import {
    IWorkflowJobRepository,
    WORKFLOW_JOB_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';

import { WebhookProcessingJobProcessorService } from '@libs/automation/webhook-processing/webhook-processing-job.processor';
import { CodeReviewJobProcessorService } from '@libs/code-review/workflow/code-review-job-processor.service';

import { ImplementationVerificationProcessor } from '@libs/code-review/workflow/implementation-verification.processor';
import { AstGraphBuildJobProcessor } from '@libs/code-review/workflow/ast-graph-build-job.processor';
import { AstGraphIncrementalJobProcessor } from '@libs/code-review/workflow/ast-graph-incremental-job.processor';

const WEBHOOK_PROCESS_TIMEOUT_MS = 10 * 60 * 1000;
const CODE_REVIEW_PROCESS_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const CHECK_IMPLEMENTATION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const AST_GRAPH_BUILD_TIMEOUT_MS = 20 * 60 * 1000; // 20 min
const AST_GRAPH_INCREMENTAL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

@Injectable()
export class JobProcessorRouterService
    implements IJobProcessorService, IJobProcessorRouter
{
    private readonly logger = createLogger(JobProcessorRouterService.name);

    constructor(
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
        private readonly codeReviewProcessor: CodeReviewJobProcessorService,
        private readonly webhookProcessor: WebhookProcessingJobProcessorService,
        private readonly implementationVerificationProcessor: ImplementationVerificationProcessor,
        private readonly astGraphBuildProcessor: AstGraphBuildJobProcessor,
        private readonly astGraphIncrementalProcessor: AstGraphIncrementalJobProcessor,
    ) {}

    async process(jobId: string): Promise<void> {
        const job = await this.jobRepository.findOne(jobId);

        if (!job) {
            throw new Error(`Workflow job ${jobId} not found`);
        }

        const processor = this.getProcessor(job.workflowType);
        const timeoutMs = this.getProcessTimeoutMs(job.workflowType);

        try {
            return await this.runWithTimeout(
                processor.process(jobId),
                timeoutMs,
                `Workflow job ${jobId} timeout after ${timeoutMs}ms`,
            );
        } catch (error) {
            const isTimeout = error.message?.includes('timeout after');

            // Always mark job as FAILED when an error occurs (including timeout)
            try {
                await this.jobRepository.update(jobId, {
                    status: JobStatus.FAILED,
                    errorClassification: isTimeout
                        ? ErrorClassification.RETRYABLE
                        : ErrorClassification.PERMANENT,
                    lastError: error.message,
                });

                this.logger.error({
                    message: `Job ${jobId} marked as FAILED${isTimeout ? ' due to timeout' : ''}`,
                    context: JobProcessorRouterService.name,
                    error,
                    metadata: {
                        jobId,
                        workflowType: job.workflowType,
                        isTimeout,
                        timeoutMs,
                    },
                });
            } catch (updateError) {
                this.logger.error({
                    message: `Failed to update job ${jobId} status to FAILED`,
                    context: JobProcessorRouterService.name,
                    error: updateError,
                    metadata: { jobId, originalError: error.message },
                });
            }

            throw error;
        }
    }

    async handleFailure(jobId: string, error: Error): Promise<void> {
        const job = await this.jobRepository.findOne(jobId);

        if (!job) {
            throw new Error(`Workflow job ${jobId} not found`);
        }

        const processor = this.getProcessor(job.workflowType);
        return await processor.handleFailure(jobId, error);
    }

    async markCompleted(jobId: string, result?: unknown): Promise<void> {
        const job = await this.jobRepository.findOne(jobId);

        if (!job) {
            throw new Error(`Workflow job ${jobId} not found`);
        }

        const processor = this.getProcessor(job.workflowType);
        return await processor.markCompleted(jobId, result);
    }

    private getProcessor(workflowType: WorkflowType): IJobProcessorService {
        switch (workflowType) {
            case WorkflowType.WEBHOOK_PROCESSING:
                return this.webhookProcessor;
            case WorkflowType.CODE_REVIEW:
                return this.codeReviewProcessor;
            case WorkflowType.CHECK_SUGGESTION_IMPLEMENTATION:
                return this.implementationVerificationProcessor;
            case WorkflowType.AST_GRAPH_BUILD:
                return this.astGraphBuildProcessor;
            case WorkflowType.AST_GRAPH_INCREMENTAL:
                return this.astGraphIncrementalProcessor;
            default:
                throw new Error(
                    `No processor found for workflow type: ${workflowType}`,
                );
        }
    }

    private getProcessTimeoutMs(workflowType: WorkflowType): number {
        switch (workflowType) {
            case WorkflowType.WEBHOOK_PROCESSING:
                return WEBHOOK_PROCESS_TIMEOUT_MS;
            case WorkflowType.CODE_REVIEW:
                return CODE_REVIEW_PROCESS_TIMEOUT_MS;
            case WorkflowType.CHECK_SUGGESTION_IMPLEMENTATION:
                return CHECK_IMPLEMENTATION_TIMEOUT_MS;
            case WorkflowType.AST_GRAPH_BUILD:
                return AST_GRAPH_BUILD_TIMEOUT_MS;
            case WorkflowType.AST_GRAPH_INCREMENTAL:
                return AST_GRAPH_INCREMENTAL_TIMEOUT_MS;
            default:
                return CODE_REVIEW_PROCESS_TIMEOUT_MS;
        }
    }

    private async runWithTimeout<T>(
        promise: Promise<T>,
        timeoutMs: number,
        timeoutMessage: string,
    ): Promise<T> {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
                reject(new Error(timeoutMessage));
            }, timeoutMs);
        });

        try {
            return await Promise.race([promise, timeoutPromise]);
        } finally {
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        }
    }
}
