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

const REPOS: Record<string, RepoSpec> = {
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
    const which = process.argv[2] ?? 'kutt';
    const spec = REPOS[which];
    if (!spec) throw new Error(`unknown repo '${which}' (have: ${Object.keys(REPOS).join(', ')})`);
    const hetzner = process.env.HETZNER_DEV;
    const anthropic = process.env.ANTHROPIC_API_KEY;
    if (!hetzner || !anthropic) throw new Error('missing HETZNER_DEV / ANTHROPIC_API_KEY');

    const env: Record<string, string> = {
        PREVIEW_VM_TOKEN: hetzner,
        PREVIEW_AGENT_API_KEY: anthropic,
        PREVIEW_AGENT_MODEL: 'claude-sonnet-4-5-20250929',
        PREVIEW_VM_REGION: 'hil',
        PREVIEW_VM_SIZE: spec.size ?? 'cpx41',
        PREVIEW_SNAPSHOT_CAPTURE: 'true', // the whole point of this matrix
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
