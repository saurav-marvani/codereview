import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConsumeMessage } from 'amqplib';
import { createLogger } from '@kodus/flow';
import { ConfigService } from '@nestjs/config';
import {
    BackoffOptions,
    calculateBackoffInterval,
} from '@libs/common/utils/polling';

/**
 * Backoff configuration for consumer retries.
 * Uses workflow queue config for base interval and max retries.
 */
const DEFAULT_MAX_RETRIES_CONSUMER = 5;
const DEFAULT_RETRY_DELAY_MS = 1000;

/**
 * Handles RabbitMQ consumer errors with retry logic and DLQ support.
 *
 * IMPORTANT: Requires the following RabbitMQ topology:
 * - For any `<base>` exchange in use:
 *   - `<base>.delayed` (type: x-delayed-message, x-delayed-type: topic)
 *   - `<base>.dlx` (type: topic)
 * - The delayed exchange plugin must be installed: rabbitmq_delayed_message_exchange
 */
@Injectable()
export class RabbitMQErrorHandler implements OnModuleInit {
    private static _instance: RabbitMQErrorHandler;
    private readonly logger = createLogger(RabbitMQErrorHandler.name);
    private readonly RETRY_COUNT_HEADER = 'x-retry-count';
    private readonly maxRetriesConsumer: number;
    private readonly retryDelayMs: number;

    constructor(
        private readonly amqpConnection: AmqpConnection,
        private readonly configService: ConfigService,
    ) {
        const maxRetries = this.configService.get<number>(
            'workflowQueue.WORKFLOW_QUEUE_WORKER_MAX_RETRIES',
        );
        const retryDelayMs = this.configService.get<number>(
            'workflowQueue.WORKFLOW_QUEUE_WORKER_RETRY_DELAY_MS',
        );

        this.maxRetriesConsumer = Number.isFinite(maxRetries)
            ? maxRetries
            : DEFAULT_MAX_RETRIES_CONSUMER;
        this.retryDelayMs = Number.isFinite(retryDelayMs)
            ? retryDelayMs
            : DEFAULT_RETRY_DELAY_MS;
    }

    onModuleInit() {
        // Set instance for static access (required by @RabbitSubscribe errorHandler)
        // This is a workaround for the golevelup library limitation
        RabbitMQErrorHandler._instance = this;
    }

    static get instance(): RabbitMQErrorHandler | undefined {
        return RabbitMQErrorHandler._instance;
    }

    async handle(
        channel: any,
        msg: ConsumeMessage,
        error: any,
        options?: { dlqRoutingKey?: string },
    ): Promise<void> {
        const headers = { ...msg.properties.headers };
        const retryCount = (headers[this.RETRY_COUNT_HEADER] || 0) as number;
        const messageId = msg.properties.messageId;
        const baseExchange = this.getBaseExchange(msg.fields.exchange);
        const delayedExchange = `${baseExchange}.delayed`;
        const dlxExchange = `${baseExchange}.dlx`;

        try {
            if (retryCount < this.maxRetriesConsumer) {
                await this.retryWithDelay(
                    msg,
                    headers,
                    retryCount,
                    error,
                    delayedExchange,
                );
            } else {
                await this.sendToDLQ(
                    msg,
                    headers,
                    error,
                    dlxExchange,
                    options?.dlqRoutingKey,
                );
            }

            channel.ack(msg);
        } catch (publishError) {
            // CRITICAL: If we can't republish or ACK, leave the original
            // delivery unacked so RabbitMQ can redeliver it when the channel
            // closes instead of losing the message.
            // Log as FATAL and throw to make this visible in monitoring
            this.logger.error({
                message:
                    'CRITICAL: Failed to republish or acknowledge message after error',
                context: RabbitMQErrorHandler.name,
                error: publishError,
                metadata: {
                    messageId,
                    routingKey: msg.fields.routingKey,
                    originalError: error?.message,
                    retryCount,
                    dlqRoutingKey: options?.dlqRoutingKey,
                },
            });

            // Throw to ensure this is visible and potentially crash the process
            // In production, you may want to implement a fallback (e.g., write to disk/DB)
            throw new Error(
                `CRITICAL: Message ${messageId} may be lost - republish failed: ${publishError.message}`,
                { cause: publishError },
            );
        }
    }

