import { createLogger } from '@libs/core/log/logger';
import { PlatformType } from '@libs/core/domain/enums';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
    CreateSandboxParams,
    ISandboxProvider,
    SandboxInstance,
    SandboxRunResult,
} from '@libs/sandbox/domain/contracts/sandbox.provider';
import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { VmClient, VmHandle } from './vm-client';

/**
 * Ephemeral cloud-VM sandbox provider. Unlike E2B (managed micro-VMs) and
 * Local (host tempdir, read-only tools), this boots a real, isolated VM in the
 * customer's own cloud, clones the PR, and — crucially — can RUN the app (via
 * the repo's committed `environment:` playbook) so the reviewer gets an
 * EXECUTED environment, not just a checkout. Self-hosted customers keep the VM
 * inside their own cloud account (their code never leaves their tenancy).
 *
 * Implements the same ISandboxProvider seam as the other providers, so the
 * lease manager, reaper, RemoteCommands and the createSandbox pipeline stage
 * all work unchanged. Selected via `SANDBOX_PROVIDER=vm`.
 */
const CLOUD_INIT = `#cloud-config
package_update: true
packages: [git, jq, curl, ca-certificates, ripgrep]
runcmd:
  - printf 'Port 22\\nPort 443\\n' > /etc/ssh/sshd_config.d/60-kody-ports.conf
  - systemctl disable --now ssh.socket || true
  - systemctl enable ssh
  - systemctl restart ssh
  - curl -fsSL https://get.docker.com | sh
  - mkdir -p /opt/kody
`;

const REPO_DIR = '/opt/repo';

/**
 * Browser toolchain for the bug-finding agent's frontend testing: Node +
 * Playwright + headless Chromium, installed under /opt/kody so the agent's
 * scripts (written there) can `require('playwright')`. Idempotent (marker
 * file), and fired in the BACKGROUND right after provisioning so it installs
 * in parallel with the clone + playbook boot — by the time the agent wants a
 * browser it's normally ready. On snapshot warm-boots the marker is pre-baked
 * and the script exits immediately.
 */
const BROWSER_SETUP_SCRIPT = `#!/bin/bash
set -e
[ -f /opt/kody/pw-ready ] && exit 0
command -v node >/dev/null 2>&1 || {
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
}
cd /opt/kody
[ -f package.json ] || npm init -y >/dev/null
npm i playwright@1
npx playwright install --with-deps chromium
touch /opt/kody/pw-ready
`;

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

@Injectable()
export class VmSandboxService implements ISandboxProvider {
    private readonly logger = createLogger(VmSandboxService.name);

    constructor(private readonly configService: ConfigService) {}

    private token(): string | undefined {
        return (
            this.configService.get<string>('PREVIEW_VM_TOKEN') ||
            this.configService.get<string>('HCLOUD_TOKEN')
        );
    }

    isAvailable(): boolean {
        return !!this.token();
    }

