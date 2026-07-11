/**
 * RUNTIME MATRIX — tests the productized Kody Runtime stage across repos and,
 * per repo, folds the three goals into one flow:
 *   (1) SPEED   — cold boot captures a golden snapshot, a 2nd PR warm-boots;
 *                 we time both and report the delta.
 *   (2) BUGS    — the bug-finding agent runs on each real PR; findings reported.
 *   (3) BOOT    — the playbook must actually boot the app on a bare VM.
 *
 * Cold and warm share ONE in-memory org-parameters store so the snapshot the
 * cold run records is visible to the warm run (resolveFresh → warm boot).
 *
 * Public repos → anonymous clone, no repo writes. Run in the dev container:
 *   docker exec -e HETZNER_DEV=... -e ANTHROPIC_API_KEY=... kodus_api_kprev \
 *     node_modules/.bin/ts-node -r tsconfig-paths/register scripts/runtime-matrix.ts kutt
 */
import 'tsconfig-paths/register';
import * as fs from 'fs';
import { RunPreviewEnvStage } from '@libs/code-review/pipeline/stages/run-preview-env.stage';
import { PreviewEnvAgentService } from '@libs/sandbox/infrastructure/services/preview-env-agent.service';
import { VmSandboxService } from '@libs/sandbox/infrastructure/providers/vm-sandbox.service';
import { PreviewEnvSnapshotService } from '@libs/code-review/pipeline/services/preview-env-snapshot.service';

type PR = { pr: number; sha: string; diffFile: string };
type RepoSpec = {
    name: string;
    url: string;
    baseBranch: string;
    playbook: any;
    cold: PR;
    warm: PR;
    directive: string;
    size?: string;
};

// Warm-safe kutt playbook: node install is idempotent, DB containers are
// start-or-run (the migrated pg is preserved in the snapshot), and npm ci is
// skipped when node_modules is already baked. Services start with setsid so the
// backgrounded server survives the per-command SSH session.
const KUTT_PLAYBOOK = {
    requiredEnv: ['JWT_SECRET'],
    setup: [
        'command -v node >/dev/null 2>&1 || (curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs)',
        'docker start kutt-postgres 2>/dev/null || docker run -d --name kutt-postgres -e POSTGRES_DB=kutt -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -p 5432:5432 postgres:16-alpine',
        'docker start kutt-redis 2>/dev/null || docker run -d --name kutt-redis -p 6379:6379 redis:alpine',
        'sleep 5',
        // Always npm ci — the baked node_modules from a crash-consistent
        // snapshot can't be trusted (a package.json can come back truncated →
        // ERR_INVALID_PACKAGE_CONFIG). The npm cache IS baked, so this reinstalls
        // network-free and fast. Self-healing beats a broken warm boot.
        'npm ci 2>&1 | tail -3',
        `cat > .env <<'EOF'
JWT_SECRET=devsecretdevsecretdevsecret1234
DB_CLIENT=pg
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=kutt
DB_USER=postgres
DB_PASSWORD=postgres
DB_SSL=false
REDIS_ENABLED=true
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
DISALLOW_REGISTRATION=false
EOF`,
    ],
    // pipefail so a real migrate failure surfaces (a bare `| tail` masks the
    // exit code — the pipe reports tail's success, hiding the error).
    build: ['set -o pipefail; set -a; source .env; set +a; npx knex migrate:latest 2>&1 | tail -5'],
    services: [
        'set -a; source .env; set +a; setsid bash -c "npm start > /tmp/kody-svc.log 2>&1" < /dev/null & echo started',
    ],
    test: [],
    healthcheck: [
        'for i in $(seq 1 30); do curl -sf http://localhost:3000/api/v2/health >/dev/null 2>&1 && break; sleep 3; done; curl -s -o /dev/null -w "health=%{http_code} login=" http://localhost:3000/api/v2/health; curl -s -o /dev/null -w "%{http_code}\\n" http://localhost:3000/login',
    ],
};

