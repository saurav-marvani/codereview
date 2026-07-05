/**
 * PORT-READY REFERENCE for Phase 3 PR2 (see PHASE3-PLAN.md).
 *
 * This is the preview-env VM behind Kodus's EXISTING `ISandboxProvider` seam
 * (libs/sandbox/domain/contracts/sandbox.provider.ts). It typechecks
 * standalone here against local copies of the Kodus contract shapes; to ship,
 * move it to `libs/sandbox/infrastructure/providers/vm-sandbox.service.ts`,
 * swap these local interfaces for the real imports, add `@Injectable()` + the
 * NestJS DI, register it in `sandbox.module.ts`, and widen
 * `SandboxInstance.type` to include `'vm'`.
 *
 * The point: the VM plugs into the same interface e2b/local already implement,
 * so the lease manager, reaper, RemoteCommands and the `createSandbox`
 * pipeline stage all work unchanged.
 */
import { getProvider } from './providers/index.js';
import { runPlaybook, parsePlaybook, type Playbook } from './playbook.js';
import { scpUpload, shellQuote, sshExec } from './ssh.js';
import { normalizeName, VM_PREFIX, type PreviewState } from './state.js';

// ---- Local copies of the Kodus sandbox contract (replace with real imports) --
export interface CreateSandboxParams {
    cloneUrl: string;
    authToken?: string;
    authUsername?: string;
    branch?: string;
    platform: string;
    prNumber?: number;
    baseBranch?: string;
    checkoutSha?: string;
    unifiedDiff?: string;
    sandboxMetadata?: Record<string, unknown>;
}

export interface SandboxInstance {
    type: 'e2b' | 'local' | 'null' | 'vm'; // <- widen the real union to add 'vm'
    sandboxId: string;
    repoDir: string;
    baseBranch?: string;
    run(cmd: string, opts?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    cleanup(): Promise<void>;
}

export interface ISandboxProvider {
    isAvailable(): boolean;
    createSandboxWithRepo(params: CreateSandboxParams): Promise<SandboxInstance>;
}
// -----------------------------------------------------------------------------

export interface VmSandboxOptions {
    providerKind?: string; // 'hetzner' | 'digitalocean'
    region?: string;
    size?: string;
    /** Golden snapshot image id to warm-boot from (Phase 2). */
    snapshotImage?: string;
    hasVmToken: boolean; // injected from config (HCLOUD_TOKEN / DO token present)
}

export class VmSandboxProvider implements ISandboxProvider {
    constructor(private readonly opts: VmSandboxOptions) {}

    isAvailable(): boolean {
        // Same gating style as E2BSandboxService (token-present + explicit select).
        return this.opts.hasVmToken;
    }

    async createSandboxWithRepo(params: CreateSandboxParams): Promise<SandboxInstance> {
        const provider = getProvider(this.opts.providerKind ?? 'hetzner');
        const name = normalizeName(`pr-${params.prNumber ?? Date.now()}`);
        // NOTE: reuse the CLI's cloud-init + key handling when porting; elided
        // here — this reference focuses on the interface mapping.
        const vm = await provider.create({
            name: `${VM_PREFIX}${name}`,
            publicKey: '<injected>',
            userData: '<cloud-init>',
            region: this.opts.region,
            size: this.opts.size,
            image: this.opts.snapshotImage, // warm-boot from the repo's snapshot
        });
        const state: PreviewState = {
            name,
            provider: provider.kind,
            serverId: vm.serverId,
            sshKeyId: vm.sshKeyId,
            serverIp: vm.ip,
            sshKeyPath: '<injected>',
            repoUrl: params.cloneUrl,
            repoDir: '/opt/repo',
            createdAt: new Date().toISOString(),
        };

        // Warm path: repo baked into snapshot → fetch the PR ref; else clone.
        const ref = params.checkoutSha ?? params.branch ?? 'HEAD';
        if (this.opts.snapshotImage) {
            await sshExec(state, `cd /opt/repo && git fetch --depth 1 origin ${shellQuote(ref)} && git checkout -f FETCH_HEAD`, { timeoutMs: 120_000 });
        } else {
            await sshExec(state, `git clone ${shellQuote(params.cloneUrl)} /opt/repo`, { timeoutMs: 600_000 });
        }

        return {
            type: 'vm',
            sandboxId: state.serverId,
            repoDir: state.repoDir!,
            baseBranch: params.baseBranch,
            run: async (cmd, o) => {
                const r = await sshExec(state, cmd, { timeoutMs: o?.timeoutMs ?? 600_000 });
                return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
            },
            readFile: async (p) => (await sshExec(state, `cat ${shellQuote(p)}`, { timeoutMs: 30_000 })).stdout,
            writeFile: async (p, content) => {
                const tmp = `/tmp/kody-write-${Date.now()}`;
                const { writeFileSync, rmSync } = await import('node:fs');
                writeFileSync(tmp, content);
                scpUpload(state, tmp, p);
                rmSync(tmp);
            },
            cleanup: async () => provider.destroy(state.serverId, state.sshKeyId),
        };
    }

    /**
     * The extra the VM sandbox adds over e2b: run the detected playbook to
     * actually boot the app (services up, healthcheck green), so the reviewer
     * gets an EXECUTED environment, not just a checkout. Called by the
     * run-preview-env pipeline stage (PR3).
     */
    async bootPlaybook(sandbox: SandboxInstance, playbookYaml: string): Promise<boolean> {
        const playbook: Playbook = parsePlaybook(playbookYaml);
        // Reuse runPlaybook via a thin state shim built from the sandbox.
        const state = { name: sandbox.sandboxId, serverId: sandbox.sandboxId, repoDir: sandbox.repoDir } as PreviewState;
        const { ok } = await runPlaybook(state, playbook, ['setup', 'build', 'services', 'test'], 1_800_000);
        return ok;
    }
}
