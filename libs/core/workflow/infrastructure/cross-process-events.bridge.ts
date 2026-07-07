import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Client } from 'pg';

import { createLogger } from '@libs/core/log/logger';

const PG_CHANNEL = 'kodus_cross_process_events';

/**
 * Events that must survive the process boundary. Everything else on the
 * EventEmitter2 bus stays process-local.
 *
 * Why this exists: several product features are wired as in-process
 * EventEmitter2 events whose emit site and consumer live in DIFFERENT
 * processes on the split topology (self-hosted default):
 *
 *   - `pull-request.closed` is emitted by the webhook PR handlers, which
 *     execute in the WORKER (the webhook queue consumer lives there),
 *     while its listeners — KodyRulesSyncListener (repo rule-file sync)
 *     and CentralizedConfigSyncListener — are registered in the API
 *     module tree. Result: PR-driven rule sync and centralized-config
 *     sync silently never ran on self-hosted.
 *   - `pr-execution.updated` is emitted by AutomationExecutionService in
 *     the review pipeline (worker) and consumed by the API's SSE endpoint
 *     (/pull-requests/executions/events). Result: the UI's live execution
 *     status only ever showed heartbeats.
 *
 * Registering the listener modules in the worker is not viable: the
 * KodyRules module graph deadlocks the worker's Nest boot (forwardRef
 * cycles), and the SSE consumer is an HTTP endpoint that must live in
 * the API regardless.
 */
const FORWARDED_EVENTS = ['pull-request.closed', 'pr-execution.updated'];

/** Marker stamped on re-emitted payloads so the forwarder never loops. */
const BRIDGED_FLAG = '__kodusBridged';

interface BridgeEnvelope {
    pid: number;
    name: string;
    payload: Record<string, unknown>;
}

/**
 * Cross-process delivery for the events in `FORWARDED_EVENTS`, over
 * Postgres LISTEN/NOTIFY on the shared main database — no new
 * infrastructure, at-most-once delivery.
 *
 * Publish half: `@OnEvent` forwarders pick the events up from the LOCAL
 * bus (emit sites stay untouched) and `pg_notify` them with this
 * process's pid. Subscribe half: a dedicated LISTEN connection re-emits
 * incoming envelopes into the LOCAL bus, skipping the process's own
 * envelopes (pid guard) so monolithic deployments don't double-deliver.
 * Re-emitted payloads carry `__kodusBridged` so the forwarder ignores
 * them and nothing ping-pongs.
 *
 * Registered in WorkflowModule's shared providers — the one module both
 * the API and the worker load.
 *
 * NOTIFY payloads are capped at 8KB by Postgres; the forwarded events
 * carry small metadata objects (org/repo/PR ids, file lists). Oversized
 * payloads are dropped with a warning rather than failing the emit site.
 */
@Injectable()
export class CrossProcessEventsBridge implements OnModuleInit, OnModuleDestroy {
    private readonly logger = createLogger(CrossProcessEventsBridge.name);
    private client: Client | null = null;
    private stopped = false;
    private reconnectDelayMs = 1_000;

    constructor(
        @InjectDataSource()
        private readonly dataSource: DataSource,
        private readonly eventEmitter: EventEmitter2,
    ) {}

    async onModuleInit(): Promise<void> {
        // Fire and forget: LISTEN connectivity must never block boot.
        void this.connect();
    }

    async onModuleDestroy(): Promise<void> {
        this.stopped = true;
        await this.client?.end().catch(() => undefined);
        this.client = null;
    }

    @OnEvent('pull-request.closed')
    async forwardPullRequestClosed(payload: unknown): Promise<void> {
        await this.forward('pull-request.closed', payload);
    }

    @OnEvent('pr-execution.updated')
    async forwardPrExecutionUpdated(payload: unknown): Promise<void> {
        await this.forward('pr-execution.updated', payload);
    }

    /**
     * Whether a local event should be forwarded to other processes.
     * Exposed for tests: re-emitted (bridged) payloads must not loop.
     */
    shouldForward(payload: unknown): payload is Record<string, unknown> {
        return Boolean(
            payload &&
            typeof payload === 'object' &&
            !(payload as Record<string, unknown>)[BRIDGED_FLAG],
        );
    }

    /**
     * Whether a received envelope should be re-emitted locally: never our
     * own (pid guard — a monolith already delivered it via the local bus).
     */
    shouldReemit(envelope: BridgeEnvelope | null | undefined): boolean {
        return Boolean(
            envelope &&
            envelope.name &&
            FORWARDED_EVENTS.includes(envelope.name) &&
            envelope.pid !== process.pid,
        );
    }

    private async forward(name: string, payload: unknown): Promise<void> {
        if (!this.shouldForward(payload)) return;

        const envelope: BridgeEnvelope = {
            pid: process.pid,
            name,
            payload,
        };
        let serialized: string;
        try {
            serialized = JSON.stringify(envelope);
        } catch {
            return; // non-serializable payload — local-only event
        }
        if (serialized.length > 7_500) {
            this.logger.warn({
                message: `Cross-process event ${name} exceeds the NOTIFY payload limit — delivered locally only`,
                context: CrossProcessEventsBridge.name,
                metadata: { name, size: serialized.length },
            });
            return;
        }

        try {
            // pg_notify via the shared TypeORM pool — the publish half
            // needs no dedicated connection.
            await this.dataSource.query('SELECT pg_notify($1, $2)', [
                PG_CHANNEL,
                serialized,
            ]);
        } catch (error) {
            this.logger.warn({
                message: `Failed to forward ${name} across processes (local delivery unaffected)`,
                context: CrossProcessEventsBridge.name,
                error,
            });
        }
    }

    private async connect(): Promise<void> {
        if (this.stopped) return;

        const options = this.dataSource.options as Record<string, any>;
        const client = new Client({
            host: options.host,
            port: options.port,
            user: options.username,
            password: options.password,
            database: options.database,
            ssl: options.ssl,
        });

        client.on('error', (error) => {
            this.logger.warn({
                message:
                    'Cross-process LISTEN connection errored — reconnecting',
                context: CrossProcessEventsBridge.name,
                error,
            });
            void this.scheduleReconnect(client);
        });

        client.on('notification', (msg) => {
            if (msg.channel !== PG_CHANNEL || !msg.payload) return;
            let envelope: BridgeEnvelope | null = null;
            try {
                envelope = JSON.parse(msg.payload) as BridgeEnvelope;
            } catch {
                return;
            }
            if (this.shouldReemit(envelope)) {
                this.eventEmitter.emit(envelope!.name, {
                    ...envelope!.payload,
                    [BRIDGED_FLAG]: true,
                });
            }
        });

        try {
            await client.connect();
            await client.query(`LISTEN ${PG_CHANNEL}`);
            this.client = client;
            this.reconnectDelayMs = 1_000;
            this.logger.log({
                message: `Listening on ${PG_CHANNEL} (cross-process event bridge: ${FORWARDED_EVENTS.join(', ')})`,
                context: CrossProcessEventsBridge.name,
            });
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not establish cross-process LISTEN connection — retrying',
                context: CrossProcessEventsBridge.name,
                error,
            });
            void this.scheduleReconnect(client);
        }
    }

    private async scheduleReconnect(oldClient: Client): Promise<void> {
        if (this.stopped) return;
        await oldClient.end().catch(() => undefined);
        if (this.client === oldClient) this.client = null;
        const delay = this.reconnectDelayMs;
        // Capped exponential backoff: transient DB restarts recover fast,
        // a down DB doesn't get hammered.
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
        setTimeout(() => void this.connect(), delay).unref?.();
    }
}