// Heavy docker-compose stack — the big-win warm-boot case: the snapshot bakes
// the built images + migrated DBs, so warm skips the whole `compose build`
// (the ~20-30min cold cost) and the source is bind-mounted fresh per PR.
// Warm-safe: network-create is idempotent, `up -d` restarts the baked
// containers, and the baked-migrated DB makes api come healthy fast (which is
// what timed out on the earlier cold-only frontend run).
const KODUS_PLAYBOOK = {
    requiredEnv: [] as string[],
    setup: [
        'cp .env.example .env',
        // .env.example ships these empty; two import-time crypto validators
        // (crypto.ts / webhookTokenCrypto.ts) THROW at boot unless they're a
        // valid 32-byte hex → the api crashes "unhealthy". Set valid dummies.
        'for kv in "API_CRYPTO_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" "CODE_MANAGEMENT_SECRET=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" "CODE_MANAGEMENT_WEBHOOK_TOKEN=devwebhooktoken0123456789" "API_JWT_SECRET=devjwtsecret0123456789abcdef" "API_JWT_REFRESH_SECRET=devjwtrefreshsecret0123456789"; do k="${kv%%=*}"; if grep -q "^$k=" .env; then sed -i "s|^$k=.*|$kv|" .env; else echo "$kv" >> .env; fi; done; echo boot-env-set',
        'docker network create kodus-backend-services 2>/dev/null; docker network create shared-network 2>/dev/null; true',
        'docker compose -f docker-compose.dev.yml up -d --quiet-pull db_postgres db_mongodb rabbitmq 2>&1 | tail -4',
        'set -o pipefail; docker compose -f docker-compose.dev.yml build kodus-api web 2>&1 | tail -5',
        'docker compose -f docker-compose.dev.yml up -d kodus-api 2>&1 | tail -3',
        'sleep 20; docker compose -f docker-compose.dev.yml up -d --no-deps web 2>&1 | tail -3',
    ],
    build: [] as string[],
    services: [] as string[],
    test: [] as string[],
    // Web-only readiness (short): kodus-api doesn't become healthy on a bare VM
    // (a separate app-boot issue), so waiting on it just burns ~12min equally in
    // both runs and masks the warm-boot delta. Gate on web=200 to isolate the
    // provision+build speedup, which is the whole point of this timing run.
    healthcheck: [
        'for i in $(seq 1 45); do curl -sf http://localhost:3001/health >/dev/null 2>&1 && break; sleep 8; done; docker compose -f docker-compose.dev.yml ps --format "{{.Service}} {{.Status}}" 2>&1 | tail -6; curl -s -o /dev/null -w "web=%{http_code} " http://localhost:3000/sign-in; curl -s -o /dev/null -w "api=%{http_code}\\n" http://localhost:3001/health; curl -sf http://localhost:3001/health >/dev/null 2>&1 || (echo "=== kodus_api logs (still unhealthy) ==="; docker logs kodus_api --tail 30 2>&1 | tail -30)',
    ],
};

// DEEP test: cal.com FULLY booted (Postgres + Redis + Prisma migrate + db-seed +
// yarn dev) so the agent exercises a data-dependent PR against a REAL running app
// + seeded DB — not a unit in isolation. Phases reordered for the stage's fixed
// setup→build→services→healthcheck order (DBs+env in setup, prisma+seed in build).
const CALCOM_DEEP_PLAYBOOK = {
    requiredEnv: [] as string[],
    setup: [
        'corepack enable',
        'corepack prepare yarn@4.12.0 --activate',
        'cd /opt/repo && yarn install --immutable 2>&1 | tail -4',
        'docker rm -f calcom-postgres calcom-redis >/dev/null 2>&1 || true',
        'docker run -d --name calcom-postgres -e POSTGRES_USER=unicorn_user -e POSTGRES_PASSWORD=magical_password -e POSTGRES_DB=calendso -p 5450:5432 postgres:15',
        'docker run -d --name calcom-redis -p 6379:6379 redis:latest',
        'sleep 6',
        `cd /opt/repo && cp .env.example .env && sed -i 's#DATABASE_URL="postgresql://postgres:@localhost:5450/calendso"#DATABASE_URL="postgresql://unicorn_user:magical_password@localhost:5450/calendso"#' .env && sed -i 's#DATABASE_DIRECT_URL="postgresql://postgres:@localhost:5450/calendso"#DATABASE_DIRECT_URL="postgresql://unicorn_user:magical_password@localhost:5450/calendso"#' .env && sed -i 's#^NEXTAUTH_SECRET=.*#NEXTAUTH_SECRET=supersecretnextauthkeysupersecretnextauthkey#' .env && sed -i 's#^CALENDSO_ENCRYPTION_KEY=.*#CALENDSO_ENCRYPTION_KEY=supersecretencryptionkey123456#' .env && echo env-ready`,
    ],
    build: [
        'cd /opt/repo && yarn prisma generate 2>&1 | tail -3',
        'set -o pipefail; cd /opt/repo && yarn db-deploy 2>&1 | tail -4',
        'set -o pipefail; cd /opt/repo && yarn db-seed 2>&1 | tail -4',
    ],
    services: [
        "cd /opt/repo && setsid bash -c 'yarn dev > /tmp/kody-svc.log 2>&1 < /dev/null &'; echo web-starting",
    ],
    test: [] as string[],
    healthcheck: [
        'for i in $(seq 1 90); do curl -sf -o /dev/null http://localhost:3000/auth/login 2>/dev/null && break; sleep 4; done; curl -s -o /dev/null -w "web=%{http_code}\\n" http://localhost:3000/auth/login',
    ],
};

