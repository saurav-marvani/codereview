import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { TypeOrmModule } from '@nestjs/typeorm';

// Pipeline
import { FormatCliOutputStage } from './pipeline/stages/format-cli-output.stage';
import { PrepareCliFilesStage } from './pipeline/stages/prepare-cli-files.stage';
import { CliReviewPipelineStrategy } from './pipeline/strategy/cli-review-pipeline.strategy';

// Use Cases
import { ClassifyCliSessionCaptureUseCase } from './application/use-cases/classify-cli-session-capture.use-case';
import { ClassifySessionUseCase } from './application/use-cases/classify-session.use-case';
import { EnqueueCliReviewUseCase } from './application/use-cases/enqueue-cli-review.use-case';
import { ExecuteCliReviewUseCase } from './application/use-cases/execute-cli-review.use-case';
import { GetCliReviewByIdUseCase } from './application/use-cases/dashboard/get-cli-review-by-id.use-case';
import { GetCliReviewsUseCase } from './application/use-cases/dashboard/get-cli-reviews.use-case';
import { GetCliReviewJobStatusUseCase } from './application/use-cases/get-cli-review-job-status.use-case';
import { IngestSessionEventUseCase } from './application/use-cases/ingest-session-event.use-case';
import { SubmitCliSessionCaptureUseCase } from './application/use-cases/submit-cli-session-capture.use-case';
import { WaitForCliReviewJobUseCase } from './application/use-cases/wait-for-cli-review-job.use-case';

// Workflow
import { CliReviewJobProcessorService } from './workflow/cli-review-job-processor.service';

// Services
import { CliInputConverter } from './infrastructure/converters/cli-input.converter';
import { CliSessionCaptureRepository } from './infrastructure/repositories/cli-session-capture.repository';
import {
    CliSessionCaptureModel,
    CliSessionCaptureSchema,
} from './infrastructure/repositories/schemas/cli-session-capture.model';
import { SessionEventModel } from './infrastructure/repositories/schemas/session-event.model';
import { SessionEventRepository } from './infrastructure/repositories/session-event.repository';
import { AuthenticatedRateLimiterService } from './infrastructure/services/authenticated-rate-limiter.service';
import { TrialRateLimiterService } from './infrastructure/services/trial-rate-limiter.service';

// External dependencies
import { AutomationModule } from '@libs/automation/modules/automation.module';
import { CodeReviewCoreModule } from '@libs/code-review/modules/code-review-core.module';
import { CodeReviewPipelineModule } from '@libs/code-review/pipeline/code-review-pipeline.module';
import { GlobalCacheModule } from '@libs/core/cache/cache.module';
import { LicenseModule } from '@libs/ee/license/license.module';
import { KodyRulesModule } from '@libs/kodyRules/modules/kodyRules.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { TeamModule } from '@libs/organization/modules/team.module';

// Workflow infra (provided locally to avoid an ESM circular import with
// WorkflowModule, which itself imports CliReviewModule on the worker side).
// Same pattern used by apps/webhooks/.../webhook-enqueue.module.ts.
import { WorkflowQueueLoader } from '@libs/core/infrastructure/config/loaders/workflow-queue.loader';
import { JOB_QUEUE_SERVICE_TOKEN } from '@libs/core/workflow/domain/contracts/job-queue.service.contract';
import { WORKFLOW_JOB_REPOSITORY_TOKEN } from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { OUTBOX_MESSAGE_REPOSITORY_TOKEN } from '@libs/core/workflow/domain/contracts/outbox-message.repository.contract';
import { WorkflowJobQueueService } from '@libs/core/workflow/infrastructure/workflow-job-queue.service';
import { WorkflowJobRepository } from '@libs/core/workflow/infrastructure/repositories/workflow-job.repository';
import { WorkflowJobModel } from '@libs/core/workflow/infrastructure/repositories/schemas/workflow-job.model';
import { OutboxMessageRepository } from '@libs/core/workflow/infrastructure/repositories/outbox-message.repository';
import { OutboxMessageModel } from '@libs/core/workflow/infrastructure/repositories/schemas/outbox-message.model';

/**
 * Module for CLI code review functionality
 * Provides a simplified pipeline for analyzing code from CLI
 */
@Module({
    imports: [
        ConfigModule.forFeature(WorkflowQueueLoader),
        MongooseModule.forFeature([
            {
                name: CliSessionCaptureModel.name,
                schema: CliSessionCaptureSchema,
            },
        ]),
        TypeOrmModule.forFeature([
            SessionEventModel,
            WorkflowJobModel,
            OutboxMessageModel,
        ]),
        forwardRef(() => CodeReviewPipelineModule), // For reusing stages
        forwardRef(() => CodeReviewCoreModule), // For CODE_REVIEW_EXECUTION_SERVICE
        forwardRef(() => ParametersModule), // For config loading
        forwardRef(() => TeamModule), // For Team CLI Key validation
        forwardRef(() => GlobalCacheModule), // For rate limiting
        forwardRef(() => AutomationModule), // For tracking executions
        forwardRef(() => LicenseModule), // For license validation and auto-assign
        forwardRef(() => KodyRulesModule), // For loading kody rules in CLI review
    ],
    providers: [
        // Strategy
        CliReviewPipelineStrategy,

        // Stages
        PrepareCliFilesStage,
        FormatCliOutputStage,

        // Use Cases
        EnqueueCliReviewUseCase,
        ExecuteCliReviewUseCase,
        GetCliReviewByIdUseCase,
        GetCliReviewsUseCase,
        GetCliReviewJobStatusUseCase,
        WaitForCliReviewJobUseCase,
        SubmitCliSessionCaptureUseCase,
        ClassifyCliSessionCaptureUseCase,
        IngestSessionEventUseCase,
        ClassifySessionUseCase,

        // Workflow
        CliReviewJobProcessorService,

        // Workflow infra (local to avoid circular import with WorkflowModule)
        WorkflowJobRepository,
        OutboxMessageRepository,
        {
            provide: WORKFLOW_JOB_REPOSITORY_TOKEN,
            useClass: WorkflowJobRepository,
        },
        {
            provide: OUTBOX_MESSAGE_REPOSITORY_TOKEN,
            useClass: OutboxMessageRepository,
        },
        {
            provide: JOB_QUEUE_SERVICE_TOKEN,
            useClass: WorkflowJobQueueService,
        },

        // Services
        CliInputConverter,
        TrialRateLimiterService,
        AuthenticatedRateLimiterService,
        CliSessionCaptureRepository,
        SessionEventRepository,
    ],
    exports: [
        // Export use case and services for controllers
        EnqueueCliReviewUseCase,
        ExecuteCliReviewUseCase,
        GetCliReviewByIdUseCase,
        GetCliReviewsUseCase,
        GetCliReviewJobStatusUseCase,
        WaitForCliReviewJobUseCase,
        SubmitCliSessionCaptureUseCase,
        IngestSessionEventUseCase,
        ClassifySessionUseCase,
        CliReviewJobProcessorService,
        SessionEventRepository,
        TrialRateLimiterService,
        AuthenticatedRateLimiterService,
        SessionEventRepository,
        ClassifySessionUseCase,
        JOB_QUEUE_SERVICE_TOKEN,
    ],
})
export class CliReviewModule {}
