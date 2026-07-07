/**
 * Precision/recall batch: run Kody Runtime against a set of REAL kutt PRs with
 * known ground truth — recall cases (a real historical bug reintroduced, agent
 * SHOULD find it) + a precision case (correct no-op change, agent should find
 * NOTHING). Prints per-case findings vs expectation so we can score the
 * judgment on real bugs, not synthetic ones.
 *
 * Run in the dev container (see how kodus1461-runtime.ts is invoked).
 */
import 'tsconfig-paths/register';
import * as fs from 'fs';
import * as os from 'os';
import { RunPreviewEnvStage } from '@libs/code-review/pipeline/stages/run-preview-env.stage';
import { PreviewEnvAgentService } from '@libs/sandbox/infrastructure/services/preview-env-agent.service';
import { VmSandboxService } from '@libs/sandbox/infrastructure/providers/vm-sandbox.service';

function cfgVal(name: string): string {
    const line = fs
        .readFileSync(os.homedir() + '/.kodus-dev/config', 'utf8')
        .split('\n')
        .find((l) => l.startsWith(name + '='));
    return (line ?? '').split('=').slice(1).join('=').replace(/^["']|["']$/g, '').trim();
}

const SP = process.env.SP as string;

// Ground truth. recall = a real kutt bug reintroduced (should be caught);
// precision = a correct no-op (should yield zero findings).
// RUNTIME-ONLY bug panel: bugs that are static-invisible (the diff looks fine)
// but only manifest when the app actually RUNS — the class that justifies the
// VM. A strong static reviewer can't catch these from the diff alone.
const CASES = [
    {
        name: 'runtime-nanoid-esm',
        sha: 'ecba1327dd98e9c72912bcf7c91c517c83894cc1',
        diff: 'diff-runtime-nanoid.json',
        // package.json: "nanoid": "3.3.8" → "^5.0.9". nanoid v4+ is ESM-only, so
        // the codebase's `require("nanoid")` throws ERR_REQUIRE_ESM at boot. The
        // diff is a 1-line version bump — no static reviewer knows v5 dropped CJS
        // without running it. Running: the app won't start.
        expect: 'FIND (app fails to boot — nanoid ^5 is ESM-only, breaks require())',
        kind: 'recall',
    },
];

const KUTT_ENV = {
    enabled: true,
    trigger: 'command',
    requiredEnv: ['JWT_SECRET'],
    setup: [
        'apt-get install -y -qq nodejs npm >/dev/null 2>&1 && node --version',
        'npm install --no-audit --no-fund 2>&1 | tail -2',
        // Robust env: seed from .example.env, append the injected customer.env
        // IF it exists (the product path), and GUARANTEE JWT_SECRET is set so the
        // app actually boots. The old `&& cat /opt/kody/customer.env` aborted the
        // whole setup (exit 1) when the file wasn't present → app never booted →
        // the agent could only reason statically. Never let this line fail.
        "cp .example.env .env; [ -f /opt/kody/customer.env ] && cat /opt/kody/customer.env >> .env; grep -q '^JWT_SECRET=..' .env || echo 'JWT_SECRET=kutt-batch-secret-9931' >> .env; true",
    ],
    build: ['npm run migrate 2>&1 | tail -3'],
    services: ['npm start'],
    test: [] as string[],
    // Readiness POLL (not a fixed sleep) — the proven-green probe pattern. A
    // fixed `sleep 6` marked the app not-ready before Node finished binding, so
    // the agent booted into an env with no running app and couldn't reproduce
    // the search/filter bug → false recall miss.
    healthcheck: [
        'for i in $(seq 1 30); do curl -sf http://localhost:3000/api/health -o /dev/null && echo HEALTH_OK && exit 0; sleep 2; done; echo TIMEOUT; exit 1',
    ],
};

async function runCase(c: (typeof CASES)[number]) {
    const env: Record<string, string> = {
        PREVIEW_VM_TOKEN: cfgVal('HETZNER_DEV'),
        PREVIEW_AGENT_API_KEY: cfgVal('KIMI_CODING_PLAN_KEY'),
        PREVIEW_AGENT_MODEL: 'kimi-k2.6',
        PREVIEW_VM_REGION: 'hil',
        PREVIEW_VM_SIZE: 'cpx31',
    };
    const config: any = { get: (k: string) => env[k] };
    const cloneParamsResolver: any = {
        resolve: async () => ({
            url: 'https://github.com/kodus-e2e/tiny-url',
            authToken: cfgVal('GH_TEST_TOKEN') || undefined,
            authUsername: undefined,
            branch: c.name,
            baseBranch: 'kutt-main',
            prNumber: undefined,
            platform: 'github',
            checkoutSha: c.sha,
        }),
    };
    const changedFiles = JSON.parse(fs.readFileSync(`${SP}/${c.diff}`, 'utf8'));

    const captured: { rec?: any } = {};
    const stage = new RunPreviewEnvStage(
        config,
        cloneParamsResolver,
        new PreviewEnvAgentService(),
        new VmSandboxService(config),
        { resolveSecrets: async () => ({ JWT_SECRET: 'kutt-batch-secret-9931' }) } as any,
        { resolveInfra: async () => null } as any,
        { computeKey: () => 'k', resolveFresh: async () => null } as any,
        { save: async (r: any) => { captured.rec = r; } } as any,
    );

    const context: any = {
        codeReviewConfig: { environment: KUTT_ENV },
        changedFiles,
        repository: { id: `kutt-${c.name}`, name: 'tiny-url' },
        origin: 'command',
        runtimeRequested: true,
    };

    const out: any = await stage.execute(context);
    const findings = out.validSuggestions ?? [];
    // The stub runRepository.save is gated (no org context), so read the record
    // straight off the returned context (draft.runtimeRun + previewEnvSignal) to
    // diagnose env-vs-judgment: app up (healthcheck ok) + agent worked (turns)?
    const rec = captured.rec?.record ?? out.runtimeRun ?? {};
    const sig = out.previewEnvSignal ?? {};
    const phases = (sig.phases ?? rec.phases ?? [])
        .map((p: any) => `${p.phase}:${p.exitCode}`)
        .join(' ');
    return {
        name: c.name, kind: c.kind, expect: c.expect, findings,
        diag: { ok: sig.ok ?? rec.ok, turns: rec.turns, phases, summary: (rec.summary ?? '').slice(0, 400) },
    };
}

async function main() {
    // Parallel (cold): each case provisions its own VM; the parallel-safe VM
    // name (randomBytes) makes concurrent provisions collision-free. ~15min for
    // the whole panel instead of ~75min sequential.
    console.log(`[batch] running ${CASES.length} cases in parallel…`);
    const results = await Promise.all(
        CASES.map(async (c) => {
            try {
                const r = await runCase(c);
                console.log(`>>> ${c.name} (${c.kind}): ${r.findings.length} finding(s) | env-ok=${r.diag?.ok} turns=${r.diag?.turns} phases=[${r.diag?.phases}]`);
                for (const f of r.findings) {
                    console.log(`    [${f.severity}] ${f.relevantFile}: ${(f.oneSentenceSummary || f.suggestionContent || '').slice(0, 160)}`);
                }
                return r;
            } catch (e: any) {
                console.log(`>>> ${c.name}: ERROR ${e?.message ?? e}`);
                return { name: c.name, kind: c.kind, expect: c.expect, error: String(e?.message ?? e), findings: [] };
            }
        }),
    );
    // Score: recall = caught / recall-cases; precision noise = precision-cases
    // that (wrongly) produced findings.
    const recallCases = results.filter((r) => r.kind === 'recall');
    const precisionCases = results.filter((r) => r.kind === 'precision');
    const caught = recallCases.filter((r) => (r.findings?.length ?? 0) > 0);
    const noisy = precisionCases.filter((r) => (r.findings?.length ?? 0) > 0);
    console.log('\n########## BATCH SUMMARY');
    for (const r of results as any[]) {
        const mark = r.error ? 'ERROR' : r.kind === 'recall' ? ((r.findings.length > 0) ? 'CAUGHT ✓' : 'MISSED ✕') : ((r.findings.length === 0) ? 'CLEAN ✓' : 'NOISE ✕');
        console.log(`${mark}  ${r.name} (${r.kind}): ${r.findings?.length ?? 0} finding(s) — expected ${r.expect ?? ''}`);
    }
    console.log(`\n########## RECALL ${caught.length}/${recallCases.length} · PRECISION ${precisionCases.length - noisy.length}/${precisionCases.length} clean (${noisy.length} noisy)`);
}

main().catch((e) => {
    console.error('[batch] FAILED:', e?.message ?? e);
    process.exit(1);
});
