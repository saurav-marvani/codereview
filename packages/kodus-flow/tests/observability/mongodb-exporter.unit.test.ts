/**
 * @file mongodb-exporter.unit.test.ts
 *
 * Unit tests for MongoDBExporter — focused on the BSON-safety guard:
 * callers frequently pass shapes with circular refs (Axios errors with
 * config↔request↔response, Mongoose documents, Error.cause loops). The
 * exporter must sanitize them before pushing into the buffer, otherwise
 * `insertMany` blows up with "Cannot convert circular structure to BSON"
 * and the entire batch is lost.
 */

import { describe, it, expect, vi } from 'vitest';
import { MongoDBExporter } from '../../src/observability/exporters/mongodb-exporter.js';

const buildExporter = () =>
    new MongoDBExporter({
        // High batch size so we never trigger flushLogs() during the test.
        batchSize: 999_999,
        connectionString: 'mongodb://localhost:27017/kodus-test',
        database: 'kodus-test',
    });

/**
 * Walks an object graph the way BSON serialization would, looking for
 * back-edges. Returns true if any cycle exists. Used by the in-memory
 * insertMany mock to faithfully reproduce the production failure mode
 * ("Cannot convert circular structure to BSON") without needing a real
 * MongoDB client in the test loop.
 */
function hasCircular(obj: any, seen: WeakSet<object> = new WeakSet()): boolean {
    if (obj === null || typeof obj !== 'object') return false;
    // BSON natively serializes these — don't follow their internal refs.
    if (obj instanceof Date) return false;
    if (obj instanceof RegExp) return false;
    if (seen.has(obj)) return true;
    seen.add(obj);
    if (Array.isArray(obj)) {
        for (const item of obj) {
            if (hasCircular(item, seen)) return true;
        }
        return false;
    }
    for (const key of Object.keys(obj)) {
        try {
            if (hasCircular(obj[key], seen)) return true;
        } catch {
            // Some getters throw — treat as opaque.
        }
    }
    return false;
}

/**
 * Mimics the MongoDB driver's insertMany. Fails the WHOLE batch (like real
 * BSON does) the moment any doc contains a cycle. Captures successful
 * inserts so tests can assert on what landed in the "database".
 */
function makeMockCollections() {
    const insertedBatches: any[][] = [];
    const failedBatches: any[][] = [];
    const insertMany = vi.fn(async (docs: any[]) => {
        for (const doc of docs) {
            if (hasCircular(doc)) {
                failedBatches.push(docs);
                throw new Error('Cannot convert circular structure to BSON');
            }
        }
        insertedBatches.push(docs);
        return { acknowledged: true, insertedCount: docs.length };
    });
    return {
        collections: {
            logs: { insertMany },
            telemetry: { insertMany: vi.fn() },
        },
        insertedBatches,
        failedBatches,
        insertMany,
    };
}

