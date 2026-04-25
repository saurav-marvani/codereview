import {
    createRabbitMQErrorHandlerWithFallback,
    RabbitMQErrorHandler,
} from './rabbitmq-error.handler';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        warn: jest.fn(),
        error: jest.fn(),
        log: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('RabbitMQErrorHandler', () => {
    const makeHandler = (overrides?: {
        maxRetries?: number;
        retryDelayMs?: number;
        publish?: jest.Mock;
    }) => {
        const amqpConnection = {
            publish:
                overrides?.publish ?? jest.fn().mockResolvedValue(undefined),
        };
        const configService = {
            get: jest.fn((key: string) => {
                if (key === 'workflowQueue.WORKFLOW_QUEUE_WORKER_MAX_RETRIES') {
                    return overrides?.maxRetries ?? 5;
                }
                if (
                    key === 'workflowQueue.WORKFLOW_QUEUE_WORKER_RETRY_DELAY_MS'
                ) {
                    return overrides?.retryDelayMs ?? 1000;
                }
                return undefined;
            }),
        };

        return {
            handler: new RabbitMQErrorHandler(
                amqpConnection as any,
                configService as any,
            ),
            amqpConnection,
        };
    };

    const makeMessage = (headers: Record<string, unknown> = {}) =>
        ({
            properties: {
                messageId: 'message-1',
                correlationId: 'correlation-1',
                contentType: 'application/json',
                contentEncoding: 'utf8',
                headers,
            },
            fields: {
                exchange: 'workflow.exchange',
                routingKey: 'workflow.jobs.created.CODE_REVIEW',
            },
            content: Buffer.from('{"jobId":"job-1"}'),
        }) as any;

    it('acks the original message after publishing a delayed retry', async () => {
        const { handler, amqpConnection } = makeHandler();
        const channel = { ack: jest.fn() };
        const msg = makeMessage();

        await handler.handle(channel, msg, new Error('processor failed'), {
            dlqRoutingKey: 'workflow.job.failed',
        });

        expect(amqpConnection.publish).toHaveBeenCalledWith(
            'workflow.exchange.delayed',
            'workflow.jobs.created.CODE_REVIEW',
            msg.content,
            expect.objectContaining({
                messageId: 'message-1',
                correlationId: 'correlation-1',
                persistent: true,
                headers: expect.objectContaining({
                    'x-retry-count': 1,
                    'x-delay': expect.any(Number),
                }),
            }),
        );
        expect(channel.ack).toHaveBeenCalledWith(msg);
        expect(amqpConnection.publish.mock.invocationCallOrder[0]).toBeLessThan(
            channel.ack.mock.invocationCallOrder[0],
        );
    });

    it('acks the original message after publishing to DLQ', async () => {
        const { handler, amqpConnection } = makeHandler({ maxRetries: 5 });
        const channel = { ack: jest.fn() };
        const msg = makeMessage({ 'x-retry-count': 5 });

        await handler.handle(channel, msg, new Error('processor failed'), {
            dlqRoutingKey: 'workflow.job.failed',
        });

        expect(amqpConnection.publish).toHaveBeenCalledWith(
            'workflow.exchange.dlx',
            'workflow.job.failed',
            msg.content,
            expect.objectContaining({
                messageId: 'message-1',
                persistent: true,
                headers: expect.objectContaining({
                    'x-retry-count': 5,
                    'x-original-routing-key':
                        'workflow.jobs.created.CODE_REVIEW',
                    'x-original-exchange': 'workflow.exchange',
                    'x-death-reason': 'max-retries-exceeded',
                    'x-last-error': 'processor failed',
                }),
            }),
        );
        expect(channel.ack).toHaveBeenCalledWith(msg);
    });

    it('does not ack the original message when retry publish fails', async () => {
        const publishError = new Error('broker unavailable');
        const { handler } = makeHandler({
            publish: jest.fn().mockRejectedValue(publishError),
        });
        const channel = { ack: jest.fn() };
        const msg = makeMessage();

        await expect(
            handler.handle(channel, msg, new Error('processor failed'), {
                dlqRoutingKey: 'workflow.job.failed',
            }),
        ).rejects.toThrow('may be lost');

        expect(channel.ack).not.toHaveBeenCalled();
    });

    it('nacks without requeue when the singleton handler is unavailable', () => {
        const fallback = createRabbitMQErrorHandlerWithFallback(
            'workflow.job.failed',
        );
        const channel = { nack: jest.fn() };
        const msg = makeMessage();

        fallback(channel, msg, new Error('processor failed'));

        expect(channel.nack).toHaveBeenCalledWith(msg, false, false);
    });
});