    async createSandboxWithRepo(
        params: CreateSandboxParams,
        // Org-level infra override (self-hosted "bring your own cloud" from the
        // settings UI). Absent → the server-level env token/region/size.
        infra?: { token: string; region?: string; serverType?: string },
    ): Promise<SandboxInstance> {
        const token = infra?.token ?? this.token();
        if (!token) throw new Error('VmSandboxService: no VM token configured');

        const client = new VmClient(token, {
            region:
                infra?.region ??
                this.configService.get<string>('PREVIEW_VM_REGION'),
            size:
                infra?.serverType ??
                this.configService.get<string>('PREVIEW_VM_SIZE'),
        });

        const snapshotImage = params.sandboxMetadata?.snapshotImage;
        const name = `kodus-selfhosted-preview-pr-${params.prNumber ?? Date.now()}`;
        const handle = await client.provision({
            name,
            userData: CLOUD_INIT,
            image: snapshotImage,
        });

        try {
            // Wait for cloud-init (docker/node/ripgrep + /opt/kody) to finish
            // before using the VM — otherwise the toolchain and the secrets dir
            // aren't ready. Skipped on snapshot warm-boot (image is pre-baked).
            if (!snapshotImage) {
                await client.exec(handle, 'cloud-init status --wait 2>/dev/null || true', 600_000);
            }
            await client.exec(handle, 'mkdir -p /opt/kody', 30_000);

            // Kick off the browser toolchain install in the background (see
            // BROWSER_SETUP_SCRIPT). Fire-and-forget on purpose: it runs in
            // parallel with the clone + playbook boot, and the agent is told to
            // wait on /opt/kody/pw-ready before its first browser script. The
            // spurious rc of a backgrounded ssh command is ignored (same
            // pattern as the playbook's services phase).
            await client.writeFile(
                handle,
                '/opt/kody/pw-setup.sh',
                BROWSER_SETUP_SCRIPT,
            );
            await client
                .exec(
                    handle,
                    'setsid bash /opt/kody/pw-setup.sh >/opt/kody/pw-install.log 2>&1 < /dev/null & echo browser-setup-started',
                    30_000,
                )
                .catch(() => undefined);

            await this.cloneRepo(client, handle, params, !!snapshotImage);

            const remoteCommands = this.buildRemoteCommands(client, handle);
            const run = async (
                command: string,
                opts?: { timeoutMs?: number },
            ): Promise<SandboxRunResult> =>
                client.exec(handle, `cd ${REPO_DIR} && ${command}`, opts?.timeoutMs);

            const readFile = async (path: string): Promise<string> => {
                const p = path.startsWith('/') ? path : `${REPO_DIR}/${path}`;
                return (await client.exec(handle, `cat ${shellQuote(p)}`, 30_000)).stdout;
            };
            const writeFile = async (path: string, content: string): Promise<void> => {
                const p = path.startsWith('/') ? path : `${REPO_DIR}/${path}`;
                await client.writeFile(handle, p, content);
            };

            return {
                remoteCommands,
                cleanup: async () => {
                    await client.destroy(handle.serverId, handle.keyDir).catch((error) =>
                        this.logger.warn({
                            message: `Failed to destroy VM ${handle.serverId}`,
                            context: VmSandboxService.name,
                            error,
                        }),
                    );
                },
                type: 'vm',
                sandboxId: handle.serverId,
                baseBranch: params.baseBranch,
                repoDir: REPO_DIR,
                run,
                readFile,
                writeFile,
                snapshot: (description: string) =>
                    client.createSnapshot(handle.serverId, description),
                deleteImage: (imageId: string) => client.deleteImage(imageId),
            };
        } catch (error) {
            await client.destroy(handle.serverId, handle.keyDir).catch(() => {});
            throw error;
        }
    }

    /**
     * Build a golden snapshot for warm boot: cold-provision from the BASE
     * branch, install + build (setup/build phases only — no services, no PR
     * delta), then snapshot the disk and tear the build VM down. Returns the
     * image id + region to record in the snapshot registry. A later PR provision
     * passes this image back as `sandboxMetadata.snapshotImage` and skips
     * cloud-init + full clone + install + build.
     */
    async buildSnapshot(
        params: {
            cloneUrl: string;
            authToken?: string;
            authUsername?: string;
            baseBranch: string;
            platform: PlatformType;
            setup: string[];
            build: string[];
            secrets?: Record<string, string>;
            name?: string;
        },
        infra?: { token: string; region?: string; serverType?: string },
    ): Promise<{ imageId: string; region?: string }> {
        const token = infra?.token ?? this.token();
        if (!token) throw new Error('VmSandboxService: no VM token configured');
        const region = infra?.region ?? this.configService.get<string>('PREVIEW_VM_REGION');

        const vm = await this.createSandboxWithRepo(
            {
                cloneUrl: params.cloneUrl,
                authToken: params.authToken,
                authUsername: params.authUsername,
                branch: params.baseBranch,
                baseBranch: params.baseBranch,
                platform: params.platform,
            },
            infra,
        );
        try {
            if (params.secrets && Object.keys(params.secrets).length) {
                const envFile = Object.entries(params.secrets)
                    .map(([k, v]) => `${k}=${v}`)
                    .join('\n');
                await vm.writeFile('/opt/kody/customer.env', envFile);
            }
            for (const command of [...params.setup, ...params.build]) {
                if (!command) continue;
                const r = await vm.run(command, { timeoutMs: 30 * 60_000 });
                if (r.exitCode !== 0) {
                    throw new Error(
                        `snapshot build failed at "${command}" (exit ${r.exitCode}): ${(r.stderr || r.stdout).slice(-500)}`,
                    );
                }
            }
            // A stateless REST call — reuse the server id, no ssh handle needed.
            const client = new VmClient(token, { region });
            const imageId = await client.createSnapshot(
                vm.sandboxId,
                params.name ?? `kody-runtime-snapshot-${Date.now()}`,
            );
            return { imageId, region };
        } finally {
            await vm.cleanup().catch(() => undefined);
        }
    }

