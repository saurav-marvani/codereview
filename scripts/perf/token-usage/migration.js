/**
 * Token Usage perf — migration: backfill `attributes.tu` + covering indexes.
 *
 * Mirrors the token dotted-keys into an indexable `attributes.tu` sub-doc so the
 * screen's aggregation is index-covered (docsExamined=0). NO cron / time-series
 * / new collection — it only adapts the existing `observability_telemetry`.
 *
 * ⚠️ PROD SCALE: this collection is ~130GB. Read the safety notes below.
 *
 *   USAGE (run phases SEPARATELY in prod, off-peak):
 *     PHASE=backfill mongosh "<uri>" scripts/perf/token-usage/migration.js
 *     PHASE=index    mongosh "<uri>" scripts/perf/token-usage/migration.js
 *   (PHASE=all runs both; default is 'backfill' to avoid a surprise index build.)
 *
 * SAFETY / PERFORMANCE (why it's written this way):
 *  - Iterates by `_id` (the clustered index) with a resumable cursor, NOT by the
 *    dotted-key token filter. That filter uses $getField (unindexable) → a
 *    find() on it is a COLLSCAN that re-scans a growing prefix each batch (~O(n²)
 *    on 130GB). The _id sweep is a single linear index scan; the token/pending
 *    predicate is applied inside updateMany so only real token docs are written.
 *  - Idempotent: updateMany filters `attributes.tu:{$exists:false}` → re-running
 *    (or resuming after a crash) skips already-done docs. Safe to Ctrl-C.
 *  - Throttled: sleeps `SLEEP_MS` between batches to leave replication/WT-cache
 *    headroom. Small batches keep each oplog write bounded.
 *  - Resumable: prints the last processed `_id`. Set RESUME_FROM to continue.
 *  - The write path (token-usage-tu.ts) already stamps `tu` on NEW docs, so this
 *    only has to cover HISTORY. If your screen bounds the min date, set SINCE to
 *    skip writing (and, cheaply, skip scanning is not possible — but writing is
 *    the expensive part). Leaving SINCE null covers every window the screen can
 *    query (required for correct numbers on old date ranges).
 *  - Disk: `attributes.tu` grows every token doc (~150B) and EACH covering index
 *    is large (it stores the summed fields). Budget headroom before running.
 *  - Indexes are built ONE at a time. On MongoDB 4.2+ builds are hybrid (the
 *    `background` flag is a no-op); expect a long build + high I/O on 130GB —
 *    run PHASE=index during a low-traffic window and watch replication lag.
 */

const env = (k, d) =>
    (typeof process !== 'undefined' && process.env && process.env[k]) || d;
const DB = env('MIG_DB', 'kodus_db');
const PHASE = env('PHASE', 'backfill');
const BATCH = parseInt(env('BATCH', '3000'), 10); // small → bounded oplog + lock time
const SLEEP_MS = parseInt(env('SLEEP_MS', '150'), 10); // replication/cache headroom
const SINCE = env('SINCE', '') ? new Date(env('SINCE', '')) : null; // only STAMP docs at/after this ts
const RESUME_FROM = null; // set to an ObjectId('...') printed by a previous run
const LOG_EVERY = BATCH * 20;

const db2 = db.getSiblingDB(DB);
const c = db2.observability_telemetry;
const gf = (f) => ({ $getField: { field: f, input: '$attributes' } });
const modelE = {
    $arrayElemAt: [
        { $split: [{ $ifNull: [gf('gen_ai.response.model'), ''] }, ':'] },
        -1,
    ],
};

// Kept in sync with SYSTEM_RUN_NAMES in libs/core/log/token-usage-tu.ts.
const SYSTEM_RUN_NAMES = [
    'selectReviewMode',
    'validateImplementedSuggestions',
    'generateCodeSuggestions',
    'analyzeASTWithAI',
];

// Only stamp docs that (a) have token usage, (b) don't already have `tu`, and
// (c) fall in the SINCE window. Applied INSIDE updateMany so the _id sweep does
// the iterating and this only decides what gets written.
const stampPredicate = () => {
    const p = {
        'attributes.tu': { $exists: false },
        $expr: { $gt: [{ $ifNull: [gf('gen_ai.usage.total_tokens'), 0] }, 0] },
    };
    if (SINCE) p.timestamp = { $gte: SINCE };
    return p;
};

