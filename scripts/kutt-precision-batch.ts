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
const CASES = [
    {
        name: 'recall-filter',
        sha: '5862bc359cc9234f5a6740e61cf8aeb55dd6e735',
        diff: 'diff-recall-filter.json',
        expect: 'FIND (search/filter breaks on sqlite — raw ILIKE unsupported)',
        kind: 'recall',
    },
    {
        name: 'precision-clean',
        sha: '6093ae39e2840cc40cd7d317943b15bf1367c133',
        diff: 'diff-precision-clean.json',
        expect: 'NONE (a clarifying comment, no behavior change)',
        kind: 'precision',
    },
];

const KUTT_ENV = {
    enabled: true,
    trigger: 'command',
    requiredEnv: ['JWT_SECRET'],
    setup: [
        'apt-get install -y -qq nodejs npm >/dev/null 2>&1 && node --version',
        'npm install --no-audit --no-fund 2>&1 | tail -2',
        "grep -v '^JWT_SECRET=' .example.env > .env && cat /opt/kody/customer.env >> .env",
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
    const results: any[] = [];
    for (const c of CASES) {
        console.log(`\n########## CASE ${c.name} (${c.kind}) — expect: ${c.expect}`);
        try {
            const r = await runCase(c);
            results.push(r);
            console.log(`>>> ${c.name}: ${r.findings.length} finding(s) | env-ok=${r.diag?.ok} turns=${r.diag?.turns} phases=[${r.diag?.phases}]`);
            console.log(`    agent summary: ${r.diag?.summary}`);
            for (const f of r.findings) {
                console.log(`    [${f.severity}] ${f.relevantFile}: ${(f.oneSentenceSummary || f.suggestionContent || '').slice(0, 160)}`);
            }
        } catch (e: any) {
            console.log(`>>> ${c.name}: ERROR ${e?.message ?? e}`);
            results.push({ name: c.name, kind: c.kind, error: String(e?.message ?? e) });
        }
    }
    console.log('\n########## BATCH SUMMARY');
    for (const r of results) {
        console.log(`${r.name} (${r.kind}): ${r.error ? 'ERROR' : `${r.findings.length} finding(s)`} — expected ${r.expect ?? ''}`);
    }
}

main().catch((e) => {
    console.error('[batch] FAILED:', e?.message ?? e);
    process.exit(1);
});