const MEDUSA_DEEP_PLAYBOOK = {
    requiredEnv: [] as string[],
    setup: [
        'corepack enable',
        'cd /opt/repo && yarn install --immutable --inline-builds 2>&1 | tail -4',
        'docker rm -f medusa-postgres medusa-redis >/dev/null 2>&1 || true',
        'docker run -d --name medusa-postgres -e POSTGRES_PASSWORD=magical -e POSTGRES_USER=postgres -p 5432:5432 postgres:15-alpine',
        'docker run -d --name medusa-redis -p 6379:6379 redis',
        'for i in $(seq 1 30); do docker exec medusa-postgres pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; docker exec medusa-postgres pg_isready -U postgres',
    ],
    build: ['set -o pipefail; cd /opt/repo && yarn build 2>&1 | tail -6'],
    services: [] as string[],
    test: [] as string[],
    healthcheck: ['docker exec medusa-postgres pg_isready -U postgres && echo db-ready'],
};

// BLIND directive for the "do we catch a real shipped runtime bug?" test — it
// must NOT name the bug (that would be cheating); just the normal review ask.
const BLIND_DIRECTIVE =
    'Review this PR by EXERCISING it, assuming nothing. From the diff, identify every behavior the code now exhibits and every guarantee it might break; then run the affected path against the REAL app/DB — seed representative data if the change is data-shaped (create the rows/records the code operates on), invoke the changed code, and QUERY the DB / print the raw result, comparing actual output to what you expect by hand. A change that silently produces a wrong value (null/empty/NaN/duplicated/lost rows), a wrong query result, or a broken behavior is a defect even if it looks fine in the diff. Report ONLY defects you reproduce, with the exact command + real output; return an empty findings array if the PR is correct.';

