import yaml from 'js-yaml';
import { sshExec, truncateForModel } from './ssh.js';
import type { PreviewState } from './state.js';

/**
 * The playbook is the durable output of environment detection: a
 * `.kody/environment.yml` in the customer repo (Devin-style knowledge file).
 * If it exists, `preview run` executes it deterministically — no agent, no
 * tokens. If not, `preview detect` has the agent figure the repo out and
 * write one.
 */
export interface Playbook {
    version: 1;
    /** Free-text summary of what the project is and how the env works. */
    summary?: string;
    /** Env var names the environment needs (values come from the customer's
     * uploaded env file, never stored in the playbook). */
    requiredEnv?: string[];
    /** Phases, each a list of shell commands run at the repo root. */
    setup?: string[];
    services?: string[];
    build?: string[];
    test?: string[];
    /** Optional health check run after `services`/`build`. */
    healthcheck?: string[];
}

export const PLAYBOOK_REMOTE_PATH = '.kody/environment.yml';
// Execution order: backing services declared as docker commands usually live
// in setup; process-type services (the app itself) must start after build.
export const PHASES = ['setup', 'build', 'services', 'test'] as const;
export type Phase = (typeof PHASES)[number];

export function parsePlaybook(raw: string): Playbook {
    const doc = yaml.load(raw) as any;
    if (!doc || typeof doc !== 'object') {
        throw new Error('Playbook YAML is empty or not a mapping');
    }
    for (const phase of [...PHASES, 'healthcheck']) {
        if (doc[phase] !== undefined && !Array.isArray(doc[phase])) {
            throw new Error(`Playbook '${phase}' must be a list of commands`);
        }
    }
    return doc as Playbook;
}

export function dumpPlaybook(playbook: Playbook): string {
    return yaml.dump(playbook, { lineWidth: 120 });
}

/**
 * Command prelude: every playbook/agent command runs at the repo root with
 * the customer env file sourced (if uploaded).
 */
export function wrapCommand(state: PreviewState, command: string): string {
    const repoDir = state.repoDir ?? '/opt/repo';
    return [
        'set -a',
        '[ -f /opt/kody/customer.env ] && . /opt/kody/customer.env',
        'set +a',
        `cd ${repoDir}`,
        command,
    ].join('\n');
}

export async function readRemotePlaybook(
    state: PreviewState,
): Promise<Playbook | null> {
    const repoDir = state.repoDir ?? '/opt/repo';
    const res = await sshExec(
        state,
        `cat ${repoDir}/${PLAYBOOK_REMOTE_PATH} 2>/dev/null`,
        { timeoutMs: 30_000 },
    );
    if (res.exitCode !== 0 || !res.stdout.trim()) return null;
    return parsePlaybook(res.stdout);
}

/**
 * Agents emit entries in a few shapes: plain command strings,
 * {description, command} objects, and long-running services as
 * {name, type: 'process', command} (backgrounded) or {name, image, ...}
 * (declarative docker specs, not executable — skipped).
 */
function normalizeEntry(entry: unknown, phase: string): string | null {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') {
        const o = entry as Record<string, unknown>;
        if (typeof o.command === 'string') {
            if (phase === 'services') {
                const name = typeof o.name === 'string' ? o.name : 'service';
                return `nohup ${o.command} > /tmp/kody-svc-${name}.log 2>&1 & sleep 4`;
            }
            return o.command;
        }
    }
    return null;
}

export interface PhaseResult {
    phase: string;
    command: string;
    exitCode: number;
    durationMs: number;
    outputTail: string;
}

/**
 * Runs playbook phases in order, streaming output. Stops at the first
 * failing command. Returns per-command results for reporting.
 */
export async function runPlaybook(
    state: PreviewState,
    playbook: Playbook,
    phases: readonly string[],
    timeoutMs: number,
): Promise<{ ok: boolean; results: PhaseResult[] }> {
    const results: PhaseResult[] = [];
    for (const phase of phases) {
        const commands = (playbook as any)[phase] as string[] | undefined;
        if (!commands?.length) continue;
        console.log(`\n=== phase: ${phase} (${commands.length} command(s)) ===`);
        for (const entry of commands) {
            const command = normalizeEntry(entry, phase);
            if (!command) {
                console.log(`(skipping non-command entry: ${JSON.stringify(entry)})`);
                continue;
            }
            console.log(`\n$ ${command}`);
            const res = await sshExec(state, wrapCommand(state, command), {
                timeoutMs,
                stream: true,
            });
            results.push({
                phase,
                command,
                exitCode: res.exitCode,
                durationMs: res.durationMs,
                outputTail: truncateForModel(res.stdout + res.stderr, 2000),
            });
            if (res.exitCode !== 0) {
                console.error(
                    `\nphase '${phase}' failed (exit ${res.exitCode}${res.timedOut ? ', timed out' : ''}): ${command}`,
                );
                return { ok: false, results };
            }
        }
    }
    return { ok: true, results };
}
