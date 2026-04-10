import * as os from 'os';
import {
    RabbitSubscribe,
    MessageHandlerErrorBehavior,
} from '@golevelup/nestjs-rabbitmq';
import { Injectable, Inject, OnApplicationShutdown } from '@nestjs/common';
import { ConsumeMessage } from 'amqplib';

import { IJobProcessorService } from '@libs/core/workflow/domain/contracts/job-processor.service.contract';
import { JOB_PROCESSOR_SERVICE_TOKEN } from '@libs/core/workflow/domain/contracts/job-processor.service.contract';
import { MessagePayload } from '@libs/core/domain/contracts/message-broker.service.contracts';
import {
    IWorkflowJobRepository,
    WORKFLOW_JOB_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';

import { ObservabilityService } from '@libs/core/log/observability.service';
import { createLogger } from '@kodus/flow';
import {
    IInboxMessageRepository,
    INBOX_MESSAGE_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/inbox-message.repository.contract';
import { InboxStatus } from './repositories/schemas/inbox-message.model';
import { RabbitMQErrorHandler } from '@libs/core/infrastructure/queue/rabbitmq-error.handler';
import {
    ITaskProtectionService,
    TASK_PROTECTION_SERVICE_TOKEN,
} from '../domain/contracts/task-protection.service.contract';

interface WorkflowJobMessage {
    jobId: string;
    correlationId?: string;
    [key: string]: unknown;
}

const createErrorHandlerWithFallback = (dlqRoutingKey: string) => {
    return (channel: any, msg: ConsumeMessage, _err: any) => {
        if (RabbitMQErrorHandler.instance) {
            return RabbitMQErrorHandler.instance.handle(channel, msg, _err, {
                dlqRoutingKey,
            });
        }
        if (msg) {
            channel.ack(msg);
        }
    };
};

@Injectable()
export class WorkflowJobConsumer implements OnApplicationShutdown {
    private readonly logger = createLogger(WorkflowJobConsumer.name);
    private readonly instanceId = os.hostname();
    // Default ECS protection time in minutes
    private readonly JOB_PROTECTION_MINUTES = 60;
    private activeJobs = 0;

    constructor(
        @Inject(JOB_PROCESSOR_SERVICE_TOKEN)
        private readonly jobProcessor: IJobProcessorService,
        @Inject(INBOX_MESSAGE_REPOSITORY_TOKEN)
        private readonly inboxRepository: IInboxMessageRepository,
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
        private readonly observability: ObservabilityService,
        @Inject(TASK_PROTECTION_SERVICE_TOKEN)
        private readonly taskProtectionService: ITaskProtectionService,
    ) {}

    /**
     * Webhook-processing jobs
     * Delayed exchange bindings are created by RabbitMQDLQInitializer.
     */
    @RabbitSubscribe({
        exchange: 'workflow.exchange',
        routingKey: 'workflow.jobs.*.WEBHOOK_PROCESSING',
        queue: 'workflow.jobs.webhook.queue',
        errorBehavior: MessageHandlerErrorBehavior.ACK,
        errorHandler: createErrorHandlerWithFallback('workflow.job.failed'),
        queueOptions: {
            channel: 'channel-webhook',
            arguments: {
                'x-queue-type': 'quorum',
                'x-dead-letter-exchange': 'workflow.exchange.dlx',
                'x-dead-letter-routing-key': 'workflow.job.failed',
            },
        },
    })
    async handleWebhookProcessingJob(
        message: WorkflowJobMessage | MessagePayload<WorkflowJobMessage>,
        amqpMsg: ConsumeMessage,
    ): Promise<void> {
        return this.handleWorkflowJob(
            'workflow-job-consumer.webhook',
            'workflow.jobs.webhook.queue',
            message,
            amqpMsg,
        );
    }

    /**
     * Code-review jobs
     * Delayed exchange bindings are created by RabbitMQDLQInitializer.
     */
    @RabbitSubscribe({
        exchange: 'workflow.exchange',
        routingKey: 'workflow.jobs.*.CODE_REVIEW',
        queue: 'workflow.jobs.code_review.queue',
        errorBehavior: MessageHandlerErrorBehavior.ACK,
        errorHandler: createErrorHandlerWithFallback('workflow.job.failed'),
        queueOptions: {
            channel: 'channel-code-review',
            arguments: {
                'x-queue-type': 'quorum',
                'x-dead-letter-exchange': 'workflow.exchange.dlx',
                'x-dead-letter-routing-key': 'workflow.job.failed',
            },
        },
    })
    async handleCodeReviewJob(
        message: WorkflowJobMessage | MessagePayload<WorkflowJobMessage>,
        amqpMsg: ConsumeMessage,
    ): Promise<void> {
        return this.handleWorkflowJob(
            'workflow-job-consumer.code_review',
            'workflow.jobs.code_review.queue',
            message,
            amqpMsg,
        );
    }

    /**
     * Implementation Check jobs
     * Delayed exchange bindings are created by RabbitMQDLQInitializer.
     */
    @RabbitSubscribe({
        exchange: 'workflow.exchange',
        routingKey: 'workflow.jobs.*.CHECK_SUGGESTION_IMPLEMENTATION',
        queue: 'workflow.jobs.check_implementation.queue',
        errorBehavior: MessageHandlerErrorBehavior.ACK,
        errorHandler: createErrorHandlerWithFallback('workflow.job.failed'),
        queueOptions: {
            channel: 'channel-check-implementation',
            arguments: {
                'x-queue-type': 'quorum',
                'x-dead-letter-exchange': 'workflow.exchange.dlx',
                'x-dead-letter-routing-key': 'workflow.job.failed',
            },
        },
    })
    async handleImplementationCheckJob(
        message: WorkflowJobMessage | MessagePayload<WorkflowJobMessage>,
        amqpMsg: ConsumeMessage,
    ): Promise<void> {
        return this.handleWorkflowJob(
            'workflow-job-consumer.check_implementation',
            'workflow.jobs.check_implementation.queue',
            message,
            amqpMsg,
        );
    }

    /**
     * AST Graph Build jobs
     * Delayed exchange bindings are created by RabbitMQDLQInitializer.
     */
    @RabbitSubscribe({
        exchange: 'workflow.exchange',
        routingKey: 'workflow.jobs.*.AST_GRAPH_BUILD',
        queue: 'workflow.jobs.ast_graph_build.queue',
        errorBehavior: MessageHandlerErrorBehavior.ACK,
        errorHandler: createErrorHandlerWithFallback('workflow.job.failed'),
        queueOptions: {
            channel: 'channel-ast-graph-build',
            arguments: {
                'x-queue-type': 'quorum',
                'x-dead-letter-exchange': 'workflow.exchange.dlx',
                'x-dead-letter-routing-key': 'workflow.job.failed',
            },
        },
    })
    async handleAstGraphBuildJob(
        message: WorkflowJobMessage | MessagePayload<WorkflowJobMessage>,
        amqpMsg: ConsumeMessage,
    ): Promise<void> {
        return this.handleWorkflowJob(
            'workflow-job-consumer.ast_graph_build',
            'workflow.jobs.ast_graph_build.queue',
            message,
            amqpMsg,
        );
    }

    /**
     * AST Graph Incremental Update jobs
     * Delayed exchange bindings are created by RabbitMQDLQInitializer.
     */
    @RabbitSubscribe({
        exchange: 'workflow.exchange',
        routingKey: 'workflow.jobs.*.AST_GRAPH_INCREMENTAL',
        queue: 'workflow.jobs.ast_graph_incremental.queue',
        errorBehavior: MessageHandlerErrorBehavior.ACK,
        errorHandler: createErrorHandlerWithFallback('workflow.job.failed'),
        queueOptions: {
            channel: 'channel-ast-graph-incremental',
            arguments: {
                'x-queue-type': 'quorum',
                'x-dead-letter-exchange': 'workflow.exchange.dlx',
                'x-dead-letter-routing-key': 'workflow.job.failed',
            },
        },
    })
    async handleAstGraphIncrementalJob(
        message: WorkflowJobMessage | MessagePayload<WorkflowJobMessage>,
        amqpMsg: ConsumeMessage,
    ): Promise<void> {
        return this.handleWorkflowJob(
            'workflow-job-consumer.ast_graph_incremental',
            'workflow.jobs.ast_graph_incremental.queue',
            message,
            amqpMsg,
        );
    }

    private async handleWorkflowJob(
        consumerId: string,
        queueName: string,
        message: WorkflowJobMessage | MessagePayload<WorkflowJobMessage>,
        amqpMsg: ConsumeMessage,
    ): Promise<void> {
        this.activeJobs++;
        try {
            await this.taskProtectionService.protectTask(
                this.JOB_PROTECTION_MINUTES,
            );
            return await this.processWorkflowJob(
                consumerId,
                queueName,
                message,
                amqpMsg,
            );
        } finally {
            await this.taskProtectionService.unprotectTask();
            this.activeJobs--;
        }
    }

    private async processWorkflowJob(
        consumerId: string,
        queueName: string,
        message: WorkflowJobMessage | MessagePayload<WorkflowJobMessage>,
        amqpMsg: ConsumeMessage,
    ): Promise<void> {
        const unwrappedMessage: WorkflowJobMessage = this.isMessagePayload(
            message,
        )
            ? message.payload
            : message;

        const messageId = amqpMsg.properties.messageId;
        const correlationId =
            (amqpMsg.properties.headers &&
                amqpMsg.properties.headers['x-correlation-id']) ||
            unwrappedMessage.correlationId ||
            amqpMsg.properties.correlationId;

        if (!messageId || !unwrappedMessage.jobId) {
            this.logger.error({
                message:
                    'Invalid workflow job message: missing messageId or jobId',
                context: WorkflowJobConsumer.name,
                metadata: {
                    message,
                    unwrappedMessage,
                    amqpMsg: {
                        messageId,
                        correlationId,
                        queueName,
                    },
                },
            });
            throw new Error('Invalid message: missing messageId or jobId');
        }

        // 1. Atomic claim in Inbox
        const claimed = await this.inboxRepository.claim(
            messageId,
            consumerId,
            this.instanceId,
            unwrappedMessage.jobId,
        );

        if (!claimed) {
            // If not claimed, it could be because it's already processed or being processed by another worker
            const existing =
                await this.inboxRepository.findByConsumerAndMessageId(
                    consumerId,
                    messageId,
                );

            if (existing?.status === InboxStatus.PROCESSED) {
                this.logger.debug({
                    message: 'Message already processed (Idempotency skip)',
                    context: WorkflowJobConsumer.name,
                    metadata: {
                        messageId,
                        jobId: unwrappedMessage.jobId,
                        queueName,
                    },
                });
                return;
            }

            // If it exists but isn't processed (and claim failed), throw error to trigger retry with backoff
            // Isso evita o hot loop de Nack(true) e respeita o delivery-limit das quorum queues
            this.logger.warn({
                message:
                    'Message already claimed by another worker, retrying with backoff',
                context: WorkflowJobConsumer.name,
                metadata: {
                    messageId,
                    jobId: unwrappedMessage.jobId,
                    queueName,
                },
            });
            throw new Error('Message already claimed but not finished');
        }

        // 2. Start observability span
        if (correlationId) {
            this.observability.setContext(correlationId);
        }

        return await this.observability.runInSpan(
            'workflow.job.consume',
            async (span) => {
                span.setAttributes({
                    'workflow.job.id': unwrappedMessage.jobId,
                    'workflow.correlation.id': correlationId,
                    'workflow.message.id': messageId,
                    'workflow.queue.name': queueName,
                });

                try {
                    await this.jobProcessor.process(unwrappedMessage.jobId);

                    await this.inboxRepository.markAsProcessed(
                        messageId,
                        consumerId,
                    );

                    span.setAttributes({
                        'workflow.job.processed': true,
                    });
                } catch (error) {
                    span.setAttributes({
                        'error': true,
                        'exception.type': error.name,
                        'exception.message': error.message,
                    });

                    this.logger.error({
                        message: 'Failed to process workflow job',
                        context: WorkflowJobConsumer.name,
                        error,
                        metadata: {
                            messageId,
                            jobId: unwrappedMessage.jobId,
                            correlationId,
                            queueName,
                        },
                    });

                    // CRITICAL: Always mark job as FAILED to prevent stuck PENDING jobs
                    try {
                        await this.jobRepository.update(
                            unwrappedMessage.jobId,
                            {
                                status: JobStatus.FAILED,
                                errorClassification:
                                    ErrorClassification.PERMANENT,
                                lastError: error.message,
                            },
                        );

                        this.logger.log({
                            message:
                                'Job marked as FAILED after processing error',
                            context: WorkflowJobConsumer.name,
                            metadata: {
                                jobId: unwrappedMessage.jobId,
                                error: error.message,
                            },
                        });
                    } catch (updateError) {
                        this.logger.error({
                            message: 'Failed to update job status to FAILED',
                            context: WorkflowJobConsumer.name,
                            error: updateError,
                            metadata: {
                                jobId: unwrappedMessage.jobId,
                                originalError: error.message,
                            },
                        });
                    }

                    // Release lock so message can be re-claimed on retry
                    // Retry scheduling is handled by RabbitMQErrorHandler (single source of truth)
                    await this.inboxRepository.releaseLock(
                        messageId,
                        consumerId,
                        error.message,
                    );

                    // Re-throw so RabbitMQErrorHandler can republish with delay
                    throw error;
                }
            },
            {
                'workflow.component': 'consumer',
                'workflow.operation': 'process_job',
            },
        );
    }

    async onApplicationShutdown(signal?: string): Promise<void> {
        this.logger.log({
            message: `Shutdown signal ${signal} received. Waiting for active jobs...`,
            context: WorkflowJobConsumer.name,
            metadata: { activeJobs: this.activeJobs },
        });

        // Wait for active jobs with a timeout to avoid hanging forever
        // ECS sends SIGKILL after stopTimeout (default 30s), so we must finish before that
        const maxWaitMs = 25000;
        const checkIntervalMs = 1000;
        const start = Date.now();

        while (this.activeJobs > 0 && Date.now() - start < maxWaitMs) {
            this.logger.log({
                message: `Waiting for ${this.activeJobs} active jobs to complete...`,
                context: WorkflowJobConsumer.name,
            });
            await new Promise((resolve) =>
                setTimeout(resolve, checkIntervalMs),
            );
        }

        // Release any remaining inbox locks held by this instance
        // This prevents "Message already claimed but not finished" errors
        // when new workers try to process the same messages after restart
        if (this.activeJobs > 0) {
            this.logger.warn({
                message: `Shutdown timeout reached with ${this.activeJobs} active jobs. Force-releasing inbox locks.`,
                context: WorkflowJobConsumer.name,
                metadata: {
                    activeJobs: this.activeJobs,
                    instanceId: this.instanceId,
                },
            });
        }

        try {
            const released = await this.inboxRepository.releaseAllByInstance(
                this.instanceId,
            );
            if (released > 0) {
                this.logger.log({
                    message: `Released ${released} inbox locks during shutdown`,
                    context: WorkflowJobConsumer.name,
                    metadata: { instanceId: this.instanceId },
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'Failed to release inbox locks during shutdown',
                context: WorkflowJobConsumer.name,
                error,
            });
        }

        this.logger.log({
            message: 'Shutdown complete. Inbox locks released.',
            context: WorkflowJobConsumer.name,
        });
    }

    private isMessagePayload(
        message: any,
    ): message is MessagePayload<WorkflowJobMessage> {
        return (
            message &&
            typeof message === 'object' &&
            'event_name' in message &&
            'payload' in message
        );
    }
}
