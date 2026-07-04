/**
 * Cloud-agnostic VM provider contract. Mirrors the provider seam in
 * scripts/selfhosted/provision.sh (digitalocean|hetzner case statement),
 * but in TS so the agent orchestrator can drive it. Self-hosted customers
 * plug their cloud in by implementing this interface.
 */
export interface CreateVmParams {
    /** Full resource name, already prefixed (kodus-selfhosted-preview-*). */
    name: string;
    publicKey: string;
    /** cloud-init #cloud-config payload. ASCII only — cloud-init silently
     * drops the whole payload on non-ASCII bytes (hard-won lesson from
     * provision.sh). */
    userData: string;
    region?: string;
    size?: string;
    image?: string;
}

export interface VmInfo {
    serverId: string;
    sshKeyId: string;
    ip: string;
}

export interface LiveVm {
    id: string;
    name: string;
    ip?: string;
    status: string;
    createdAt: string;
}

export interface VmProvider {
    readonly kind: string;
    create(params: CreateVmParams): Promise<VmInfo>;
    destroy(serverId: string, sshKeyId?: string): Promise<void>;
    /** Lists live VMs whose name starts with the given prefix. */
    listByPrefix(prefix: string): Promise<LiveVm[]>;
}
