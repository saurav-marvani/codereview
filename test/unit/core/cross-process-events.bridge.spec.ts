import { CrossProcessEventsBridge } from '@libs/core/workflow/infrastructure/cross-process-events.bridge';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

describe('CrossProcessEventsBridge', () => {
    beforeEach(() => {
        CrossProcessEventsBridge.resetPrimaryForTests();
    });

    const makeBridge = (query = jest.fn().mockResolvedValue(undefined)) => {
        const eventEmitter = { emit: jest.fn() };
        const dataSource = { query, options: {} };
        const bridge = new CrossProcessEventsBridge(
            dataSource as any,
            eventEmitter as any,
        );
        return { bridge, eventEmitter, query };
    };

    const payload = {
        organizationAndTeamData: { organizationId: 'org-1' },
        pullRequestNumber: 42,
    };

    it('stores the envelope in a row and notifies only its id', async () => {
        const query = jest
            .fn()
            .mockResolvedValueOnce([{ id: 77 }]) // INSERT ... RETURNING id
            .mockResolvedValueOnce(undefined); // pg_notify
        const { bridge } = makeBridge(query);

        await bridge.forwardPullRequestClosed(payload);

        const [insertSql, insertArgs] = query.mock.calls[0];
        expect(insertSql).toContain('INSERT INTO kodus_cross_process_events');
        const envelope = JSON.parse(insertArgs[0]);
        expect(envelope.instanceId).toBe(bridge.instanceId);
        expect(envelope.name).toBe('pull-request.closed');
        expect(envelope.payload.pullRequestNumber).toBe(42);

        expect(query).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', [
            'kodus_cross_process_events',
            '77',
        ]);
    });

    it('large payloads are not dropped (row transport has no NOTIFY cap)', async () => {
        const query = jest
            .fn()
            .mockResolvedValueOnce([{ id: 78 }])
            .mockResolvedValueOnce(undefined);
        const { bridge } = makeBridge(query);

        await bridge.forwardPullRequestClosed({
            files: Array.from({ length: 500 }, (_, i) => ({
                filename: `src/file-${i}.ts`,
                status: 'modified',
            })),
        });

        expect(query).toHaveBeenCalledTimes(2);
    });

    it('does NOT re-forward bridged payloads (no ping-pong)', async () => {
        const { bridge, query } = makeBridge();

        await bridge.forwardPullRequestClosed({
            ...payload,
            __kodusBridged: true,
        });

        expect(query).not.toHaveBeenCalled();
    });

    it('publish failures never throw (emit site unaffected)', async () => {
        const { bridge } = makeBridge(
            jest.fn().mockRejectedValue(new Error('db down')),
        );

        await expect(
            bridge.forwardPrExecutionUpdated(payload),
        ).resolves.toBeUndefined();
    });

    it('re-emits only foreign, known events', () => {
        const { bridge } = makeBridge();

        const envelope = (over: Partial<any>) => ({
            // Containerized apps are all PID 1, so the guard is a random
            // per-process instance id — never process.pid.
            instanceId: 'another-instance',
            name: 'pull-request.closed',
            payload,
            ...over,
        });

        expect(bridge.shouldReemit(envelope({}))).toBe(true);
        // Own instance → the local bus already delivered it.
        expect(
            bridge.shouldReemit(envelope({ instanceId: bridge.instanceId })),
        ).toBe(false);
        // Unknown event names are ignored.
        expect(bridge.shouldReemit(envelope({ name: 'something-else' }))).toBe(
            false,
        );
        expect(bridge.shouldReemit(null)).toBe(false);
    });
});
