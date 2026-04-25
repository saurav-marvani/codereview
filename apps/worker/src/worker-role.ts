/**
 * The `apps/worker` image runs in exactly one of two modes, chosen via
 * `WORKER_ROLE`:
 *
 *   code-review  → RabbitMQ consumers, code review pipeline, outbox
 *                  relay, monitors. Does not touch the analytics
 *                  warehouse.
 *   analytics    → Analytics ingestion cron + warehouse connection
 *                  only. No RabbitMQ consumers, no LLM module, no main
 *                  OLTP Postgres pool.
 *
 * Both cloud and self-hosted deploy both replicas. Keeping the topology
 * identical across environments is a non-negotiable property of this
 * migration (see issue #951): one pipeline, same bugs, same fixes.
 */
export type WorkerRole = 'code-review' | 'analytics';

export function resolveWorkerRole(): WorkerRole {
    const raw = process.env.WORKER_ROLE?.toLowerCase();
    if (raw === 'code-review' || raw === 'analytics') {
        return raw;
    }
    throw new Error(
        `WORKER_ROLE must be set to "code-review" or "analytics". Got ${
            raw ? `"${raw}"` : 'undefined'
        }.`,
    );
}
