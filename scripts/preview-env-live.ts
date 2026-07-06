/**
 * LIVE smoke test of the preview-env alpha: constructs the REAL
 * RunPreviewEnvStage with real config (Hetzner VM token + LLM key) and runs it
 * against a real public repo (kutt) — provisioning a real VM, booting the app
 * from the playbook, running the ported bug-finding agent, mapping findings to
 * validSuggestions with proof, and tearing the VM down. Closes the
 * "never run live" gap without booting the full Kody web stack.
 *
 * Run: node_modules/.bin/ts-node -r tsconfig-paths/register scripts/preview-env-live.ts
 */
import 'tsconfig-paths/register';
import * as fs from 'fs';
import * as os from 'os';
import * as yaml from 'js-yaml';
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

async function main() {
    const hetzner = cfgVal('HETZNER_DEV');
    const kimi = cfgVal('KIMI_CODING_PLAN_KEY');
    if (!hetzner || !kimi) throw new Error('missing HETZNER_DEV / KIMI_CODING_PLAN_KEY');

    const env: Record<string, string> = {
        PREVIEW_VM_TOKEN: hetzner,
        PREVIEW_AGENT_API_KEY: kimi,
        PREVIEW_AGENT_MODEL: 'kimi-k2.6',
        PREVIEW_VM_REGION: 'hil',
        PREVIEW_VM_SIZE: 'cpx31',
        PREVIEW_ENV_SECRETS: JSON.stringify({ r1: { JWT_SECRET: 'live-smoke-secret' } }),
    };
    const config: any = { get: (k: string) => env[k] };

    // Public repo → no auth needed; stub the clone resolver.
    const cloneParamsResolver: any = {
        resolve: async () => ({
            url: 'https://github.com/thedevs-network/kutt',
            authToken: undefined,
            authUsername: undefined,
            branch: 'main',
            baseBranch: 'main',
            prNumber: undefined,
            platform: 'github',
            checkoutSha: undefined,
        }),
    };

    const playbook = yaml.load(
        fs.readFileSync(os.homedir() + '/.kodus-dev/preview-env/runs/kutt2/environment.hardened.yml', 'utf8'),
    ) as any;

    const stage = new RunPreviewEnvStage(
        config,
        cloneParamsResolver,
        new PreviewEnvAgentService(),
        new VmSandboxService(config),
    );

    // The "PR under review": a real data-layer change (kutt's count-alias) so
    // the agent has something concrete to exercise against the running app.
    const context: any = {
        codeReviewConfig: {
            environment: {
                enabled: true,
                requiredEnv: ['JWT_SECRET'],
                setup: playbook.setup ?? [],
                build: playbook.build ?? [],
                services: playbook.services ?? [],
                test: playbook.test ?? [],
                healthcheck: playbook.healthcheck ?? [],
            },
        },
        changedFiles: [
            {
                filename: 'server/queries/link.queries.js',
                patch: '@@ total() @@\n-  query.count("* as count");\n+  query.count("*");',
            },
        ],
        repository: { id: 'r1', name: 'kutt' },
        origin: 'automatic',
        reviewDirective: undefined,
    };

    console.log('=== LIVE preview-env stage run (real Hetzner VM + Kimi agent) ===');
    const t0 = Date.now();
    const out = await stage.execute(context);
    console.log(`=== done in ${Math.round((Date.now() - t0) / 1000)}s ===`);
    console.log('previewEnvSignal:', JSON.stringify((out as any).previewEnvSignal ?? null)?.slice(0, 400));
    const sugg = (out as any).validSuggestions ?? [];
    console.log(`validSuggestions: ${sugg.length}`);
    for (const s of sugg) {
        console.log(`\n[${s.severity}] ${s.relevantFile} (label=${s.label})`);
        console.log((s.suggestionContent ?? '').slice(0, 500));
    }
}

main().catch((e) => {
    console.error('LIVE RUN ERROR:', e?.stack ?? e);
    process.exit(1);
});
