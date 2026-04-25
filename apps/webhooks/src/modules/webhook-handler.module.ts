import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { SharedCoreModule } from '@libs/shared/infrastructure/shared-core.module';
import { RabbitMQWrapperModule } from '@libs/core/infrastructure/queue/rabbitmq.module';
import { SharedPostgresModule } from '@libs/shared/database/shared-postgres.module';
import { SharedConfigModule } from '@libs/shared/infrastructure/shared-config.module';
import { SharedLogModule } from '@libs/shared/infrastructure/shared-log.module';
import { SharedObservabilityModule } from '@libs/shared/infrastructure/shared-observability.module';
import { LangfuseShutdownProvider } from '@libs/core/log/langfuse-shutdown.provider';
import { WebhookEnqueueModule } from './webhook-enqueue.module';

import { AzureReposController } from '../controllers/azureRepos.controller';
import { BitbucketController } from '../controllers/bitbucket.controller';
import { ForgejoController } from '../controllers/forgejo.controller';
import { GithubController } from '../controllers/github.controller';
import { GitlabController } from '../controllers/gitlab.controller';
import { WebhookHealthController } from '../controllers/webhook-health.controller';

@Module({
    imports: [
        SharedCoreModule,
        SharedConfigModule,
        SharedLogModule,
        SharedObservabilityModule,
        SharedPostgresModule.forRoot({ poolSize: 8 }),

        EventEmitterModule.forRoot(),
        RabbitMQWrapperModule.register({ enableConsumers: false }),
        WebhookEnqueueModule,
    ],
    controllers: [
        GithubController,
        GitlabController,
        BitbucketController,
        AzureReposController,
        ForgejoController,
        WebhookHealthController,
    ],
    providers: [LangfuseShutdownProvider],
})
export class WebhookHandlerModule {}
