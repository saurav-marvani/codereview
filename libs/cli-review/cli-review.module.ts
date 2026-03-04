import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TypeOrmModule } from '@nestjs/typeorm';

// Pipeline
import { CliReviewPipelineStrategy } from './pipeline/strategy/cli-review-pipeline.strategy';
import { PrepareCliFilesStage } from './pipeline/stages/prepare-cli-files.stage';
import { FormatCliOutputStage } from './pipeline/stages/format-cli-output.stage';

// Use Cases
import { ExecuteCliReviewUseCase } from './application/use-cases/execute-cli-review.use-case';
import { SubmitCliSessionCaptureUseCase } from './application/use-cases/submit-cli-session-capture.use-case';
import { ClassifyCliSessionCaptureUseCase } from './application/use-cases/classify-cli-session-capture.use-case';
import { IngestSessionEventUseCase } from './application/use-cases/ingest-session-event.use-case';
import { ClassifySessionUseCase } from './application/use-cases/classify-session.use-case';

// Services
import { CliInputConverter } from './infrastructure/converters/cli-input.converter';
import { TrialRateLimiterService } from './infrastructure/services/trial-rate-limiter.service';
import { AuthenticatedRateLimiterService } from './infrastructure/services/authenticated-rate-limiter.service';
import { CliSessionCaptureRepository } from './infrastructure/repositories/cli-session-capture.repository';
import { SessionEventRepository } from './infrastructure/repositories/session-event.repository';
import {
    CliSessionCaptureModel,
    CliSessionCaptureSchema,
} from './infrastructure/repositories/schemas/cli-session-capture.model';
import { SessionEventModel } from './infrastructure/repositories/schemas/session-event.model';

// External dependencies
import { CodeReviewPipelineModule } from '@libs/code-review/pipeline/code-review-pipeline.module';
import { ParametersModule } from '@libs/organization/modules/parameters.module';
import { TeamModule } from '@libs/organization/modules/team.module';
import { GlobalCacheModule } from '@libs/core/cache/cache.module';
import { AutomationModule } from '@libs/automation/modules/automation.module';
import { LicenseModule } from '@libs/ee/license/license.module';

/**
 * Module for CLI code review functionality
 * Provides a simplified pipeline for analyzing code from CLI
 */
@Module({
    imports: [
        MongooseModule.forFeature([
            {
                name: CliSessionCaptureModel.name,
                schema: CliSessionCaptureSchema,
            },
        ]),
        TypeOrmModule.forFeature([SessionEventModel]),
        forwardRef(() => CodeReviewPipelineModule), // For reusing stages
        forwardRef(() => ParametersModule), // For config loading
        forwardRef(() => TeamModule), // For Team CLI Key validation
        forwardRef(() => GlobalCacheModule), // For rate limiting
        forwardRef(() => AutomationModule), // For tracking executions
        forwardRef(() => LicenseModule), // For license validation and auto-assign
    ],
    providers: [
        // Strategy
        CliReviewPipelineStrategy,

        // Stages
        PrepareCliFilesStage,
        FormatCliOutputStage,

        // Use Cases
        ExecuteCliReviewUseCase,
        SubmitCliSessionCaptureUseCase,
        ClassifyCliSessionCaptureUseCase,
        IngestSessionEventUseCase,
        ClassifySessionUseCase,

        // Services
        CliInputConverter,
        TrialRateLimiterService,
        AuthenticatedRateLimiterService,
        CliSessionCaptureRepository,
        SessionEventRepository,
    ],
    exports: [
        // Export use case and services for controllers
        ExecuteCliReviewUseCase,
        SubmitCliSessionCaptureUseCase,
        IngestSessionEventUseCase,
        TrialRateLimiterService,
        AuthenticatedRateLimiterService,
    ],
})
export class CliReviewModule {}