const REPOS: Record<string, RepoSpec> = {
    'medusa-rtbug': {
        name: 'medusa-rtbug',
        url: 'https://github.com/medusajs/medusa',
        baseBranch: 'develop',
        size: 'cpx51',
        playbook: MEDUSA_DEEP_PLAYBOOK,
        cold: { pr: 14570, sha: 'a6aa4565c2', diffFile: 'scripts/rtbug/medusa-meta.json' },
        warm: { pr: 14570, sha: 'a6aa4565c2', diffFile: 'scripts/rtbug/medusa-meta.json' },
        directive: BLIND_DIRECTIVE,
    },
    'immich-rtbug': {
        name: 'immich-rtbug',
        url: 'https://github.com/immich-app/immich',
        baseBranch: 'main',
        size: 'cpx51',
        playbook: {
            requiredEnv: [],
            setup: [
                'corepack enable 2>/dev/null || true',
                'cd /opt/repo && ( if [ -f pnpm-lock.yaml ]; then (command -v pnpm >/dev/null || npm i -g pnpm) >/dev/null 2>&1; pnpm install --ignore-scripts 2>&1 | tail -6; else echo no-lock; fi )',
            ],
            build: [],
            services: [],
            test: [],
            healthcheck: ['echo deps-ready'],
        },
        cold: { pr: 28817, sha: 'd7d4d3bf7e', diffFile: 'scripts/rtbug/immich-null.json' },
        warm: { pr: 28817, sha: 'd7d4d3bf7e', diffFile: 'scripts/rtbug/immich-null.json' },
        directive: BLIND_DIRECTIVE,
    },
    'medusa-deep': {
        name: 'medusa-deep',
        url: 'https://github.com/medusajs/medusa',
        baseBranch: 'develop',
        size: 'cpx51',
        playbook: MEDUSA_DEEP_PLAYBOOK,
        cold: { pr: 15969, sha: '13a27f397d1bdc092d591efc560e4c0395ded6fd', diffFile: 'scripts/batch/medusa-deep.json' },
        warm: { pr: 15969, sha: '13a27f397d1bdc092d591efc560e4c0395ded6fd', diffFile: 'scripts/batch/medusa-deep.json' },
        directive:
            'DEEP data review. Medusa is built from source; Postgres is up on localhost:5432 (user postgres / pass magical) and Redis on 6379. This PR touches prepareTaxLines in core-flows (packages/core/core-flows) — the tax-line computation for a cart. Get to exactly this change and exercise it against the REAL DB: run the medusa migrations to create the schema, seed a cart with line items + tax context, invoke the changed prepareTaxLines flow (via the built @medusajs/core-flows or an integration test that hits the real DB), and verify the `data` field is preserved on the returned tax lines (the exact guarantee the PR is about). Query the DB / print the raw returned tax lines. Report a defect only if you reproduce a discrepancy.',
    },
    'immich-deep': {
        name: 'immich-deep',
        url: 'https://github.com/immich-app/immich',
        baseBranch: 'main',
        size: 'cpx51',
        playbook: {
            requiredEnv: [],
            setup: [
                'corepack enable 2>/dev/null || true',
                'cd /opt/repo && ( if [ -f pnpm-lock.yaml ]; then (command -v pnpm >/dev/null || npm i -g pnpm) >/dev/null 2>&1; pnpm install --ignore-scripts 2>&1 | tail -6; elif [ -f yarn.lock ]; then corepack prepare yarn --activate 2>/dev/null || true; yarn install --ignore-scripts 2>&1 | tail -6; else echo no-lockfile; fi )',
            ],
            build: [],
            services: [],
            test: [],
            healthcheck: ['echo deps-ready'],
        },
        cold: { pr: 29664, sha: 'e701ba778876d69b2c0efb62a5ece2ca8846a9cc', diffFile: 'scripts/batch/immich-deep.json' },
        warm: { pr: 29664, sha: 'e701ba778876d69b2c0efb62a5ece2ca8846a9cc', diffFile: 'scripts/batch/immich-deep.json' },
        directive:
            'DEEP data-safety review. This PR wraps the DB migration runner in a TRANSACTION so a migration that fails midway rolls back cleanly (no half-applied schema). Get to exactly this change: read the changed migration-runner code, then TEST the transactionality against a REAL Postgres — `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=x postgres:16`, then drive the runner (or a minimal reproduction of it) with a migration batch where a LATER statement fails, and QUERY the DB to prove the EARLIER statements were rolled back with the fix (and would have been left half-applied without it). Show the before/after DB state. Report a defect only if the fix does NOT actually make it atomic.',
    },
    'kodus-ai-deep': {
        name: 'kodus-ai-deep',
        url: 'https://github.com/kodustech/kodus-ai',
        baseBranch: 'main',
        size: 'cpx51',
        playbook: KODUS_PLAYBOOK,
        cold: { pr: 1461, sha: 'c720a97b8fcb28ce957d95a8cfa0419d34272357', diffFile: 'scripts/batch/kodus-deep.json' },
        warm: { pr: 1461, sha: 'c720a97b8fcb28ce957d95a8cfa0419d34272357', diffFile: 'scripts/batch/kodus-deep.json' },
        directive:
            'DEEP data review. The kodus-ai stack is booted (web :3000, api :3001, Postgres/Mongo up). This PR revamps the token-usage / cost computation (apps/api/.../tokenUsage, token cost/pricing math). Get to exactly this change and exercise the cost/pricing functions against real inputs: isolate the changed cost calculators and feed representative token counts + models, then verify the per-token cost vs the pricing table, the aggregation, and especially rounding — a sub-cent value like 0.004 that rounds to 0 would show $0.00 / 0% usage even when non-zero. Print the raw computed numbers. Report a defect only if you reproduce a wrong number with the command + output.',
    },
    'cal.com-deep': {
        name: 'cal.com-deep',
        url: 'https://github.com/calcom/cal.com',
        baseBranch: 'main',
        size: 'cpx51',
        playbook: CALCOM_DEEP_PLAYBOOK,
        cold: { pr: 29685, sha: '3803944a588642af416789dc183879552660a0e3', diffFile: 'scripts/batch/calcom-deep-29685.json' },
        warm: { pr: 29685, sha: '3803944a588642af416789dc183879552660a0e3', diffFile: 'scripts/batch/calcom-deep-29685.json' },
        directive:
            'DEEP data-dependent review. The app is FULLY BOOTED: cal.com web on http://localhost:3000, Postgres on localhost:5450 (user unicorn_user / pass magical_password / db calendso), seeded (a user pro@example.com exists). This PR changes packages/features/bookings/lib/payment/processPaymentRefund.ts — the logic that refunds seat payments when a booking is cancelled. Get to exactly this change and exercise it against the REAL DB: use Prisma (cd /opt/repo; yarn prisma or a node/tsx script requiring @calcom/prisma) to SEED a booking that has multiple seats each with a Payment row, then invoke the changed processPaymentRefund path (import it, or drive the cancel flow) and QUERY the DB to verify EVERY seat payment is refunded (not just the first) — the exact guarantee the PR is about. Compare actual refunded rows/amounts to what you compute by hand. Report a defect only if you reproduce a discrepancy, with the command + real DB output.',
    },
    // Real HEAVY PR — does the agent get to WHAT THE PR CHANGED? The PR drops the
    // ".ics" suffix requirement from the ICS-feed URL validator. Setup just
    // installs deps (the monorepo yarn install); the agent should ISOLATE the
    // changed validator unit and call it (the prompt's preferred strategy) to
    // confirm the new behavior — no full service boot needed.
    'cal.com': {
        name: 'cal.com',
        url: 'https://github.com/calcom/cal.com',
        baseBranch: 'main',
        size: 'cpx51',
        playbook: {
            requiredEnv: [],
            setup: [
                'corepack enable',
                'corepack prepare yarn@4.12.0 --activate',
                'cd /opt/repo && yarn install --immutable 2>&1 | tail -5',
            ],
            build: [],
            services: [],
            test: [],
            healthcheck: ['echo deps-ready'],
        },
        cold: { pr: 29751, sha: '4a402ed4727480ef638cf280eb194ff713325441', diffFile: 'scripts/calcom-pr29751-diff.json' },
        warm: { pr: 29751, sha: '4a402ed4727480ef638cf280eb194ff713325441', diffFile: 'scripts/calcom-pr29751-diff.json' },
        directive:
            'This PR changes the ICS-feed URL validator in apps/api/v2/src/platform/calendars/input/create-ics.input.ts: it REMOVES the requirement that the URL end with ".ics", so it now accepts any http/https URL. Get to exactly this change: ISOLATE the changed validator unit and exercise it against the REAL code — import/instantiate the validator class (ts-node/tsx/node with the repo tsconfig) and call its validate() with a non-.ics URL (e.g. "http://example.com/calendar") AND a .ics URL AND a non-http scheme, printing the raw boolean each time; confirm the new behavior (non-.ics now passes, previously it was rejected). Then judge whether dropping the suffix check widens risk — does any code fetch this URL server-side (SSRF surface)? Report only what you reproduce with the command + real output.',
    },
    'kodus-ai': {
        name: 'kodus-ai',
        url: 'https://github.com/kodustech/kodus-ai',
        baseBranch: 'main',
        playbook: KODUS_PLAYBOOK,
        size: 'cpx51',
        cold: { pr: 1513, sha: '593533af458c8b051429395af1deb95e18eb190f', diffFile: 'scripts/.tmp-pr1513-diff.json' },
        warm: { pr: 1517, sha: '7e8eac59386dd9fdd39315f31f85569b470a68c2', diffFile: 'scripts/kodus-pr1517-diff.json' },
        directive:
            'Boot check only for this warm-boot timing run: confirm the web (:3000) and api (:3001) come up; report any mount-time error on the pages this PR touches. Keep it short.',
    },
    kutt: {
        name: 'kutt',
        url: 'https://github.com/thedevs-network/kutt',
        baseBranch: 'main',
        playbook: KUTT_PLAYBOOK,
        cold: { pr: 1007, sha: 'a2ddfba1cfd56e49e33205adb8dbfeeab926f951', diffFile: 'scripts/kutt-pr1007-diff.json' },
        warm: { pr: 1006, sha: '6219b6608e3088860dac171e3987f24a9a91a2a1', diffFile: 'scripts/kutt-pr1006-diff.json' },
        directive:
            'the visit-stats / browser-detection change in server/queues/visit.js: exercise it by driving real visits (curl the short-link redirect with crafted User-Agent / Referer headers), then QUERY the DB directly to verify the recorded browser/os/referrer counts match what you computed by hand. Check off-by-one/misclassification and any NaN/undefined written to the DB.',
    },
};