describe('MongoDBExporter — circular ref safety', () => {
    it('replaces circular references in metadata/attributes with [Circular] before buffering', async () => {
        const exporter = buildExporter();

        // Axios-style cycle: config ↔ request
        const config: any = { url: '/api', method: 'GET' };
        const request: any = { config };
        config.request = request;

        await exporter.exportLog('error', 'request failed', {
            component: 'axios-client',
            organizationId: 'org-1',
            payload: config, // contains the cycle
        } as any);

        const buffer = (exporter as any).logBuffer as any[];
        expect(buffer).toHaveLength(1);

        // Round-trips through JSON without throwing — no cycles remain.
        expect(() => JSON.stringify(buffer[0])).not.toThrow();

        const serialized = JSON.stringify(buffer[0]);
        expect(serialized).toContain('[Circular]');
    });

    it('drops sensitive keys via the shared deepSanitize helper (defense in depth)', async () => {
        const exporter = buildExporter();

        await exporter.exportLog('info', 'webhook received', {
            component: 'webhook',
            organizationId: 'org-1',
            apiKey: 'sk-very-secret-do-not-log',
            password: 'hunter2',
            nested: { token: 'jwt-stuff' },
        } as any);

        const buffer = (exporter as any).logBuffer as any[];
        const serialized = JSON.stringify(buffer[0]);

        // None of the secret values leak into the persisted payload.
        expect(serialized).not.toContain('sk-very-secret-do-not-log');
        expect(serialized).not.toContain('hunter2');
        expect(serialized).not.toContain('jwt-stuff');
    });

    it('preserves Date instances (BSON understands Date directly)', async () => {
        const exporter = buildExporter();
        const ts = new Date('2026-04-30T12:00:00Z');

        await exporter.exportLog('info', 'ping', {
            component: 'cron',
            occurredAt: ts,
        } as any);

        const buffer = (exporter as any).logBuffer as any[];
        // The attribute came through as a Date, not as a generic object —
        // otherwise BSON would accept it but the time-series collection
        // would no longer be able to query/sort by it.
        expect(buffer[0].attributes.occurredAt).toBeInstanceOf(Date);
        expect(buffer[0].attributes.occurredAt.getTime()).toBe(ts.getTime());
    });
});

/**
 * Fix A — sanitize the full logItem before pushing into the buffer.
 *
 * The shipped fix in 4dedc831a sanitizes metadata + attributes but leaves
 * gaps elsewhere: `error.message` (assignable to a non-string in custom
 * Error subclasses), top-level identifier fields like `executionId`,
 * `sessionId`, `correlationId`, `tenantId` (typed as string but not
 * enforced at runtime), and any future field added to the logItem shape.
 *
 * The robust answer is to sanitize the whole object once, just before it
 * lands in the buffer — so no field can carry a cycle into insertMany.
 */
describe('MongoDBExporter — full logItem sanitization (Fix A)', () => {
    it('sanitizes a cycle attached to error.message (atypical Error subclasses)', async () => {
        const exporter = buildExporter();

        const cycle: any = { a: 1 };
        cycle.self = cycle;

        const err = new Error('boom');
        // Custom Error subclasses in the wild occasionally overwrite
        // `message` with a structured payload — TypeScript doesn't enforce
        // it at runtime, and the exporter copies the field straight into
        // the logItem.
        (err as any).message = cycle;

        await exporter.exportLog('error', 'request failed', undefined, err);

        const buffer = (exporter as any).logBuffer as any[];
        expect(buffer).toHaveLength(1);
        expect(() => JSON.stringify(buffer[0])).not.toThrow();
        expect(JSON.stringify(buffer[0])).toContain('[Circular]');
    });

    it('sanitizes a cycle assigned to executionId (top-level identifier fields)', async () => {
        const exporter = buildExporter();

        const cycle: any = { foo: 1 };
        cycle.back = cycle;

        await exporter.exportLog('info', 'event', {
            component: 'service-x',
            executionId: cycle, // bypasses the per-field deepSanitize that
            // only covers metadata/attributes today.
        } as any);

        const buffer = (exporter as any).logBuffer as any[];
        expect(buffer).toHaveLength(1);
        expect(() => JSON.stringify(buffer[0])).not.toThrow();
    });

    it('sanitizes a cycle assigned to correlationId', async () => {
        const exporter = buildExporter();

        const cycle: any = { x: 1 };
        cycle.cycle = cycle;

        await exporter.exportLog('info', 'event', {
            component: 'service-x',
            correlationId: cycle,
        } as any);

        const buffer = (exporter as any).logBuffer as any[];
        expect(buffer).toHaveLength(1);
        expect(() => JSON.stringify(buffer[0])).not.toThrow();
    });

    it('produces a logItem that the mock insertMany can serialize end-to-end', async () => {
        // End-to-end: build a context that today would explode at insertMany.
        const exporter = buildExporter();
        const { collections, insertedBatches, failedBatches } =
            makeMockCollections();
        (exporter as any).collections = collections;

        const cycle: any = { hint: 'boom' };
        cycle.parent = cycle;

        await exporter.exportLog('error', 'cycle everywhere', {
            component: 'svc',
            executionId: cycle,
            correlationId: cycle,
        } as any);

        await (exporter as any).flushLogs();

        // No batch failed (the fix means insertMany only sees clean docs)
        // and exactly one batch with one doc was inserted successfully.
        expect(failedBatches).toHaveLength(0);
        expect(insertedBatches).toHaveLength(1);
        expect(insertedBatches[0]).toHaveLength(1);
    });
});

