import { createLogger } from '@kodus/flow';
import { Injectable, Inject } from '@nestjs/common';

import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import {
    WORKFLOW_JOB_REPOSITORY_TOKEN,
    IWorkflowJobRepository,
} from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { IJobProcessorService } from '@libs/core/workflow/domain/contracts/job-processor.service.contract';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';

import { ExecuteCliReviewUseCase } from '@libs/cli-review/application/use-cases/execute-cli-review.use-case';
import { CliReviewJobPayload } from './cli-review-job.types';

@Injectable()
export class CliReviewJobProcessorService implements IJobProcessorService {
    private readonly logger = createLogger(CliReviewJobProcessorService.name);

    constructor(
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
        private readonly executeCliReviewUseCase: ExecuteCliReviewUseCase,
    ) {}

    async process(jobId: string, signal?: AbortSignal): Promise<void> {
        const job = await this.jobRepository.findOne(jobId);
        if (!job) {
            throw new Error(`CLI review job ${jobId} not found`);
        }

        if (signal?.aborted) {
            throw new Error(`Job ${jobId} aborted before start`);
        }

        const payload = job.payload as CliReviewJobPayload;
        if (
            !payload?.organizationAndTeamData ||
            !payload?.input
        ) {
            throw new Error(
                `Invalid CLI review payload for job ${jobId}: missing required fields`,
            );
        }

        await this.jobRepository.update(jobId, {
            status: JobStatus.PROCESSING,
            startedAt: new Date(),
        });

        try {
            const result = await this.executeCliReviewUseCase.execute({
                organizationAndTeamData: payload.organizationAndTeamData,
                input: payload.input,
                isTrialMode: payload.isTrialMode,
                userEmail: payload.userEmail,
                gitContext: payload.gitContext,
                cliAuth: payload.cliAuth,
            });

            await this.markCompleted(jobId, result);
        } catch (error) {
            this.logger.error({
                message: `CLI review job ${jobId} failed`,
                error,
                context: CliReviewJobProcessorService.name,
                metadata: { jobId, correlationId: job.correlationId },
            });

            await this.handleFailure(jobId, error);
            throw error;
        }
    }

    async handleFailure(jobId: string, error: Error): Promise<void> {
        await this.jobRepository.update(jobId, {
            status: JobStatus.FAILED,
            errorClassification: ErrorClassification.PERMANENT,
            lastError: error.message,
            failedAt: new Date(),
        } as any);
    }

    async markCompleted(jobId: string, result?: unknown): Promise<void> {
        const job = await this.jobRepository.findOne(jobId);
        const existingMetadata = job?.metadata || {};

        await this.jobRepository.update(jobId, {
            status: JobStatus.COMPLETED,
            completedAt: new Date(),
            metadata: {
                ...existingMetadata,
                result,
            },
        });
    }
}