    private async retryWithDelay(
        msg: ConsumeMessage,
        headers: Record<string, any>,
        retryCount: number,
        error: any,
        delayedExchange: string,
    ): Promise<void> {
        const nextRetryCount = retryCount + 1;
        headers[this.RETRY_COUNT_HEADER] = nextRetryCount;

        // Use centralized backoff calculation
        const backoffOptions: BackoffOptions = {
            baseInterval: this.retryDelayMs,
            maxInterval: Math.max(this.retryDelayMs, 30000),
            jitterFactor: 0.1,
            multiplier: 2,
        };
        const delayMs = calculateBackoffInterval(
            nextRetryCount,
            backoffOptions,
        );
        headers['x-delay'] = delayMs;

        this.logger.warn({
            message: `Message processing failed, retrying (${nextRetryCount}/${this.maxRetriesConsumer})`,
            context: RabbitMQErrorHandler.name,
            metadata: {
                messageId: msg.properties.messageId,
                routingKey: msg.fields.routingKey,
                retryCount: nextRetryCount,
                delayMs,
                error: error?.message,
            },
        });

        await this.amqpConnection.publish(
            delayedExchange,
            msg.fields.routingKey,
            msg.content,
            {
                messageId: msg.properties.messageId,
                correlationId: msg.properties.correlationId,
                contentType: msg.properties.contentType,
                contentEncoding: msg.properties.contentEncoding,
                persistent: true,
                headers: headers,
            },
        );
    }

    private async sendToDLQ(
        msg: ConsumeMessage,
        headers: Record<string, any>,
        error: any,
        dlxExchange: string,
        dlqRoutingKey?: string,
    ): Promise<void> {
        const routingKeyForDlq = dlqRoutingKey || msg.fields.routingKey;

        this.logger.error({
            message: 'Max retries exceeded, sending to DLQ',
            context: RabbitMQErrorHandler.name,
            metadata: {
                messageId: msg.properties.messageId,
                routingKey: msg.fields.routingKey,
                dlqRoutingKey: routingKeyForDlq,
                error: error?.message,
                exchange: msg.fields.exchange,
                dlxExchange,
            },
        });

        headers['x-original-routing-key'] = msg.fields.routingKey;
        headers['x-original-exchange'] = msg.fields.exchange;
        headers['x-death-reason'] = 'max-retries-exceeded';
        headers['x-last-error'] = error?.message?.substring(0, 500);

        await this.amqpConnection.publish(
            dlxExchange,
            routingKeyForDlq,
            msg.content,
            {
                messageId: msg.properties.messageId,
                correlationId: msg.properties.correlationId,
                contentType: msg.properties.contentType,
                contentEncoding: msg.properties.contentEncoding,
                persistent: true,
                headers: headers,
            },
        );
    }

    private getBaseExchange(exchange: string): string {
        if (exchange.endsWith('.delayed')) {
            return exchange.slice(0, -'.delayed'.length);
        }
        if (exchange.endsWith('.dlx')) {
            return exchange.slice(0, -'.dlx'.length);
        }
        return exchange;
    }
}

export const createRabbitMQErrorHandlerWithFallback = (
    dlqRoutingKey: string,
) => {
    return (channel: any, msg: ConsumeMessage, err: any) => {
        if (RabbitMQErrorHandler.instance) {
            return RabbitMQErrorHandler.instance.handle(channel, msg, err, {
                dlqRoutingKey,
            });
        }

        if (msg) {
            channel.nack(msg, false, false);
        }
    };
};
