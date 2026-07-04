import { requireEnv, getEnv } from '../config.js';
import type { CreateVmParams, LiveVm, VmInfo, VmProvider } from './types.js';

const DO_API = 'https://api.digitalocean.com/v2';

async function doFetch(
    path: string,
    init: RequestInit = {},
): Promise<any> {
    const token = requireEnv('DIGITALOCEAN_TOKEN');
    const res = await fetch(`${DO_API}${path}`, {
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
            `DigitalOcean API ${init.method ?? 'GET'} ${path} → ${res.status}: ${JSON.stringify(body)}`,
        );
    }
    return body;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class DigitalOceanProvider implements VmProvider {
    readonly kind = 'digitalocean';

    async create(params: CreateVmParams): Promise<VmInfo> {
        assertAsciiUserData(params.userData);

        const key = await doFetch('/account/keys', {
            method: 'POST',
            body: JSON.stringify({
                name: params.name,
                public_key: params.publicKey,
            }),
        });
        const sshKeyId = String(key.ssh_key.id);

        let droplet;
        try {
            droplet = await doFetch('/droplets', {
                method: 'POST',
                body: JSON.stringify({
                    name: params.name,
                    region: params.region ?? getEnv('DO_REGION') ?? 'nyc3',
                    size: params.size ?? getEnv('DO_SIZE') ?? 's-4vcpu-8gb',
                    image: params.image ?? getEnv('DO_IMAGE') ?? 'ubuntu-24-04-x64',
                    ssh_keys: [Number(sshKeyId)],
                    user_data: params.userData,
                    ipv6: false,
                    // No tags: the shared DO token lacks tag:create; the
                    // kodus-selfhosted-preview-* name prefix is the marker.
                }),
            });
        } catch (e) {
            await this.deleteKey(sshKeyId);
            throw e;
        }
        const serverId = String(droplet.droplet.id);

        // Poll until active + public IPv4 assigned (usually <60s).
        const deadline = Date.now() + 5 * 60_000;
        while (Date.now() < deadline) {
            const d = (await doFetch(`/droplets/${serverId}`)).droplet;
            const ip = d.networks?.v4?.find(
                (n: any) => n.type === 'public',
            )?.ip_address;
            if (d.status === 'active' && ip) {
                return { serverId, sshKeyId, ip };
            }
            await sleep(5000);
        }
        // Never leak on failure before we hand back state.
        await this.destroy(serverId, sshKeyId);
        throw new Error(`Droplet ${params.name} did not become active in 5m`);
    }

    async destroy(serverId: string, sshKeyId?: string): Promise<void> {
        try {
            await doFetch(`/droplets/${serverId}`, { method: 'DELETE' });
        } catch (e: any) {
            if (!String(e.message).includes('404')) throw e;
        }
        if (sshKeyId) await this.deleteKey(sshKeyId);
    }

    private async deleteKey(sshKeyId: string): Promise<void> {
        try {
            await doFetch(`/account/keys/${sshKeyId}`, { method: 'DELETE' });
        } catch {
            /* best effort */
        }
    }

    async listByPrefix(prefix: string): Promise<LiveVm[]> {
        const out: LiveVm[] = [];
        let page = 1;
        for (;;) {
            const body = await doFetch(`/droplets?per_page=200&page=${page}`);
            for (const d of body.droplets ?? []) {
                if (!d.name.startsWith(prefix)) continue;
                out.push({
                    id: String(d.id),
                    name: d.name,
                    ip: d.networks?.v4?.find((n: any) => n.type === 'public')
                        ?.ip_address,
                    status: d.status,
                    createdAt: d.created_at,
                });
            }
            if (!body.links?.pages?.next) break;
            page++;
        }
        return out;
    }
}

function assertAsciiUserData(userData: string): void {
    // eslint-disable-next-line no-control-regex
    const bad = userData.match(/[^\x20-\x7e\n\t\r]/);
    if (bad) {
        throw new Error(
            `cloud-init user_data contains non-ASCII byte (${JSON.stringify(bad[0])}). ` +
                `cloud-init silently rejects the whole payload when this happens.`,
        );
    }
}
