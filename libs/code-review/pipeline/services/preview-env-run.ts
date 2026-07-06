import { RuntimeTurn } from '@libs/sandbox/infrastructure/services/preview-env-agent.service';

/**
 * The durable, user-facing record of ONE Kody Runtime run — everything the
 * model did + the environment output, so the PR reviewer can see 100% of what
 * happened in the VM. Assembled by the stage, redacted, and persisted; the web
 * viewer renders it (transcript replay + phase logs + findings). Secret VALUES
 * are scrubbed everywhere before this leaves the stage.
 */
export interface RuntimeRunPhase {
    phase: string;
    command: string;
    exitCode: number;
    outputTail: string;
}

export interface RuntimeRunRecord {
    ran: boolean;
    ok: boolean;
    scope: string;
    /** Playbook phases (setup/build/services/test/healthcheck) + their output. */
    phases: RuntimeRunPhase[];
    /** Long-running service stdout/stderr collected before teardown. */
    serviceLog?: string;
    /** The agent's turn-by-turn session: reasoning + every command + output. */
    transcript: RuntimeTurn[];
    /** The agent's closing summary (what it exercised and concluded). */
    summary: string;
    findingsCount: number;
    turns: number;
    model?: string;
    startedAt?: string;
    finishedAt?: string;
}

/**
 * Replace every injected secret VALUE with `‹redacted:NAME›` across any string.
 * The secrets are injected into the VM (env, .env, command output), so they
 * WILL appear in the transcript/logs — scrub before persisting. Longest values
 * first so a value that contains another doesn't leave a tail. Empty/very short
 * values (<4 chars) are skipped to avoid mangling unrelated text.
 */
export function redactSecrets(
    text: string,
    secrets: Record<string, string>,
): string {
    if (!text) return text;
    const entries = Object.entries(secrets)
        .filter(([, v]) => typeof v === 'string' && v.length >= 4)
        .sort((a, b) => b[1].length - a[1].length);
    let out = text;
    for (const [name, value] of entries) {
        out = out.split(value).join(`‹redacted:${name}›`);
    }
    return out;
}

/** Deep-redact a transcript (commands + reasoning + output). */
export function redactTranscript(
    transcript: RuntimeTurn[],
    secrets: Record<string, string>,
): RuntimeTurn[] {
    return transcript.map((t) => ({
        turn: t.turn,
        reasoning: redactSecrets(t.reasoning, secrets),
        commands: t.commands.map((c) => ({
            command: redactSecrets(c.command, secrets),
            exitCode: c.exitCode,
            stdout: redactSecrets(c.stdout, secrets),
            stderr: redactSecrets(c.stderr, secrets),
            durationMs: c.durationMs,
        })),
    }));
}

/** Deep-redact phase logs. */
export function redactPhases(
    phases: RuntimeRunPhase[],
    secrets: Record<string, string>,
): RuntimeRunPhase[] {
    return phases.map((p) => ({
        phase: p.phase,
        command: redactSecrets(p.command, secrets),
        exitCode: p.exitCode,
        outputTail: redactSecrets(p.outputTail, secrets),
    }));
}
