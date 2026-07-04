import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Local state for each preview environment, one JSON file per env under
 * ~/.kodus-dev/preview-env/. Provider APIs remain the source of truth for
 * what is actually alive (same philosophy as scripts/selfhosted/reap.sh).
 */
export const STATE_DIR = join(homedir(), '.kodus-dev', 'preview-env');
export const SSH_KEY_DIR = join(STATE_DIR, 'ssh-keys');
export const RUNS_DIR = join(STATE_DIR, 'runs');

/** Prefix shared with scripts/selfhosted so reap.sh TTL-sweeps leaked VMs. */
export const VM_PREFIX = 'kodus-selfhosted-preview-';

/**
 * Global lessons file (Devin-style "Knowledge"): non-obvious, generalizable
 * lessons harvested from previous runs, injected into every agent prompt so
 * the same mistake is not made twice. Agents append via finish.lessons;
 * operators via `preview learn "..."`.
 */
export const LESSONS_PATH = join(STATE_DIR, 'lessons.md');

export interface PreviewState {
    name: string;
    provider: string;
    serverId: string;
    sshKeyId: string;
    serverIp: string;
    /** Port SSH actually answered on (22, or 443 behind restrictive VPNs). */
    sshPort?: number;
    sshKeyPath: string;
    repoUrl?: string;
    repoDir?: string;
    envFileUploaded?: boolean;
    createdAt: string;
}

export function ensureDirs(): void {
    mkdirSync(SSH_KEY_DIR, { recursive: true, mode: 0o700 });
    mkdirSync(RUNS_DIR, { recursive: true });
}

export function normalizeName(raw: string): string {
    const slug = raw
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    if (!slug) throw new Error(`Invalid env name: ${raw}`);
    return slug;
}

function stateFile(name: string): string {
    return join(STATE_DIR, `${name}.json`);
}

export function stateExists(name: string): boolean {
    return existsSync(stateFile(name));
}

export function loadState(name: string): PreviewState {
    if (!stateExists(name)) {
        throw new Error(
            `No state for env '${name}'. Run: preview up --name ${name} ...`,
        );
    }
    return JSON.parse(readFileSync(stateFile(name), 'utf8'));
}

export function saveState(state: PreviewState): void {
    ensureDirs();
    writeFileSync(stateFile(state.name), JSON.stringify(state, null, 2));
}

export function deleteState(name: string): void {
    rmSync(stateFile(name), { force: true });
    rmSync(join(SSH_KEY_DIR, name), { force: true });
    rmSync(join(SSH_KEY_DIR, `${name}.pub`), { force: true });
}

export function listStates(): PreviewState[] {
    if (!existsSync(STATE_DIR)) return [];
    return readdirSync(STATE_DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(join(STATE_DIR, f), 'utf8')));
}
