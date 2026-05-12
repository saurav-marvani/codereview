import { createLogger } from '@kodus/flow';
import { Injectable, Inject, Optional } from '@nestjs/common';

import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import {
    WORKFLOW_JOB_REPOSITORY_TOKEN,
    IWorkflowJobRepository,
} from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { IJobProcessorService } from '@libs/core/workflow/domain/contracts/job-processor.service.contract';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import { RunCodeReviewAutomationUseCase } from '@libs/ee/automation/runCodeReview.use-case';
import { MetricsCollectorService } from '@libs/core/infrastructure/metrics/metrics-collector.service';
import { EnqueueCodeReviewJobInput } from '@libs/core/workflow/application/use-cases/enqueue-code-review-job.use-case';
import { ByokConcurrencyGateService } from './byok-concurrency-gate.service';
import { DistributedLock } from '@libs/core/workflow/infrastructure/distributed-lock.service';

@Injectable()
export class CodeReviewJobProcessorService implements IJobProcessorService {
    private readonly logger = createLogger(CodeReviewJobProcessorService.name);

    constructor(
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
        private readonly runCodeReviewAutomationUseCase: RunCodeReviewAutomationUseCase,
        private readonly byokConcurrencyGateService: ByokConcurrencyGateService,
        @Optional()
        private readonly metricsCollector?: MetricsCollectorService,
    ) {}

    async process(jobId: string, signal?: AbortSignal): Promise<void> {
        const job = await this.jobRepository.findOne(jobId);

        if (!job) {
            throw new Error(`Job ${jobId} not found`);
        }

        const correlationId = job.correlationId;

        this.logger.log({
            message: `Processing Code Review Job ${jobId}`,
            context: CodeReviewJobProcessorService.name,
            metadata: { jobId, correlationId },
        });

        if (signal?.aborted) {
            throw new Error(`Job ${jobId} aborted before start`);
        }

        const startTime = Date.now();
        let acquiredLock: DistributedLock | null = null;

        try {
            const jobPayload = job.payload || {};
            const {
                codeManagementPayload,
                event,
                platformType,
                organizationAndTeamData,
                teamAutomationId,
            } = jobPayload as EnqueueCodeReviewJobInput;

            if (
                !codeManagementPayload ||
                !event ||
                !platformType ||
                !organizationAndTeamData ||
                !teamAutomationId
            ) {
                throw new Error('Invalid payload: missing required fields');
            }

            const admission =
                await this.byokConcurrencyGateService.tryEnter(job);

            if (admission.kind === 'deferred') {
                await this.byokConcurrencyGateService.deferJob(job, admission);
                return;
            }

            if (admission.kind === 'acquired') {
                acquiredLock = admission.lock;
            }

            await this.jobRepository.update(jobId, {
                status: JobStatus.PROCESSING,
                startedAt: new Date(),
                metadata: this.removeByokConcurrencyGateMetadata(job.metadata),
            });

            await this.runCodeReviewAutomationUseCase.execute(
                {
                    codeManagementPayload,
                    event,
                    platformType,
                    correlationId,
                    organizationAndTeamData,
                    teamAutomationId,
                    workflowJobId: jobId,
                },
                signal,
            );

            await this.markCompleted(jobId);

            const durationMs = Date.now() - startTime;
            this.metricsCollector?.recordHistogram(
                'code_review_duration_ms',
                durationMs,
                { status: 'success' },
            );
        } catch (error) {
            if (error.name === 'WorkflowPausedError') {
                await this.jobRepository.update(jobId, {
                    status: JobStatus.WAITING_FOR_EVENT,
                    waitingForEvent: {
                        eventType: error.eventType,
                        eventKey: error.eventKey,
                    },
                });
                return;
            }

            this.logger.error({
                message: `Job ${jobId} failed`,
                error,
                context: CodeReviewJobProcessorService.name,
            });

            await this.handleFailure(jobId, error);
            throw error;
        } finally {
            if (acquiredLock && !acquiredLock.isReleased()) {
                try {
                    await acquiredLock.release();
                    this.logger.log({
                        message: `[BYOK-CONCURRENCY-GATE] released slot for job ${jobId}`,
                        context: CodeReviewJobProcessorService.name,
                        metadata: { jobId, correlationId },
                    });
                } catch (releaseError) {
                    this.logger.error({
                        message:
                            'Failed to release distributed BYOK concurrency slot',
                        error: releaseError,
                        context: CodeReviewJobProcessorService.name,
                        metadata: { jobId, correlationId },
                    });
                }
            }
        }
    }

    async handleFailure(jobId: string, error: Error): Promise<void> {
        this.metricsCollector?.recordCounter('code_review_errors_total', 1, {
            errorType: error.name || 'UnknownError',
        });

        await this.jobRepository.update(jobId, {
            status: JobStatus.FAILED,
            errorClassification: ErrorClassification.PERMANENT,
            lastError: error.message,
            failedAt: new Date(),
        });
    }

    async markCompleted(jobId: string, result?: unknown): Promise<void> {
        await this.jobRepository.update(jobId, {
            status: JobStatus.COMPLETED,
            completedAt: new Date(),
            result: result,
        });
    }

    private removeByokConcurrencyGateMetadata(
        metadata?: Record<string, unknown>,
    ): Record<string, unknown> | undefined {
        if (!metadata?.byokConcurrencyGate) {
            return metadata;
        }

        const nextMetadata = { ...metadata };
        delete nextMetadata.byokConcurrencyGate;

        return Object.keys(nextMetadata).length > 0 ? nextMetadata : undefined;
    }
}
