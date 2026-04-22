import * as http from 'http';
import { INestApplicationContext } from '@nestjs/common';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';

export interface HealthProbeOptions {
    port: number;
    appContext: INestApplicationContext;
    requireAmqp: boolean;
    /**
     * Channels that must have at least one registered consumer for the
     * worker to be considered healthy. An empty list disables this check
     * (useful for dev or components that don't subscribe to anything).
     *
     * Default matches the worker's @RabbitSubscribe channels in
     * workflow-job-consumer.service.ts. If a channel here is missing from
     * managedChannels — or has zero consumers after the startup grace
     * period — the probe returns 503 and ECS recycles the task.
     */
    requiredChannels?: string[];
    /**
     * How long after boot to suppress the consumer-presence check. Nest
     * bootstrap + @RabbitSubscribe registration takes a few seconds; we
     * don't want to flap unhealthy during that window.
     */
    startupGraceMs?: number;
}

const DEFAULT_WORKER_CHANNELS = [
    'channel-webhook',
    'channel-code-review',
    'channel-check-implementation',
    'channel-feedback',
    'channel-ast-graph-build',
    'channel-ast-graph-incremental',
];

interface HealthStatus {
    ok: boolean;
    status: string;
    details?: Record<string, unknown>;
}

/**
 * Minimal HTTP server for ECS container health checks.
 *
 * Three failure modes that matter, in order of detection difficulty:
 *
 *   1. Connection dead: amqp.managedConnection.isConnected() === false.
 *      Easy to catch — the library knows.
 *
 *   2. Connection alive, but a channel we depend on has zero consumers.
 *      This is the "zombie" pattern we traced in prod: lib reconnected
 *      after a channel close but the @RabbitSubscribe consumer didn't
 *      re-register. Connection looks fine; messages pile up. Catching
 *      this requires inspecting managedChannels[name]._consumers, which
 *      is internal state of ChannelWrapper but stable enough across
 *      recent versions to rely on.
 *
 *   3. Connection alive, consumers registered, but the worker is wedged
 *      (event loop pinned, all jobs stuck). That's out of scope for
 *      this probe — would need a liveness signal from the handler
 *      itself (e.g. "last ack timestamp > N ago"). Tracked separately.
 *
 * Failing this probe causes ECS to mark the task unhealthy and start a
 * new one, which is the right call for cases 1 and 2: both are
 * unrecoverable without reconnecting at the AMQP library level.
 */
export function startHealthProbe(opts: HealthProbeOptions): http.Server {
    const {
        port,
        appContext,
        requireAmqp,
        requiredChannels = DEFAULT_WORKER_CHANNELS,
        startupGraceMs = 60_000,
    } = opts;
    const bootTs = Date.now();

    const evaluate = (): HealthStatus => {
        if (!requireAmqp) {
            return { ok: true, status: 'ok_no_amqp' };
        }

        let amqp: AmqpConnection | undefined;
        try {
            amqp = appContext.get(AmqpConnection, { strict: false });
        } catch {
            amqp = undefined;
        }

        if (!amqp) {
            return { ok: false, status: 'amqp_not_resolved' };
        }

        const connected = amqp.managedConnection?.isConnected?.() === true;
        if (!connected) {
            return { ok: false, status: 'amqp_disconnected' };
        }

        // Still inside startup grace — a worker just-booted won't have
        // finished registering consumers yet. Treat as healthy to avoid
        // an ECS flap loop during rolling deploys.
        if (Date.now() - bootTs < startupGraceMs) {
            return {
                ok: true,
                status: 'ok_starting',
                details: {
                    msSinceBoot: Date.now() - bootTs,
                    startupGraceMs,
                },
            };
        }

        if (requiredChannels.length === 0) {
            return { ok: true, status: 'ok' };
        }

        const managedChannels = (amqp as any).managedChannels ?? {};
        const missing: string[] = [];
        const noConsumer: string[] = [];
        for (const name of requiredChannels) {
            const cw = managedChannels[name];
            if (!cw) {
                missing.push(name);
                continue;
            }
            // `_consumers` is internal to ChannelWrapper but is the
            // single source of truth for "what did basic.consume register
            // on this channel". A zombie channel has this empty.
            const consumerCount = Array.isArray((cw as any)._consumers)
                ? (cw as any)._consumers.length
                : 0;
            if (consumerCount === 0) {
                noConsumer.push(name);
            }
        }

        if (missing.length > 0 || noConsumer.length > 0) {
            return {
                ok: false,
                status: 'consumer_missing',
                details: { missing, noConsumer },
            };
        }

        return { ok: true, status: 'ok' };
    };

    const server = http.createServer((req, res) => {
        if (!req.url?.startsWith('/health')) {
            res.writeHead(404);
            res.end();
            return;
        }

        let result: HealthStatus;
        try {
            result = evaluate();
        } catch (err) {
            result = {
                ok: false,
                status: 'error',
                details: {
                    error: err instanceof Error ? err.message : String(err),
                },
            };
        }

        res.writeHead(result.ok ? 200 : 503, {
            'content-type': 'application/json',
        });
        res.end(
            JSON.stringify({
                status: result.status,
                ts: new Date().toISOString(),
                ...(result.details ?? {}),
            }),
        );
    });

    server.listen(port, '0.0.0.0', () => {
        // eslint-disable-next-line no-console
        console.log(
            `[Worker] Health probe listening on :${port}/health (checking ${requiredChannels.length} channels)`,
        );
    });

    return server;
}