// Generic auto-install: detect the lockfile/manifest and install deps so the
// agent can import + exercise the changed unit. --ignore-scripts skips native
// postinstall builds (faster; the module tree is enough for a unit exercise).
const GENERIC_SETUP = [
    'corepack enable 2>/dev/null || true',
    'cd /opt/repo && ( if [ -f pnpm-lock.yaml ]; then (command -v pnpm >/dev/null || npm i -g pnpm) >/dev/null 2>&1; pnpm install --ignore-scripts 2>&1 | tail -6; elif [ -f yarn.lock ]; then corepack prepare yarn --activate 2>/dev/null || true; yarn install --ignore-scripts 2>&1 | tail -6; elif [ -f package-lock.json ]; then npm ci --ignore-scripts 2>&1 | tail -6; elif [ -f go.mod ]; then go build ./... 2>&1 | tail -6; elif [ -f requirements.txt ]; then pip3 install -r requirements.txt 2>&1 | tail -6; else echo no-lockfile-recognized; fi )',
];

const GENERIC_DIRECTIVE =
    'Review this PR by getting to EXACTLY what it changed. From the diff, identify the changed unit(s), then exercise them against the REAL code: isolate the changed function/class/module (import it via node/tsx/ts-node with the repo toolchain, or run the smallest script that calls it) and feed inputs that reveal whether the new behavior is correct AND whether it breaks any guarantee (security, data correctness, edge cases, injection, SSRF, auth). No long-running server is needed for a logic change — do not hunt for one. If the change is a safe/correct refactor or a fix with no reproducible defect, return an EMPTY findings array and say so in summary. Report ONLY defects you reproduce, with the exact command + real output.';

