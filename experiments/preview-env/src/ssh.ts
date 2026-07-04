import { execFileSync, spawn } from 'node:child_process';
import type { PreviewState } from './state.js';

const SSH_OPTS = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-o', 'LogLevel=ERROR',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
];

export interface ExecResult {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    durationMs: number;
}

const MAX_CAPTURE = 400_000; // hard cap on captured bytes per stream

export interface ExecOptions {
    timeoutMs?: number;
    /** Stream output to the local terminal as it arrives. */
    stream?: boolean;
}

/**
 * Runs a shell command on the VM as root over SSH. The command is passed as a
 * single argv entry, so no local-shell quoting issues; remotely it runs under
 * `bash -lc`.
 */
export function sshExec(
    state: PreviewState,
    command: string,
    opts: ExecOptions = {},
): Promise<ExecResult> {
    const { timeoutMs = 300_000, stream = false } = opts;
    const args = [
        '-i', state.sshKeyPath,
        '-p', String(state.sshPort ?? 22),
        ...SSH_OPTS,
        `root@${state.serverIp}`,
        'bash', '-lc', shellQuote(command),
    ];
    const started = Date.now();
    return new Promise((resolve) => {
        const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);
        child.stdout.on('data', (d: Buffer) => {
            if (stream) process.stdout.write(d);
            if (stdout.length < MAX_CAPTURE) stdout += d.toString('utf8');
        });
        child.stderr.on('data', (d: Buffer) => {
            if (stream) process.stderr.write(d);
            if (stderr.length < MAX_CAPTURE) stderr += d.toString('utf8');
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({
                exitCode: code ?? 1,
                stdout,
                stderr,
                timedOut,
                durationMs: Date.now() - started,
            });
        });
    });
}

export function scpUpload(
    state: PreviewState,
    localPath: string,
    remotePath: string,
): void {
    execFileSync(
        'scp',
        ['-i', state.sshKeyPath, '-P', String(state.sshPort ?? 22), ...SSH_OPTS, localPath, `root@${state.serverIp}:${remotePath}`],
        { stdio: ['ignore', 'inherit', 'inherit'] },
    );
}

/** Opens an interactive SSH session (for `preview ssh <name>`). */
export function sshInteractive(state: PreviewState): Promise<number> {
    return new Promise((resolve) => {
        const child = spawn(
            'ssh',
            ['-i', state.sshKeyPath, '-p', String(state.sshPort ?? 22), ...SSH_OPTS, `root@${state.serverIp}`],
            { stdio: 'inherit' },
        );
        child.on('close', (code) => resolve(code ?? 1));
    });
}

/** POSIX single-quote escaping, same approach as e2b-sandbox's shSingleQuote. */
export function shellQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Truncates command output for LLM consumption, keeping head + tail. */
export function truncateForModel(text: string, max = 12_000): string {
    if (text.length <= max) return text;
    const half = Math.floor(max / 2);
    const dropped = text.length - max;
    return `${text.slice(0, half)}\n\n[... ${dropped} chars truncated ...]\n\n${text.slice(-half)}`;
}
