/**
 * REAL-PR FRONTEND runtime test: run the Kody Runtime stage against
 * kodustech/kodus-ai PR #1513 ("perf: heavy screens refactor", 90 web files) —
 * a genuine open PR whose risk surface is RENDERING: a perf refactor of heavy
 * screens is exactly where a broken memo/hook/suspense boundary throws at
 * mount. The playbook boots the REAL stack on the VM (docker compose: dbs +
 * api + web), and the agent — which now has Playwright + Chromium on the VM —
 * must register a fresh account through the sign-up UI and drive the
 * refactored screens in a real browser.
 *
 * No credentials: kodus-ai is public, deps are public-read.
 *
 * Run inside the dev container (repo mounted at /usr/src/app):
 *   docker exec -e HETZNER_DEV=... -e KIMI_CODING_PLAN_KEY=... kodus_api_kprev \
 *     node_modules/.bin/ts-node -r tsconfig-paths/register scripts/kodus1513-front-runtime.ts
 */
import 'tsconfig-paths/register';
import * as fs from 'fs';
import { RunPreviewEnvStage } from '@libs/code-review/pipeline/stages/run-preview-env.stage';
import { PreviewEnvAgentService } from '@libs/sandbox/infrastructure/services/preview-env-agent.service';
import { VmSandboxService } from '@libs/sandbox/infrastructure/providers/vm-sandbox.service';

const HEAD_SHA = 'ff3fd4fa37f47a32664f9dc9c13844dfcdc19402';

async function main() {
    const hetzner = process.env.HETZNER_DEV;
    // Real Anthropic (the Kimi coding-plan key 402'd — membership inactive).
    const anthropic = process.env.ANTHROPIC_API_KEY;
    if (!hetzner || !anthropic) throw new Error('missing HETZNER_DEV / ANTHROPIC_API_KEY env');

    const env: Record<string, string> = {
        PREVIEW_VM_TOKEN: hetzner,
        PREVIEW_AGENT_API_KEY: anthropic,
        PREVIEW_AGENT_MODEL: 'claude-sonnet-4-5-20250929',
        PREVIEW_VM_REGION: 'hil',
        PREVIEW_VM_SIZE: 'cpx51', // full stack (pg+mongo+rabbit+api+web) needs the big box
    };
    const config: any = { get: (k: string) => env[k] };

    const cloneParamsResolver: any = {
        resolve: async () => ({
            url: 'https://github.com/kodustech/kodus-ai',
            authToken: undefined,
            authUsername: undefined,
            branch: 'perf/heavy-screens-refactor',
            baseBranch: 'main',
            prNumber: 1513,
            platform: 'github',
            checkoutSha: HEAD_SHA,
        }),
    };

    const changedFiles = JSON.parse(
        fs.readFileSync('scripts/.tmp-pr1513-diff.json', 'utf8'),
    );

    const environment = {
        enabled: true,
        trigger: 'command',
        requiredEnv: [] as string[],
        setup: [
            'cp .env.example .env',
            // The dev compose declares these as EXTERNAL networks (created by
            // the local multi-stack overlay); a bare VM has neither, so create
            // them or every `up` fails to attach.
            'docker network create kodus-backend-services 2>/dev/null; docker network create shared-network 2>/dev/null; true',
            // Real service names: db_postgres / db_mongodb / rabbitmq.
            'docker compose -f docker-compose.dev.yml up -d --quiet-pull db_postgres db_mongodb rabbitmq 2>&1 | tail -5',
            'docker compose -f docker-compose.dev.yml build kodus-api web 2>&1 | tail -6',
            // API first (it runs migrations to become healthy).
            'docker compose -f docker-compose.dev.yml up -d kodus-api 2>&1 | tail -4',
            // Web with --no-deps so it starts even before api is "healthy" —
            // the sign-in/sign-up pages render client-side and are themselves
            // part of the refactored surface under review.
            'sleep 20; docker compose -f docker-compose.dev.yml up -d --no-deps web 2>&1 | tail -4',
        ],
        build: [] as string[],
        services: [] as string[],
        test: [] as string[],
        healthcheck: [
            // Dev-mode Next compiles on first hit: long ready window. Report
            // both; the agent proceeds with whatever is up (web alone still
            // exercises the refactored sign-in/sign-up render).
            'for i in $(seq 1 120); do curl -sf http://localhost:3000/sign-in >/dev/null 2>&1 && break; sleep 10; done; docker compose -f docker-compose.dev.yml ps --format "{{.Service}} {{.Status}}" 2>&1 | tail -8; curl -s -o /dev/null -w "web=%{http_code} " http://localhost:3000/sign-in; curl -s -o /dev/null -w "api=%{http_code}\\n" http://localhost:3001/health',
        ],
    };

    const stage = new RunPreviewEnvStage(
        config,
        cloneParamsResolver,
        new PreviewEnvAgentService(),
        new VmSandboxService(config),
        { resolveSecrets: async () => ({}) } as any,
        { resolveInfra: async () => null } as any,
        // No golden snapshot for kodus-ai: cold boot.
        {
            computeKey: () => 'standalone',
            resolveFresh: async () => null,
            capture: async () => undefined,
            maybeCapture: async () => undefined,
        } as any,
        // No durable run store in this standalone driver.
        { save: async () => undefined, update: async () => undefined } as any,
    );

    const context: any = {
        codeReviewConfig: { environment },
        changedFiles,
        repository: { id: 'kodus-ai', name: 'kodus-ai' },
        origin: 'command',
        runtimeRequested: true,
        reviewDirective:
            'FRONTEND of this perf refactor. The web UI runs at http://localhost:3000 (API at :3001). Use the Playwright browser (per your frontend instructions) to: (1) load /sign-in and /sign-up — zero PAGE-ERROR/CONSOLE-ERROR tolerated; (2) REGISTER a fresh account through the sign-up form and complete/skip onboarding as far as the UI allows; (3) then drive the screens this PR refactored — /pull-requests, cockpit, token-usage, issues — and hunt for regressions the refactor introduced: exceptions at mount, blank/partial renders, broken filters/tabs/pagination, infinite re-render (page never settles), dead buttons. Empty-state rendering counts: these screens must render their empty states cleanly for a fresh org. Report ONLY defects with browser output as evidence.',
    };

    console.log('[kodus1513] provisioning VM + booting the full stack (slow)…');
    const out: any = await stage.execute(context);

    console.log('\n===== PREVIEW ENV SIGNAL =====');
    console.log(JSON.stringify(out.previewEnvSignal, null, 2));
    console.log('\n===== FINDINGS (validSuggestions) =====');
    const found = out.validSuggestions ?? [];
    console.log(`count: ${found.length}`);
    for (const s of found) {
        console.log(`\n--- [${s.severity}] ${s.relevantFile} (label=${s.label}) ---`);
        console.log(s.suggestionContent?.slice(0, 2000));
    }
    console.log('\n[kodus1513] done.');
}

main().catch((e) => {
    console.error('[kodus1513] FAILED:', e?.message ?? e);
    process.exit(1);
});
