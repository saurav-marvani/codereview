import * as dotenv from 'dotenv';
dotenv.config();

// rabbitMQWrapper.module.ts
import { RabbitMQModule } from '@golevelup/nestjs-rabbitmq';
import {
    Module,
    DynamicModule,
    Provider,
    Global,
    ModuleMetadata,
    Type,
    ForwardReference,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { MESSAGE_BROKER_SERVICE_TOKEN } from '@libs/core/domain/contracts/message-broker.service.contracts';
import { RabbitMQLoader } from '@libs/core/infrastructure/config/loaders/rabbitmq.loader';
import { RabbitMQErrorHandler } from '@libs/core/infrastructure/queue/rabbitmq-error.handler';
import { RabbitMQDLQInitializer } from '@libs/core/infrastructure/queue/rabbitmq-dlq.initializer';
import { MessageBrokerService } from '@libs/core/infrastructure/queue/messageBroker/messageBroker.service';
import { RabbitMQConnectionLoggerService } from '@libs/core/infrastructure/queue/rabbitmq-connection-logger.service';
import { RABBITMQ_TOPOLOGY_CONFIG } from './config/rabbitmq-topology.config';

export interface RabbitMQWrapperOptions {
    enableConsumers: boolean;
}

@Global()
@Module({})
export class RabbitMQWrapperModule {
    static register(
        options: RabbitMQWrapperOptions = { enableConsumers: true },
    ): DynamicModule {
        const imports: (
            | Type<any>
            | DynamicModule
            | Promise<DynamicModule>
            | ForwardReference
        )[] = [ConfigModule.forRoot(), ConfigModule.forFeature(RabbitMQLoader)];

        const rabbitMQEnabled = process.env.API_RABBITMQ_ENABLED !== 'false';
        const providers: Provider[] = [
            {
                provide: MESSAGE_BROKER_SERVICE_TOKEN,
                useClass: MessageBrokerService,
            },
            RabbitMQConnectionLoggerService,
            RabbitMQDLQInitializer,
        ];
        if (rabbitMQEnabled) {
            providers.push(RabbitMQErrorHandler);
        }

        const exports: ModuleMetadata['exports'] = [
            MESSAGE_BROKER_SERVICE_TOKEN,
        ];

        // Using a factory function to obtain the ConfigService
        const rabbitMQModule = RabbitMQModule.forRootAsync({
            imports: [ConfigModule],
            useFactory: async (configService: ConfigService) => {
                const rabbitMQEnabled =
                    process.env.API_RABBITMQ_ENABLED !== 'false';

                console.log(
                    `[RabbitMQWrapperModule] Factory running. ENABLED=${rabbitMQEnabled}, ENV_VAR=${process.env.API_RABBITMQ_ENABLED}`,
                );

                if (!rabbitMQEnabled) {
                    console.log(
                        `[RabbitMQWrapperModule] Returning empty config because it is disabled.`,
                    );
                    return null;
                }

                return {
                    exchanges: RABBITMQ_TOPOLOGY_CONFIG.exchanges,
                    uri: configService.get<string>(
                        'rabbitMQConfig.API_RABBITMQ_URI',
                    ),
                    connectionInitOptions: {
                        wait: false,
                        timeout: 5000,
                    },
                    // Both options live under connectionManagerOptions in
                    // @golevelup/nestjs-rabbitmq v9. Before this PR the
                    // `reconnectTimeInSeconds` sat at the top level where it
                    // was silently ignored, causing the library to fall back
                    // to amqp-connection-manager's 5s default instead of the
                    // 10s we intended.
                    connectionManagerOptions: {
                        heartbeatIntervalInSeconds: 60,
                        reconnectTimeInSeconds: 10,
                    },
                    enableControllerDiscovery: options.enableConsumers,
                    prefetchCount:
                        configService.get<number>(
                            'workflowQueue.WORKFLOW_QUEUE_PUBLISHER_PREFETCH',
                        ) ??
                        configService.get<number>(
                            'workflowQueue.WORKFLOW_QUEUE_WORKER_PREFETCH',
                        ) ??
                        5,
                    channels: {
                        'channel-webhook': {
                            prefetchCount:
                                configService.get<number>(
                                    'workflowQueue.WORKFLOW_QUEUE_WEBHOOK_PREFETCH',
                                ) ?? 20,
                            default: false,
                        },
                        'channel-code-review': {
                            prefetchCount:
                                configService.get<number>(
                                    'workflowQueue.WORKFLOW_QUEUE_CODE_REVIEW_PREFETCH',
                                ) ?? 20,
                            default: false,
                        },
                        'channel-check-implementation': {
                            prefetchCount:
                                configService.get<number>(
                                    'workflowQueue.WORKFLOW_QUEUE_CHECK_IMPLEMENTATION_PREFETCH',
                                ) ?? 20,
                            default: false,
                        },
                        'channel-feedback': {
                            prefetchCount:
                                configService.get<number>(
                                    'workflowQueue.WORKFLOW_QUEUE_FEEDBACK_PREFETCH',
                                ) ?? 20,
                            default: false,
                        },
                        'channel-ast-graph-build': {
                            prefetchCount: 2,
                            default: false,
                        },
                        'channel-ast-graph-incremental': {
                            prefetchCount: 5,
                            default: false,
                        },
                    },
                };
            },
            inject: [ConfigService],
        });

        console.log(
            `[RabbitMQWrapperModule] Registering module. ENABLED=${rabbitMQEnabled}, ENV_VAR=${process.env.API_RABBITMQ_ENABLED}`,
        );

        if (rabbitMQEnabled) {
            console.log(
                '[RabbitMQWrapperModule] RabbitMQ is ENABLED. Adding RabbitMQModule to imports.',
            );
            imports.push(rabbitMQModule);
            exports.push(rabbitMQModule);
        } else {
            console.log(
                '[RabbitMQWrapperModule] RabbitMQ is DISABLED. Skipping RabbitMQModule import.',
            );
        }

        return {
            module: RabbitMQWrapperModule,
            imports: imports,
            providers: providers,
            exports: exports,
        };
    }
}
