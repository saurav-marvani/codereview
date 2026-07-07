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

    it('forwards a local pull-request.closed via pg_notify with pid', async () => {
        const { bridge, query } = makeBridge();

        await bridge.forwardPullRequestClosed(payload);

        expect(query).toHaveBeenCalledWith('SELECT pg_notify($1, $2)', [
            'kodus_cross_process_events',
            expect.stringContaining('"pullRequestNumber":42'),
        ]);
        const envelope = JSON.parse(query.mock.calls[0][1][1]);
        expect(envelope.pid).toBe(process.pid);
        expect(envelope.name).toBe('pull-request.closed');
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

    it('drops oversized payloads instead of failing', async () => {
        const { bridge, query } = makeBridge();

        await bridge.forwardPullRequestClosed({
            files: 'x'.repeat(10_000),
        });

        expect(query).not.toHaveBeenCalled();
    });

    it('re-emits only foreign, known events', () => {
        const { bridge } = makeBridge();

        const envelope = (over: Partial<any>) => ({
            pid: process.pid + 1,
            name: 'pull-request.closed',
            payload,
            ...over,
        });

        expect(bridge.shouldReemit(envelope({}))).toBe(true);
        // Own pid → the local bus already delivered it.
        expect(bridge.shouldReemit(envelope({ pid: process.pid }))).toBe(false);
        // Unknown event names are ignored.
        expect(bridge.shouldReemit(envelope({ name: 'something-else' }))).toBe(
            false,
        );
        expect(bridge.shouldReemit(null)).toBe(false);
    });
});
