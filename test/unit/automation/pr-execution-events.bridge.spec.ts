import { PrExecutionEventsBridge } from '@libs/automation/infrastructure/adapters/services/pr-execution-events.bridge';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('PrExecutionEventsBridge', () => {
    const makeBridge = (query = jest.fn().mockResolvedValue(undefined)) => {
        const eventEmitter = { emit: jest.fn() };
        const dataSource = { query, options: {} };
        const bridge = new PrExecutionEventsBridge(
            dataSource as any,
            eventEmitter as any,
        );
        return { bridge, eventEmitter, dataSource };
    };

    const event = {
        organizationId: 'org-1',
        executionUuid: 'exec-1',
        status: 'success',
        timestamp: '2026-07-07T00:00:00.000Z',
    };

    it('publishes via pg_notify with the process pid', async () => {
        const query = jest.fn().mockResolvedValue(undefined);
        const { bridge } = makeBridge(query);

        await bridge.publish(event);

        expect(query).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', [
            'pr_execution_updated',
            expect.stringContaining('"executionUuid":"exec-1"'),
        ]);
        const payload = JSON.parse(query.mock.calls[0][1][1]);
        expect(payload.pid).toBe(process.pid);
    });

    it('publish failures never throw (SSE is freshness-only)', async () => {
        const { bridge } = makeBridge(
            jest.fn().mockRejectedValue(new Error('db down')),
        );

        await expect(bridge.publish(event)).resolves.toBeUndefined();
    });

    it('re-emits payloads from OTHER processes only', () => {
        const { bridge } = makeBridge();

        // Own pid → skip (prevents duplicate SSE frames on a monolith,
        // where the local EventEmitter emit already delivered it).
        expect(
            bridge.shouldReemit({ pid: process.pid, event }),
        ).toBe(false);
        // Foreign pid (the worker) → re-emit into the API's emitter.
        expect(
            bridge.shouldReemit({ pid: process.pid + 1, event }),
        ).toBe(true);
        // Malformed payloads are dropped.
        expect(bridge.shouldReemit(null)).toBe(false);
        expect(
            bridge.shouldReemit({ pid: process.pid + 1, event: {} as any }),
        ).toBe(false);
    });
});
