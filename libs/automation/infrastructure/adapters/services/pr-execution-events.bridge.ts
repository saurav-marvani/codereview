import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Client } from 'pg';

import { createLogger } from '@libs/core/log/logger';

export const PR_EXECUTION_UPDATED_EVENT = 'pr-execution.updated';
const PG_CHANNEL = 'pr_execution_updated';

export interface PrExecutionUpdatedEvent {
    organizationId: string;
    executionUuid: string;
    status: unknown;
    timestamp: string;
}

interface BridgePayload {
    pid: number;
    event: PrExecutionUpdatedEvent;
}

/**
 * Cross-process bridge for `pr-execution.updated`.
 *
 * The event is produced by the review pipeline (worker process) but its
 * only consumer is the API's SSE endpoint (`/pull-requests/executions/
 * events`, built on `fromEvent(eventEmitter, ...)`). EventEmitter2 is
 * per-process, so on the split topology (self-hosted default) the API
 * never saw the worker's updates and the UI's live execution status
 * stayed frozen on heartbeats.
 *
 * Transport: Postgres LISTEN/NOTIFY on the shared main database — no new
 * infrastructure, at-most-once (fine: the SSE stream is a UI freshness
 * hint, the execution list endpoint remains the source of truth).
 *
 * Publish half: `publish()` is called by AutomationExecutionService
 * alongside its local emit. Subscribe half: every process LISTENs and
 * re-emits into its LOCAL EventEmitter2 — skipping payloads published by
 * itself (pid check) so a monolithic deployment doesn't deliver duplicate
 * frames to SSE clients.
 */
@Injectable()
export class PrExecutionEventsBridge implements OnModuleInit, OnModuleDestroy {
    private readonly logger = createLogger(PrExecutionEventsBridge.name);
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

    async publish(event: PrExecutionUpdatedEvent): Promise<void> {
        const payload: BridgePayload = { pid: process.pid, event };
        try {
            // pg_notify via the shared TypeORM pool — no dedicated
            // connection needed for the publish half.
            await this.dataSource.query('SELECT pg_notify($1, $2)', [
                PG_CHANNEL,
                JSON.stringify(payload),
            ]);
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to publish pr-execution.updated notification (SSE freshness only, execution state is unaffected)',
                context: PrExecutionEventsBridge.name,
                error,
                metadata: { executionUuid: event.executionUuid },
            });
        }
    }

    /**
     * Whether a received payload should be re-emitted locally. Exposed for
     * tests; the pid guard is what prevents duplicate SSE frames when the
     * emitter and the SSE endpoint live in the SAME process.
     */
    shouldReemit(payload: BridgePayload | null | undefined): boolean {
        return Boolean(
            payload &&
            payload.event?.organizationId &&
            payload.pid !== process.pid,
        );
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
                    'pr-execution LISTEN connection errored — reconnecting',
                context: PrExecutionEventsBridge.name,
                error,
            });
            void this.scheduleReconnect(client);
        });

        client.on('notification', (msg) => {
            if (msg.channel !== PG_CHANNEL || !msg.payload) return;
            let payload: BridgePayload | null = null;
            try {
                payload = JSON.parse(msg.payload) as BridgePayload;
            } catch {
                return;
            }
            if (this.shouldReemit(payload)) {
                this.eventEmitter.emit(
                    PR_EXECUTION_UPDATED_EVENT,
                    payload!.event,
                );
            }
        });

        try {
            await client.connect();
            await client.query(`LISTEN ${PG_CHANNEL}`);
            this.client = client;
            this.reconnectDelayMs = 1_000;
            this.logger.log({
                message: `Listening for ${PG_CHANNEL} notifications (cross-process SSE bridge)`,
                context: PrExecutionEventsBridge.name,
            });
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not establish pr-execution LISTEN connection — retrying',
                context: PrExecutionEventsBridge.name,
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
        // Exponential backoff capped at 30s: transient DB restarts recover
        // fast, a down DB doesn't get hammered.
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
        setTimeout(() => void this.connect(), delay).unref?.();
    }
}