const setTu = {
    $set: {
        'attributes.tu': {
            isByok: { $eq: [gf('type'), 'byok'] }, // view byok=true
            sys: { $in: [gf('gen_ai.run.name'), SYSTEM_RUN_NAMES] }, // byok=false excludes these
            model: modelE,
            tier: {
                $cond: [
                    {
                        $and: [
                            { $regexMatch: { input: modelE, regex: 'gemini' } },
                            { $gt: [{ $ifNull: [gf('gen_ai.usage.input_tokens'), 0] }, 200000] },
                        ],
                    },
                    'gt',
                    'le',
                ],
            },
            input: { $ifNull: [gf('gen_ai.usage.input_tokens'), 0] },
            output: { $ifNull: [gf('gen_ai.usage.output_tokens'), 0] },
            total: { $ifNull: [gf('gen_ai.usage.total_tokens'), 0] },
            reasoning: { $ifNull: [gf('gen_ai.usage.reasoning_tokens'), 0] },
            cacheRead: { $ifNull: [gf('gen_ai.usage.cache_read_input_tokens'), 0] },
            cacheWrite: { $ifNull: [gf('gen_ai.usage.cache_creation_input_tokens'), 0] },
        },
    },
};

function backfill() {
    print(`[backfill] DB=${DB} BATCH=${BATCH} SLEEP=${SLEEP_MS}ms SINCE=${SINCE || 'none'}`);
    let lastId = RESUME_FROM;
    let scanned = 0;
    let stamped = 0;
    const t0 = Date.now();
    while (true) {
        const q = lastId ? { _id: { $gt: lastId } } : {};
        // Covered _id-index scan — cheap, linear, resumable.
        const ids = c
            .find(q, { _id: 1 })
            .sort({ _id: 1 })
            .limit(BATCH)
            .toArray()
            .map((d) => d._id);
        if (ids.length === 0) break;
        lastId = ids[ids.length - 1];
        scanned += ids.length;

        const r = c.updateMany(
            { _id: { $in: ids }, ...stampPredicate() },
            [setTu],
        );
        stamped += r.modifiedCount;

        if (scanned % LOG_EVERY === 0) {
            const rate = Math.round(scanned / ((Date.now() - t0) / 1000));
            print(`  scanned=${scanned} stamped=${stamped} ~${rate}/s lastId=${lastId}`);
        }
        if (SLEEP_MS > 0) sleep(SLEEP_MS);
    }
    print(`[backfill] DONE scanned=${scanned} stamped=${stamped} in ${Math.round((Date.now() - t0) / 1000)}s`);
    print(`[backfill] (to resume a partial run, set RESUME_FROM=${lastId})`);
}

function createIndexes() {
    const sums = {
        'attributes.tu.input': 1,
        'attributes.tu.output': 1,
        'attributes.tu.total': 1,
        'attributes.tu.reasoning': 1,
        'attributes.tu.cacheRead': 1,
        'attributes.tu.cacheWrite': 1,
    };
    // Two covering indexes — one per view flag (isByok vs sys). Each lets the
    // planner bound its flag and keep the scan index-only (PROJECTION_COVERED).
    // Built one at a time; on 130GB expect a long, I/O-heavy build.
    print('[index] building tu_cover_byok (this is slow on a large collection)…');
    c.createIndex(
        { 'attributes.organizationId': 1, 'attributes.tu.isByok': 1, timestamp: 1, 'attributes.tu.model': 1, 'attributes.tu.tier': 1, 'attributes.prNumber': 1, ...sums },
        { name: 'tu_cover_byok', partialFilterExpression: { 'attributes.tu.isByok': true } },
    );
    print('[index] tu_cover_byok done. Building tu_cover_sys…');
    c.createIndex(
        { 'attributes.organizationId': 1, 'attributes.tu.sys': 1, timestamp: 1, 'attributes.tu.model': 1, 'attributes.tu.tier': 1, 'attributes.prNumber': 1, ...sums },
        { name: 'tu_cover_sys', partialFilterExpression: { 'attributes.tu.sys': { $exists: true } } },
    );
    print('[index] tu_cover_sys done.');
    // Drop the superseded dev-only top-level index if present (no-op in prod).
    try { c.dropIndex('tu_cover'); print('[index] dropped legacy top-level tu_cover'); } catch (e) { /* not present */ }
}

if (PHASE === 'backfill' || PHASE === 'all') backfill();
if (PHASE === 'index' || PHASE === 'all') createIndexes();
print('migration phase complete: ' + PHASE);
