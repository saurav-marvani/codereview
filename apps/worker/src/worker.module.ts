import { DynamicModule, Module, Provider } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { LLMModule } from '@kodus/kodus-common/llm';

import { AnalyticsWarehouseModule } from '@libs/analytics-warehouse';
import { AutomationModule } from '@libs/automation/modules/automation.module';
import { CodebaseModule } from '@libs/code-review/modules/codebase.module';
import { CodeReviewFeedbackModule } from '@libs/code-review/modules/codeReviewFeedback.module';
import { IncidentModule } from '@libs/core/infrastructure/incident/incident.module';
import { ErrorRateMonitorService } from '@libs/core/infrastructure/metrics/error-rate-monitor.service';
import { MetricsModule } from '@libs/core/infrastructure/metrics/metrics.module';
import { ReviewResponseMonitorService } from '@libs/core/infrastructure/metrics/review-response-monitor.service';
import { WebhookFailureMonitorService } from '@libs/core/infrastructure/metrics/webhook-failure-monitor.service';
import { RabbitMQWrapperModule } from '@libs/core/infrastructure/queue/rabbitmq.module';
import { LangfuseShutdownProvider } from '@libs/core/log/langfuse-shutdown.provider';
import { LoggerWrapperService } from '@libs/core/log/loggerWrapper.service';
import { OutboxRelayService } from '@libs/core/workflow/infrastructure/outbox-relay.service';
import { WorkflowModule } from '@libs/core/workflow/modules/workflow.module';
import { PlatformModule } from '@libs/platform/modules/platform.module';
import { SharedMongoModule } from '@libs/shared/database/shared-mongo.module';
import { SharedPostgresModule } from '@libs/shared/database/shared-postgres.module';
import { SharedConfigModule } from '@libs/shared/infrastructure/shared-config.module';
import { SharedLogModule } from '@libs/shared/infrastructure/shared-log.module';
import { SharedObservabilityModule } from '@libs/shared/infrastructure/shared-observability.module';

import { AnalyticsClassifierCron } from './cron/analytics-classifier.cron';
import { AnalyticsIngestionCron } from './cron/analytics-ingestion.cron';
import { resolveWorkerRole, type WorkerRole } from './worker-role';
import { WorkerDrainService } from './worker-drain.service';
import { WorkerHealthGuardService } from './worker-health-guard.service';

/**
 * Worker boots code-review OR analytics — never both. See
 * `./worker-role.ts` for the contract. Cloud and self-hosted run both
 * replicas so the topology is identical across environments.
 */
@Module({})
export class WorkerModule {
    static forRoot(): DynamicModule {
        const role: WorkerRole = resolveWorkerRole();

        const baseImports = [
            ScheduleModule.forRoot(),
            SharedConfigModule,
            SharedLogModule,
            SharedObservabilityModule,
            IncidentModule,
            MetricsModule,
            // Both roles read Mongo: code-review writes PR state; analytics
            // reads `pullRequests` for ingestion.
            SharedMongoModule.forRoot(),
        ];

        if (role === 'code-review') {
            return {
                module: WorkerModule,
                imports: [
                    ...baseImports,
                    SharedPostgresModule.forRoot({ poolSize: 12 }),
                    RabbitMQWrapperModule.register({ enableConsumers: true }),
                    LLMModule.forRoot({ logger: LoggerWrapperService }),
                    WorkflowModule.register({ type: 'worker' }),
                    CodebaseModule,
                    CodeReviewFeedbackModule,
                    AutomationModule,
                    PlatformModule,
                ],
                providers: [
                    WorkerDrainService,
                    WorkerHealthGuardService,
                    OutboxRelayService,
                    ErrorRateMonitorService,
                    ReviewResponseMonitorService,
                    WebhookFailureMonitorService,
                    LangfuseShutdownProvider,
                ] satisfies Provider[],
            };
        }

        // analytics
        return {
            module: WorkerModule,
            imports: [
                ...baseImports,
                // LLM is needed by the PR-type classifier; the ingestion
                // hot path itself doesn't call any model.
                LLMModule.forRoot({ logger: LoggerWrapperService }),
                AnalyticsWarehouseModule.forRoot(),
            ],
            providers: [
                WorkerDrainService,
                WorkerHealthGuardService,
                AnalyticsIngestionCron,
                AnalyticsClassifierCron,
                LangfuseShutdownProvider,
            ] satisfies Provider[],
        };
    }
}