/**
 * Fix B — isolate poisoned logs from healthy ones at flush time.
 *
 * Even after Fix A, fringe non-serializable payloads (BigInt, Symbol keys,
 * getters that throw, etc.) can sneak past deepSanitize. The current catch
 * block in flushLogs() puts the failed logsToFlush back into the buffer
 * verbatim — so the same poisoned entry keeps blowing up every subsequent
 * flush and dragging the rest of the batch with it. That's the loop that
 * generated 24.7k "Failed to flush logs to MongoDB" errors in a 24h window
 * in prod. The exporter must:
 *
 *   1. Either pre-screen each log so the bad ones never reach insertMany, or
 *   2. On insertMany failure, drop the offending entries and retry the rest.
 *
 * The contract these tests enforce is the same either way: the healthy
 * majority of a batch must make it to the DB, and the poisoned entry must
 * NOT come back into the buffer on the next tick.
 */
describe('MongoDBExporter — poisoned batch isolation (Fix B)', () => {
    it('persists healthy logs even when one entry in the batch is non-serializable', async () => {
        const exporter = buildExporter();
        const { collections, insertedBatches } = makeMockCollections();
        (exporter as any).collections = collections;

        // Inject 4 healthy logs + 1 poisoned log directly into the buffer
        // (bypassing exportLog's sanitization is intentional here — we're
        // proving the flush path itself is resilient).
        const poisoned: any = { name: 'BoomError', message: 'boom' };
        poisoned.self = poisoned;

        const healthy = (id: string) => ({
            timestamp: new Date(),
            level: 'info',
            message: `msg-${id}`,
            component: 'test',
            correlationId: id,
            tenantId: 'tenant-a',
            metadata: { component: 'test', level: 'info' },
            attributes: { id },
            createdAt: new Date(),
        });

        (exporter as any).logBuffer = [
            healthy('a'),
            healthy('b'),
            { ...healthy('c'), error: poisoned }, // poisoned entry
            healthy('d'),
            healthy('e'),
        ];

        await (exporter as any).flushLogs();

        // The 4 healthy logs made it to "the DB" across one or more calls.
        const totalInserted = insertedBatches.reduce(
            (n, batch) => n + batch.length,
            0,
        );
        expect(totalInserted).toBe(4);
    });

    it('does NOT push a poisoned log back into the buffer (no infinite-loop)', async () => {
        const exporter = buildExporter();
        const { collections } = makeMockCollections();
        (exporter as any).collections = collections;

        const poisoned: any = { name: 'BoomError', message: 'boom' };
        poisoned.self = poisoned;

        const healthy = {
            timestamp: new Date(),
            level: 'info' as const,
            message: 'msg',
            component: 'test',
            correlationId: 'cid',
            tenantId: 'tenant-a',
            metadata: { component: 'test', level: 'info' },
            attributes: {},
            createdAt: new Date(),
        };

        (exporter as any).logBuffer = [
            healthy,
            { ...healthy, error: poisoned },
        ];

        await (exporter as any).flushLogs();

        const bufferAfter = (exporter as any).logBuffer as any[];
        // The poisoned entry must not survive the flush — otherwise the
        // next tick re-runs the same failure forever.
        const bufferHasPoisoned = bufferAfter.some(
            (log: any) => log.error === poisoned,
        );
        expect(bufferHasPoisoned).toBe(false);
    });
});