function batchSpec(e: any): RepoSpec {
    return {
        name: e.name,
        url: e.url,
        baseBranch: e.baseBranch || 'main',
        size: 'cpx41',
        playbook: { requiredEnv: [], setup: GENERIC_SETUP, build: [], services: [], test: [], healthcheck: ['echo deps-ready'] },
        cold: { pr: e.pr, sha: e.sha, diffFile: e.diffFile },
        warm: { pr: e.pr, sha: e.sha, diffFile: e.diffFile },
        directive: GENERIC_DIRECTIVE,
    };
}

function makeOrgParamsStore() {
    const stored: Record<string, any> = {};
    return {
        findByKey: async (key: string) => (stored[key] ? { configValue: stored[key] } : null),
        createOrUpdateConfig: async (key: string, value: any) => {
            stored[key] = value;
            return true;
        },
        _dump: () => stored,
    } as any;
}

async function runOnce(
    stage: RunPreviewEnvStage,
    spec: RepoSpec,
    which: 'cold' | 'warm',
): Promise<{ ms: number; ok: boolean; findings: number; boot: string }> {
    const pr = spec[which];
    const changedFiles = JSON.parse(fs.readFileSync(pr.diffFile, 'utf8'));
    const context: any = {
        codeReviewConfig: { environment: { enabled: true, trigger: 'command', ...spec.playbook } },
        changedFiles,
        repository: { id: spec.name, name: spec.name },
        organizationAndTeamData: { organizationId: 'matrix-org', teamId: 'matrix-team' },
        pullRequest: { number: pr.pr },
        origin: 'command',
        runtimeRequested: true,
        reviewDirective: spec.directive,
        _cloneOverride: { url: spec.url, branch: spec.baseBranch, baseBranch: spec.baseBranch, prNumber: pr.pr, platform: 'github', checkoutSha: pr.sha },
    };
    const started = Date.now();
    const out: any = await stage.execute(context);
    const ms = Date.now() - started;
    const sig = out.previewEnvSignal;
    // Full phase visibility — the whole point of a debug run.
    console.log(`  --- ${which} phases ---`);
    for (const p of sig?.phases ?? []) {
        console.log(`  [${p.phase}] exit=${p.exitCode} :: ${String(p.outputTail ?? '').replace(/\n/g, ' ⏎ ').slice(0, 400)}`);
    }
    if (!sig) console.log(`  NO SIGNAL — stage threw (see error above)`);
    // Agent transcript — did it target WHAT THE PR CHANGED? Print per-turn
    // reasoning + the commands it ran, so we can see it exercise the diff.
    const rr = out.runtimeRun;
    if (process.env.PRINT_TRANSCRIPT === 'true' && rr?.transcript) {
        console.log(`  --- ${which} agent transcript (${rr.turns} turns, ${rr.findingsCount} findings) ---`);
        for (const t of rr.transcript) {
            if (t.reasoning?.trim())
                console.log(`  [turn ${t.turn}] ${t.reasoning.replace(/\n/g, ' ').slice(0, 500)}`);
            for (const c of t.commands ?? [])
                console.log(`     $ ${String(c.command).replace(/\n/g, ' ').slice(0, 180)}`);
        }
        console.log(`  --- summary: ${String(rr.summary ?? '').replace(/\n/g, ' ').slice(0, 600)}`);
    }
    const boot =
        sig?.phases?.find((p: any) => p.phase === 'healthcheck')?.outputTail?.trim() ??
        (sig ? `ran ok=${sig.ok}` : 'NO SIGNAL (stage threw)');
    return { ms, ok: !!sig?.ok, findings: (out.validSuggestions ?? []).length, boot };
}

