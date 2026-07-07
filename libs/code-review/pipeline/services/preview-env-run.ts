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
    /** Unique id for this run — the viewer link key. Set by the stage. */
    runId?: string;
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

/**
 * Render the run as an asciinema v2 `.cast` — a portable terminal recording of
 * the agent's session that plays in any asciinema player (the "video" for a
 * headless bash agent). Times are cumulative seconds; each command is shown at
 * a prompt, then its output, advancing the clock by the command's real
 * duration. Input is the ALREADY-redacted record, so no secrets leak.
 */
export function transcriptToAsciicast(
    record: RuntimeRunRecord,
    startTimestamp = 0,
): string {
    const header = {
        version: 2,
        width: 120,
        height: 30,
        timestamp: startTimestamp,
        title: `Kody Runtime run ${record.runId ?? ''}`.trim(),
    };
    const lines: string[] = [JSON.stringify(header)];
    const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');
    let t = 0;
    const ev = (text: string) => lines.push(JSON.stringify([Number(t.toFixed(3)), 'o', text]));

    for (const turn of record.transcript ?? []) {
        if (turn.reasoning) {
            ev(crlf(`\n[2m# turn ${turn.turn}: ${turn.reasoning.slice(0, 400)}[0m\n`));
            t += 0.6;
        }
        for (const c of turn.commands) {
            ev(`[32m$[0m ${crlf(c.command)}\r\n`);
            t += 0.3;
            const out = ((c.stdout ?? '') + (c.stderr ?? '')).slice(0, 8000);
            if (out) ev(crlf(out.endsWith('\n') ? out : out + '\n'));
            // Advance by the command's real wall time (capped so a 30-min build
            // doesn't make an unwatchable recording).
            t += Math.min(Math.max((c.durationMs ?? 0) / 1000, 0.2), 8);
        }
    }
    return lines.join('\n') + '\n';
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
