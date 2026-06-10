'use strict';

/*
 * Serialize production DB migrations across replicas via a Postgres
 * session-level advisory lock.
 *
 * Why: in self-hosted, api / worker / webhooks all boot with
 * RUN_MIGRATIONS=true and otherwise run the migration steps concurrently.
 * They then race on `CREATE TYPE` and one loses with
 * `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`.
 * Under `set -e` that crashes the container -> CrashLoopBackOff churns the
 * first boot, and because the analytics-warehouse migration runs AFTER the
 * OLTP one in the same entrypoint, the warehouse is left uncreated during the
 * window -> /cockpit/validate returns 500.
 *
 * Fix: hold ONE advisory lock on the OLTP database for the whole migration
 * sequence. Concurrent replicas block on `pg_advisory_lock`, then enter and
 * find every migration already applied -> fast no-op. The lock lives on a
 * dedicated QueryRunner connection so it is held deterministically until we
 * release it.
 *
 * Fail-open: if we cannot acquire the lock (e.g. the OLTP DataSource can't be
 * loaded/connected for the lock connection) we log and still run the
 * migrations, so this is never worse than the previous un-serialized path.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// dist lives under the working directory (/usr/src/app), NOT next to this
// script in scripts/ — resolve from cwd so `require` finds the compiled
// OLTP DataSource regardless of where node is invoked from.
const OLTP_ORMCONFIG = path.resolve(
    process.cwd(),
    'dist/libs/core/infrastructure/database/typeorm/ormconfig.js',
);

// Fixed key shared by every replica. High constant chosen to avoid colliding
// with the app's runtime advisory locks (DistributedLockService hashes keys).
const LOCK_KEY = '4242042000';

// [human label, package.json script, dist guard file]. Mirrors the order the
// prod entrypoint used inline; each step is skipped if its dist artifact is
// absent (same behaviour as before).
const STEPS = [
    [
        'Running OLTP migrations (PROD)',
        'migration:run:prod',
        'dist/libs/core/infrastructure/database/typeorm/ormconfig.js',
    ],
    [
        'Ensuring analytics schema exists (PROD)',
        'analytics:ensure-schema:prod',
        'dist/scripts/analytics/ensure-schema.cli.js',
    ],
    [
        'Running analytics warehouse migrations (PROD)',
        'analytics:migration:run:prod',
        'dist/libs/ee/analytics-warehouse/infrastructure/ormconfig.js',
    ],
];

function runSteps() {
    for (const [label, script, guard] of STEPS) {
        if (!fs.existsSync(guard)) {
            console.log(`⚠️  ${label}: ${guard} not found in dist; skipping.`);
            continue;
        }
        console.log(`▶ ${label}...`);
        execFileSync('npm', ['run', script], { stdio: 'inherit' });
    }
}

async function main() {
    let dataSource;
    let queryRunner;
    let locked = false;

    try {
        ({ dataSourceInstance: dataSource } = require(OLTP_ORMCONFIG));
        if (!dataSource.isInitialized) {
            await dataSource.initialize();
        }
        queryRunner = dataSource.createQueryRunner();
        await queryRunner.connect();
        console.log(`▶ Acquiring migration advisory lock (${LOCK_KEY})...`);
        // Poll with pg_try_advisory_lock instead of a blocking
        // pg_advisory_lock: a blocked pg_advisory_lock keeps a snapshot open
        // for the whole wait, which stalls `CREATE INDEX CONCURRENTLY` in the
        // replica that IS migrating (CIC waits for all older snapshots) — a
        // logical deadlock. Polling releases the snapshot between attempts so
        // the migrating replica can finish.
        const deadlineMs = 20 * 60 * 1000; // safety cap
        const startedAt = Date.now();
        for (;;) {
            const rows = await queryRunner.query(
                'SELECT pg_try_advisory_lock($1::bigint) AS locked',
                [LOCK_KEY],
            );
            const got = rows && rows[0] && rows[0].locked;
            if (got === true || got === 't') {
                locked = true;
                console.log(
                    '  - lock acquired; this replica runs migrations, others wait.',
                );
                break;
            }
            if (Date.now() - startedAt > deadlineMs) {
                console.warn(
                    '⚠️  Timed out waiting for the migration lock; ' +
                        'proceeding WITHOUT it (fail-open).',
                );
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 3000));
        }
    } catch (err) {
        console.warn(
            `⚠️  Migration advisory lock unavailable (${err && err.message}); ` +
                'running migrations WITHOUT serialization (fail-open).',
        );
    }

    try {
        runSteps();
    } finally {
        if (locked) {
            try {
                await queryRunner.query(
                    'SELECT pg_advisory_unlock($1::bigint)',
                    [LOCK_KEY],
                );
            } catch (_) {
                /* lock auto-releases when the connection closes below */
            }
        }
        try {
            if (queryRunner) await queryRunner.release();
        } catch (_) {
            /* ignore */
        }
        try {
            if (dataSource && dataSource.isInitialized) {
                await dataSource.destroy();
            }
        } catch (_) {
            /* ignore */
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('Migration runner failed:', err);
        process.exit(1);
    });