async function imageStatus(imageId: string): Promise<string> {
    const token = process.env.HETZNER_DEV;
    try {
        const r = await fetch(`https://api.hetzner.cloud/v1/images/${imageId}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        if (r.status === 404) return 'GONE (404)';
        const j: any = await r.json();
        return j?.image ? `exists status=${j.image.status}` : `unknown ${r.status}`;
    } catch (e: any) {
        return `check-failed ${e?.message ?? e}`;
    }
}

async function main() {
    let spec: RepoSpec;
    if (process.argv[2] === '--batch') {
        const batch = JSON.parse(fs.readFileSync('scripts/batch.json', 'utf8'));
        const entry = batch.find((b: any) => b.name === process.argv[3]);
        if (!entry) throw new Error(`batch entry not found: ${process.argv[3]}`);
        spec = batchSpec(entry);
    } else {
        const which = process.argv[2] ?? 'kutt';
        spec = REPOS[which];
        if (!spec) throw new Error(`unknown repo '${which}' (have: ${Object.keys(REPOS).join(', ')})`);
    }
    const hetzner = process.env.HETZNER_DEV;
    const anthropic = process.env.ANTHROPIC_API_KEY;
    if (!hetzner || !anthropic) throw new Error('missing HETZNER_DEV / ANTHROPIC_API_KEY');

    const env: Record<string, string> = {
        PREVIEW_VM_TOKEN: hetzner,
        PREVIEW_AGENT_API_KEY: anthropic,
        PREVIEW_AGENT_MODEL: 'claude-sonnet-4-5-20250929',
        PREVIEW_VM_REGION: 'hil',
        PREVIEW_VM_SIZE: spec.size ?? 'cpx41',
        // On for warm-boot timing runs; OFF for cold-only batch (a snapshot we
        // never consume just wastes a 5-15min create_image per repo).
        PREVIEW_SNAPSHOT_CAPTURE: process.env.PREVIEW_SNAPSHOT_CAPTURE ?? 'true',
        // Debuggable default; a boot-debug run passes PREVIEW_AGENT_MAX_TURNS=3
        // so the warm run doesn't burn turns flailing on a not-yet-fixed boot.
        PREVIEW_AGENT_MAX_TURNS: process.env.PREVIEW_AGENT_MAX_TURNS ?? '40',
    };
    const config: any = { get: (k: string) => env[k] };

    // Clone resolver honors the per-context override so cold/warm hit their SHAs.
    const cloneParamsResolver: any = {
        resolve: async (ctx: any) => ctx._cloneOverride,
    };
    // ONE snapshot store shared across cold+warm → the warm run finds the
    // snapshot the cold run recorded.
    const snapshotService = new PreviewEnvSnapshotService(makeOrgParamsStore());

    const stage = new RunPreviewEnvStage(
        config,
        cloneParamsResolver,
        new PreviewEnvAgentService(),
        new VmSandboxService(config),
        { resolveSecrets: async () => ({}) } as any,
        { resolveInfra: async () => null } as any,
        snapshotService,
        { save: async () => undefined, update: async () => undefined } as any,
    );

    console.log(`\n===== RUNTIME MATRIX: ${spec.name} =====`);
    console.log(`[${spec.name}] COLD run (PR #${spec.cold.pr}) — provisions, boots, captures snapshot…`);
    const cold = await runOnce(stage, spec, 'cold');
    console.log(`[${spec.name}] COLD done: ${(cold.ms / 60000).toFixed(1)}min | boot: ${cold.boot} | findings: ${cold.findings}`);
    const snap = (snapshotService as any).orgParams?._dump?.() ?? {};
    const recorded: any = Object.values(snap)[0]
        ? Object.values((Object.values(snap)[0] as any))[0]
        : null;
    const imageId = recorded?.imageId;
    console.log(`[${spec.name}] snapshot recorded: ${JSON.stringify(recorded ?? 'NONE')}`);
    if (imageId) console.log(`[${spec.name}] image ${imageId} right after COLD: ${await imageStatus(imageId)}`);

    // Cold-only mode: for the "did the agent get to the PR change?" demo we run
    // one cold boot with the full agent + transcript, no warm-boot timing.
    if (process.env.MATRIX_COLD_ONLY === 'true') {
        console.log(`\n[${spec.name}] COLD-ONLY done: ${(cold.ms / 60000).toFixed(1)}min | boot: ${cold.boot} | findings: ${cold.findings}`);
        console.log('[matrix] done.');
        return;
    }

    console.log(`\n[${spec.name}] WARM run (PR #${spec.warm.pr}) — should warm-boot from the snapshot…`);
    if (imageId) console.log(`[${spec.name}] image ${imageId} right BEFORE warm: ${await imageStatus(imageId)}`);
    const warm = await runOnce(stage, spec, 'warm');
    if (imageId) console.log(`[${spec.name}] image ${imageId} right AFTER warm: ${await imageStatus(imageId)}`);
    console.log(`[${spec.name}] WARM done: ${(warm.ms / 60000).toFixed(1)}min | boot: ${warm.boot} | findings: ${warm.findings}`);

    const delta = cold.ms > 0 ? (100 * (cold.ms - warm.ms)) / cold.ms : 0;
    console.log(`\n===== ${spec.name} RESULT =====`);
    console.log(`cold:  ${(cold.ms / 60000).toFixed(1)}min  (boot ok=${cold.ok}, ${cold.findings} findings)`);
    console.log(`warm:  ${(warm.ms / 60000).toFixed(1)}min  (boot ok=${warm.ok}, ${warm.findings} findings)`);
    console.log(`SPEEDUP: warm is ${delta.toFixed(0)}% faster than cold (${((cold.ms - warm.ms) / 60000).toFixed(1)}min saved)`);
    console.log('[matrix] done.');
}

main().catch((e) => {
    console.error('[matrix] FAILED:', e?.stack ?? e?.message ?? e);
    process.exit(1);
});
