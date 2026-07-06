import { execFile } from 'child_process';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Minimal ephemeral-VM client for the preview-env sandbox provider — provision
 * a cloud VM, wait for SSH, exec over SSH, snapshot, destroy. Cloud-agnostic
 * via a small provider seam (Hetzner implemented; DigitalOcean/AWS/GCP plug in
 * the same way). Ported from the standalone preview-env experiment
 * (experiments/preview-env); kept dependency-free (fetch + ssh CLI) so it needs
 * no new packages. Self-hosted customers point it at their own cloud token.
 */
export interface VmHandle {
    serverId: string;
    ip: string;
    sshPort: number;
    keyPath: string;
    keyDir: string;
}

export interface VmProvisionParams {
    name: string;
    region?: string;
    size?: string;
    /** Golden-snapshot image id to warm-boot from; falsy → base image. */
    image?: string;
    /** cloud-init payload (base toolchain). Ignored on warm-boot from image. */
    userData: string;
}

export interface VmRunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}

const HCLOUD_API = 'https://api.hetzner.cloud/v1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class VmClient {
    constructor(
        private readonly token: string,
        private readonly opts: { region?: string; size?: string } = {},
    ) {}

    private async api(path: string, init: RequestInit = {}): Promise<any> {
        const res = await fetch(`${HCLOUD_API}${path}`, {
            ...init,
            headers: {
                Authorization: `Bearer ${this.token}`,
                'Content-Type': 'application/json',
                ...(init.headers ?? {}),
            },
        });
        if (res.status === 204) return null;
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(
                `Hetzner ${init.method ?? 'GET'} ${path} → ${res.status}: ${JSON.stringify(body)}`,
            );
        }
        return body;
    }

    async provision(params: VmProvisionParams): Promise<VmHandle> {
        // Unique per provision so a leaked SSH key / server from a previous
        // run (e.g. one killed before cleanup) never blocks a retry with a
        // 409 "not unique". Keeps the `kodus-selfhosted-preview-` prefix the
        // reaper keys off. Cloud-provider names cap ~64 chars; base36 ts fits.
        const uniqueName = `${params.name}-${Date.now().toString(36)}`;
        const keyDir = await mkdtemp(join(tmpdir(), 'kody-vm-'));
        const keyPath = join(keyDir, 'id_ed25519');
        await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', uniqueName]);
        const publicKey = (await readFile(`${keyPath}.pub`, 'utf8')).trim();

        const key = await this.api('/ssh_keys', {
            method: 'POST',
            body: JSON.stringify({ name: uniqueName, public_key: publicKey }),
        });
        const sshKeyId = Number(key.ssh_key.id);

        let server: any;
        try {
            server = await this.api('/servers', {
                method: 'POST',
                body: JSON.stringify({
                    name: uniqueName,
                    location: params.region ?? this.opts.region ?? 'hil',
                    server_type: params.size ?? this.opts.size ?? 'cpx31',
                    image: params.image ?? 'ubuntu-24.04',
                    ssh_keys: [sshKeyId],
                    user_data: params.image ? undefined : params.userData,
                    start_after_create: true,
                }),
            });
        } catch (e) {
            await this.api(`/ssh_keys/${sshKeyId}`, { method: 'DELETE' }).catch(() => {});
            await rm(keyDir, { recursive: true, force: true }).catch(() => {});
            throw e;
        }
        const serverId = String(server.server.id);

        // Wait for running + public IP.
        let ip = '';
        const deadline = Date.now() + 5 * 60_000;
        while (Date.now() < deadline) {
            const s = (await this.api(`/servers/${serverId}`)).server;
            ip = s.public_net?.ipv4?.ip;
            if (s.status === 'running' && ip) break;
            await sleep(5000);
        }
        if (!ip) {
            await this.destroy(serverId).catch(() => {});
            throw new Error(`VM ${params.name} did not become running in 5m`);
        }

        // Wait for SSH (ports 22 then 443 — restrictive networks block 22).
        const handle: VmHandle = { serverId, ip, sshPort: 22, keyPath, keyDir };
        const sshDeadline = Date.now() + 7 * 60_000;
        while (Date.now() < sshDeadline) {
            for (const port of [22, 443]) {
                const r = await this.exec({ ...handle, sshPort: port }, 'true', 15_000).catch(() => null);
                if (r && r.exitCode === 0) {
                    handle.sshPort = port;
                    return handle;
                }
            }
            await sleep(5000);
        }
        await this.destroy(serverId).catch(() => {});
        throw new Error(`SSH did not come up on ${params.name} (tried 22 and 443)`);
    }

    async exec(handle: VmHandle, command: string, timeoutMs = 600_000): Promise<VmRunResult> {
        const args = [
            '-i', handle.keyPath,
            '-p', String(handle.sshPort),
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'LogLevel=ERROR',
            '-o', `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
            `root@${handle.ip}`,
            command,
        ];
        try {
            const { stdout, stderr } = await execFileAsync('ssh', args, {
                timeout: timeoutMs,
                maxBuffer: 10 * 1024 * 1024,
            });
            return { stdout: stdout || '', stderr: stderr || '', exitCode: 0 };
        } catch (error: any) {
            return {
                stdout: error.stdout || '',
                stderr: error.stderr || '',
                exitCode: typeof error.code === 'number' ? error.code : 1,
            };
        }
    }

    async writeFile(handle: VmHandle, remotePath: string, content: string): Promise<void> {
        const tmp = join(handle.keyDir, `w-${Date.now()}`);
        await writeFile(tmp, content, 'utf8');
        await chmod(tmp, 0o600);
        await execFileAsync('scp', [
            '-i', handle.keyPath,
            '-P', String(handle.sshPort),
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'LogLevel=ERROR',
            tmp,
            `root@${handle.ip}:${remotePath}`,
        ]);
        await rm(tmp, { force: true }).catch(() => {});
    }

    async destroy(serverId: string, keyDir?: string): Promise<void> {
        await this.api(`/servers/${serverId}`, { method: 'DELETE' }).catch((e) => {
            if (!String(e.message).includes('404')) throw e;
        });
        if (keyDir) await rm(keyDir, { recursive: true, force: true }).catch(() => {});
    }

    /**
     * Snapshot a running server into a reusable golden image (Devin-style warm
     * boot). Polls the create_image action until the image is fully written.
     * Returns the image id to pass back as `image` on a later provision().
     */
    async createSnapshot(serverId: string, description: string): Promise<string> {
        const res = await this.api(`/servers/${serverId}/actions/create_image`, {
            method: 'POST',
            body: JSON.stringify({ type: 'snapshot', description }),
        });
        const imageId = String(res.image.id);
        const actionId = res.action.id;
        const deadline = Date.now() + 15 * 60_000;
        while (Date.now() < deadline) {
            const a = (await this.api(`/actions/${actionId}`)).action;
            if (a.status === 'success') return imageId;
            if (a.status === 'error') {
                throw new Error(`snapshot failed: ${JSON.stringify(a.error)}`);
            }
            await new Promise((r) => setTimeout(r, 5000));
        }
        throw new Error(`snapshot ${imageId} did not finish in 15m`);
    }

    /** Delete a golden image (GC of a superseded snapshot). Best-effort. */
    async deleteImage(imageId: string): Promise<void> {
        await this.api(`/images/${imageId}`, { method: 'DELETE' }).catch(() => undefined);
    }
}