    /** GC a superseded snapshot image (best-effort). */
    async deleteSnapshot(imageId: string, infra?: { token: string }): Promise<void> {
        const token = infra?.token ?? this.token();
        if (!token) return;
        await new VmClient(token).deleteImage(imageId).catch(() => undefined);
    }

    private async cloneRepo(
        client: VmClient,
        handle: VmHandle,
        params: CreateSandboxParams,
        warm: boolean,
    ): Promise<void> {
        const { cloneUrl, authToken, authUsername, branch, platform, prNumber, checkoutSha } = params;
        const authedUrl = this.buildAuthedUrl(cloneUrl, platform, authToken, authUsername);
        const refspec =
            checkoutSha ??
            (prNumber != null ? this.prRefspec(platform, prNumber, branch) : `refs/heads/${branch}`);

        if (warm) {
            // Repo baked into the snapshot — fetch the PR ref (Devin startup delta).
            const r = await client.exec(
                handle,
                `cd ${REPO_DIR} && git remote set-url origin ${shellQuote(authedUrl)} && git fetch --depth 1 origin ${shellQuote(refspec)} && git checkout -f FETCH_HEAD`,
                180_000,
            );
            if (r.exitCode !== 0) throw new Error(`warm fetch failed: ${r.stderr.slice(0, 300)}`);
        } else {
            const r = await client.exec(
                handle,
                `git init ${REPO_DIR} && cd ${REPO_DIR} && git config core.hooksPath /dev/null && git fetch --depth 1 ${shellQuote(authedUrl)} ${shellQuote(refspec)}:pr-head && git checkout pr-head && git remote add origin ${shellQuote(cloneUrl)} 2>/dev/null || true`,
                600_000,
            );
            if (r.exitCode !== 0) throw new Error(`clone failed: ${r.stderr.slice(0, 300)}`);
        }
    }

    private buildRemoteCommands(client: VmClient, handle: VmHandle): RemoteCommands {
        const run = (cmd: string) => client.exec(handle, `cd ${REPO_DIR} && ${cmd}`, 30_000);
        return {
            grep: async (pattern: string, path: string, glob?: string): Promise<string> => {
                const g = glob ? ` --glob ${shellQuote(glob)}` : '';
                const r = await run(`rg --no-heading -n --no-follow ${shellQuote(pattern)} ${shellQuote(path)}${g}`);
                return r.exitCode === 0 || r.exitCode === 1 ? r.stdout : '';
            },
            read: async (path: string, start: number, end: number): Promise<string> => {
                if (start === 0 && end === 0) return (await run(`cat ${shellQuote(path)}`)).stdout;
                return (await run(`sed -n ${shellQuote(`${start < 1 ? 1 : start},${end}p`)} ${shellQuote(path)}`)).stdout;
            },
            listDir: async (path: string, maxDepth: number): Promise<string> =>
                (await run(`find ${shellQuote(path)} -maxdepth ${maxDepth} -type f -not -type l`)).stdout,
            exec: async (command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> =>
                // The VM is real-isolated (unlike LocalSandbox), so exec runs the
                // command directly instead of a read-only whitelist.
                run(command),
        };
    }

    private buildAuthedUrl(
        cloneUrl: string,
        platform: PlatformType,
        token?: string,
        username?: string,
    ): string {
        if (!token) return cloneUrl;
        const url = new URL(cloneUrl);
        if (platform === PlatformType.GITLAB || platform === PlatformType.AZURE_REPOS) {
            url.username = 'oauth2';
            url.password = token;
        } else if (platform === PlatformType.BITBUCKET) {
            url.username = token.startsWith('ATATT') ? 'x-bitbucket-api-token-auth' : (username ?? '');
            url.password = token;
        } else {
            url.username = 'x-access-token';
            url.password = token;
        }
        return url.toString();
    }

    private prRefspec(platform: PlatformType, prNumber: number, branch: string): string {
        switch (platform) {
            case PlatformType.GITLAB:
                return `refs/merge-requests/${prNumber}/head`;
            case PlatformType.BITBUCKET:
                return `refs/heads/${branch}`;
            case PlatformType.AZURE_REPOS:
                return `refs/pull/${prNumber}/merge`;
            default:
                return `refs/pull/${prNumber}/head`;
        }
    }
}
