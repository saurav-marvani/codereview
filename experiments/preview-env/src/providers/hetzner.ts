import { getEnv } from '../config.js';
import type { CreateVmParams, LiveVm, VmInfo, VmProvider } from './types.js';

const HCLOUD_API = 'https://api.hetzner.cloud/v1';

function hcloudToken(): string {
    // HCLOUD_TOKEN is the canonical name; HETZNER_DEV is the alias used in
    // this operator's ~/.kodus-dev/config.
    const t = getEnv('HCLOUD_TOKEN') ?? getEnv('HETZNER_DEV');
    if (!t) throw new Error('Required env HCLOUD_TOKEN (or HETZNER_DEV) is not set');
    return t;
}

async function hcloudFetch(path: string, init: RequestInit = {}): Promise<any> {
    const token = hcloudToken();
    const res = await fetch(`${HCLOUD_API}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(init.headers ?? {}),
        },
    });
    if (res.status === 204) return null;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(
            `Hetzner API ${init.method ?? 'GET'} ${path} → ${res.status}: ${JSON.stringify(body)}`,
        );
    }
    return body;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HetznerProvider implements VmProvider {
    readonly kind = 'hetzner';

    async create(params: CreateVmParams): Promise<VmInfo> {
        const key = await hcloudFetch('/ssh_keys', {
            method: 'POST',
            body: JSON.stringify({
                name: params.name,
                public_key: params.publicKey,
            }),
        });
        const sshKeyId = String(key.ssh_key.id);

        let server;
        try {
            server = await hcloudFetch('/servers', {
                method: 'POST',
                body: JSON.stringify({
                    name: params.name,
                    location: params.region ?? getEnv('HCLOUD_LOCATION') ?? 'nbg1',
                    server_type: params.size ?? getEnv('HCLOUD_SERVER_TYPE') ?? 'cpx31',
                    image: params.image ?? getEnv('HCLOUD_IMAGE') ?? 'ubuntu-24.04',
                    ssh_keys: [Number(sshKeyId)],
                    user_data: params.userData,
                    start_after_create: true,
                }),
            });
        } catch (e) {
            await this.deleteKey(sshKeyId);
            throw e;
        }
        const serverId = String(server.server.id);

        const deadline = Date.now() + 5 * 60_000;
        while (Date.now() < deadline) {
            const s = (await hcloudFetch(`/servers/${serverId}`)).server;
            const ip = s.public_net?.ipv4?.ip;
            if (s.status === 'running' && ip) {
                return { serverId, sshKeyId, ip };
            }
            await sleep(5000);
        }
        await this.destroy(serverId, sshKeyId);
        throw new Error(`Server ${params.name} did not become running in 5m`);
    }

    async createSnapshot(serverId: string, description: string): Promise<string> {
        const res = await hcloudFetch(`/servers/${serverId}/actions/create_image`, {
            method: 'POST',
            body: JSON.stringify({ type: 'snapshot', description }),
        });
        const imageId = String(res.image.id);
        const actionId = res.action.id;
        // Poll the create_image action until the snapshot is fully written.
        const deadline = Date.now() + 15 * 60_000;
        while (Date.now() < deadline) {
            const a = (await hcloudFetch(`/actions/${actionId}`)).action;
            if (a.status === 'success') return imageId;
            if (a.status === 'error') {
                throw new Error(`snapshot failed: ${JSON.stringify(a.error)}`);
            }
            await sleep(5000);
        }
        throw new Error(`snapshot ${imageId} did not finish in 15m`);
    }

    async destroy(serverId: string, sshKeyId?: string): Promise<void> {
        try {
            await hcloudFetch(`/servers/${serverId}`, { method: 'DELETE' });
        } catch (e: any) {
            if (!String(e.message).includes('404')) throw e;
        }
        if (sshKeyId) await this.deleteKey(sshKeyId);
    }

    private async deleteKey(sshKeyId: string): Promise<void> {
        try {
            await hcloudFetch(`/ssh_keys/${sshKeyId}`, { method: 'DELETE' });
        } catch {
            /* best effort */
        }
    }

    async listByPrefix(prefix: string): Promise<LiveVm[]> {
        const out: LiveVm[] = [];
        let page = 1;
        for (;;) {
            const body = await hcloudFetch(`/servers?per_page=50&page=${page}`);
            for (const s of body.servers ?? []) {
                if (!s.name.startsWith(prefix)) continue;
                out.push({
                    id: String(s.id),
                    name: s.name,
                    ip: s.public_net?.ipv4?.ip,
                    status: s.status,
                    createdAt: s.created,
                });
            }
            if (!body.meta?.pagination?.next_page) break;
            page++;
        }
        return out;
    }
}
