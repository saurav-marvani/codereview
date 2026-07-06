/**
 * REAL-PR runtime test: run the Kody Runtime stage against kodustech/kodus-ai
 * PR #1461 ("Token Usage screen revamp") — a genuine, non-planted PR whose meat
 * is pure token cost/pricing math (libs/analytics/.../usage/*). No credentials
 * needed: kodus-ai is public and @kodus/kodus-common is public-read on GCP AR,
 * so a fresh VM installs it the same way an OSS contributor does.
 *
 * The playbook only sets up the toolchain + installs deps (no app boot — the
 * value is executable logic, not a running server). The agent then EXECUTES the
 * changed cost/pricing functions to look for real bugs (wrong math, NaN,
 * rounding/percentage errors, edge cases).
 *
 * Run in the dev container:
 *   node_modules/.bin/ts-node -r tsconfig-paths/register scripts/kodus1461-runtime.ts
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
const HEAD_SHA = 'c720a97b8fcb28ce957d95a8cfa0419d34272357';

async function main() {
    const hetzner = cfgVal('HETZNER_DEV');
    const kimi = cfgVal('KIMI_CODING_PLAN_KEY');
    if (!hetzner || !kimi) throw new Error('missing HETZNER_DEV / KIMI_CODING_PLAN_KEY');

    const env: Record<string, string> = {
        PREVIEW_VM_TOKEN: hetzner,
        PREVIEW_AGENT_API_KEY: kimi,
        PREVIEW_AGENT_MODEL: 'kimi-k2.6',
        PREVIEW_VM_REGION: 'hil',
        PREVIEW_VM_SIZE: 'cpx41', // bigger box → faster monorepo install
    };
    const config: any = { get: (k: string) => env[k] };

    // Public repo → anonymous clone, check out the PR head.
    const cloneParamsResolver: any = {
        resolve: async () => ({
            url: 'https://github.com/kodustech/kodus-ai',
            authToken: undefined,
            authUsername: undefined,
            branch: 'feat/token-usage-revamp',
            baseBranch: 'main',
            prNumber: 1461,
            platform: 'github',
            checkoutSha: HEAD_SHA,
        }),
    };

    const changedFiles = JSON.parse(
        fs.readFileSync(`${SP}/pr1461-diff.json`, 'utf8'),
    );

    const environment = {
        enabled: true,
        trigger: 'command',
        requiredEnv: [] as string[],
        setup: [
            // Toolchain: Node 22 + pnpm (matches the repo's packageManager).
            'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1',
            'apt-get install -y -qq nodejs >/dev/null 2>&1 && node --version',
            'npm i -g pnpm@11.9.0 >/dev/null 2>&1 && pnpm --version',
            // Install deps the OSS-contributor way (public registry, no creds).
            'pnpm install --frozen-lockfile 2>&1 | tail -15',
        ],
        build: [] as string[],
        services: [] as string[],
        test: [] as string[],
        // Prove the environment can actually execute the changed logic before
        // the agent digs in: run one of the pricing specs.
        healthcheck: [
            'API_NODE_ENV=test NODE_OPTIONS=--max-old-space-size=4096 node_modules/.bin/jest --config jest.config.ts --testPathPatterns="model-cost-calculator|token-pricing" --no-coverage --forceExit 2>&1 | tail -15',
        ],
    };

    const stage = new RunPreviewEnvStage(
        config,
        cloneParamsResolver,
        new PreviewEnvAgentService(),
        new VmSandboxService(config),
        { resolveSecrets: async () => ({}) } as any, // no secrets vault
        { resolveInfra: async () => null } as any, // env token, no org infra
    );

    const context: any = {
        codeReviewConfig: { environment },
        changedFiles,
        repository: { id: 'kodus-ai', name: 'kodus-ai' },
        origin: 'command',
        runtimeRequested: true,
        reviewDirective:
            'the token cost / pricing calculation logic in this PR: verify the math is correct by EXECUTING it — cost per token vs the pricing table, per-model cost aggregation, the summary/percentage computation, and edge cases (zero tokens, unknown/missing model price, very large and very small token counts, rounding that could show a non-zero value as 0.0%). Reproduce any discrepancy with a runnable script and real output.',
    };

    console.log('[kodus1461] provisioning VM + installing kodus-ai (this is the slow part)…');
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
    console.log('\n[kodus1461] done.');
}

main().catch((e) => {
    console.error('[kodus1461] FAILED:', e?.message ?? e);
    process.exit(1);
});
