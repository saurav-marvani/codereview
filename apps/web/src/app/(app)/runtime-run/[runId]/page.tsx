"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Heading } from "@components/ui/heading";
import { Page } from "@components/ui/page";
import { getRuntimeRun, type RuntimeRunRecord } from "@services/parameters/fetch";
import { PARAMETERS_PATHS } from "@services/parameters";

const PHASE_ORDER = ["setup", "build", "services", "test", "healthcheck"];

function StatusPill({ ok }: { ok: boolean }) {
    return (
        <span
            className={`rounded-md px-2 py-0.5 text-xs font-medium ${
                ok
                    ? "bg-success/15 text-success"
                    : "bg-danger/15 text-danger"
            }`}>
            {ok ? "environment ok" : "environment failed"}
        </span>
    );
}

/**
 * The Kody Runtime run viewer — opened from the PR (the "▶ View the full run"
 * link on each finding). Shows 100% of what the model did in the VM: the
 * playbook phases + output, the agent's turn-by-turn session (reasoning + every
 * command + its output), and the service log. Secret values were scrubbed
 * server-side before the record was persisted.
 */
export default function RuntimeRunViewer() {
    const params = useParams<{ runId: string }>();
    const runId = params?.runId;
    const [run, setRun] = useState<RuntimeRunRecord | null>(null);
    const [state, setState] = useState<"loading" | "ready" | "error">("loading");

    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!runId) return;
            const res = await getRuntimeRun(runId);
            if (cancelled) return;
            if (res && "error" in res) {
                setState("error");
                return;
            }
            setRun(res as RuntimeRunRecord);
            setState((res as RuntimeRunRecord)?.ran ? "ready" : "error");
        })();
        return () => {
            cancelled = true;
        };
    }, [runId]);

    if (state === "loading") {
        return (
            <Page.Root>
                <Page.Content>
                    <p className="text-text-secondary text-sm">Loading run…</p>
                </Page.Content>
            </Page.Root>
        );
    }
    if (state === "error" || !run) {
        return (
            <Page.Root>
                <Page.Content>
                    <p className="text-text-secondary text-sm">
                        This runtime run couldn&apos;t be found (it may have
                        expired or you don&apos;t have access).
                    </p>
                </Page.Content>
            </Page.Root>
        );
    }

    const phases = [...(run.phases ?? [])].sort(
        (a, b) => PHASE_ORDER.indexOf(a.phase) - PHASE_ORDER.indexOf(b.phase),
    );

    return (
        <Page.Root>
            <Page.Header>
                <Page.Title>Kody Runtime run</Page.Title>
            </Page.Header>
            <Page.Content>
                {/* Header */}
                <div className="flex flex-col gap-2 rounded-xl border border-card-lv2 p-5">
                    <div className="flex flex-row flex-wrap items-center gap-3">
                        <StatusPill ok={run.ok} />
                        <span className="text-text-secondary text-xs">
                            {run.findingsCount} finding(s) · {run.turns} agent
                            turn(s) · scope {run.scope}
                            {run.model ? ` · ${run.model}` : ""}
                        </span>
                    </div>
                    {(run.startedAt || run.finishedAt) && (
                        <span className="text-text-secondary text-xs">
                            {run.startedAt} → {run.finishedAt}
                        </span>
                    )}
                    {run.summary && (
                        <p className="text-text-primary mt-1 text-sm whitespace-pre-wrap">
                            {run.summary}
                        </p>
                    )}
                </div>

                {/* Playbook phases */}
                <div className="flex flex-col gap-3 rounded-xl border border-card-lv2 p-5">
                    <Heading variant="h3">Playbook</Heading>
                    {phases.length === 0 ? (
                        <span className="text-text-secondary text-sm">
                            No playbook phases recorded.
                        </span>
                    ) : (
                        phases.map((p, i) => (
                            <details key={i} className="rounded-md bg-card-lv2 p-3">
                                <summary className="cursor-pointer text-sm">
                                    <span
                                        className={
                                            p.exitCode === 0
                                                ? "text-success"
                                                : "text-danger"
                                        }>
                                        {p.exitCode === 0 ? "✓" : "✕"}
                                    </span>{" "}
                                    <b>{p.phase}</b>{" "}
                                    <code className="text-text-secondary text-xs">
                                        {p.command}
                                    </code>
                                </summary>
                                <pre className="mt-2 overflow-x-auto text-xs whitespace-pre-wrap text-text-secondary">
                                    {p.outputTail || "(no output)"}
                                </pre>
                            </details>
                        ))
                    )}
                </div>

                {/* Agent transcript — the "see 100%" replay */}
                <div className="flex flex-col gap-3 rounded-xl border border-card-lv2 p-5">
                    <div className="flex flex-row items-center justify-between">
                        <Heading variant="h3">
                            Agent session ({run.transcript?.length ?? 0} turns)
                        </Heading>
                        {runId && (
                            <a
                                href={`${PARAMETERS_PATHS.GET_RUNTIME_RUN}/${encodeURIComponent(runId)}/cast`}
                                className="text-primary text-xs underline"
                                target="_blank"
                                rel="noreferrer">
                                ▶ Download recording (.cast)
                            </a>
                        )}
                    </div>
                    {(run.transcript ?? []).map((t) => (
                        <div key={t.turn} className="flex flex-col gap-2 border-t border-card-lv2 pt-3 first:border-0 first:pt-0">
                            <span className="text-text-secondary text-xs uppercase">
                                Turn {t.turn}
                            </span>
                            {t.reasoning && (
                                <p className="text-text-primary text-sm whitespace-pre-wrap">
                                    {t.reasoning}
                                </p>
                            )}
                            {t.commands.map((c, i) => (
                                <div key={i} className="rounded-md bg-card-lv2 p-3">
                                    <div className="flex flex-row items-center gap-2">
                                        <span
                                            className={
                                                c.exitCode === 0
                                                    ? "text-success"
                                                    : "text-danger"
                                            }>
                                            $
                                        </span>
                                        <code className="overflow-x-auto text-xs">
                                            {c.command}
                                        </code>
                                        <span className="text-text-secondary ml-auto text-[10px]">
                                            exit {c.exitCode} · {c.durationMs}ms
                                        </span>
                                    </div>
                                    {(c.stdout || c.stderr) && (
                                        <pre className="mt-2 max-h-80 overflow-auto text-xs whitespace-pre-wrap text-text-secondary">
                                            {c.stdout}
                                            {c.stderr}
                                        </pre>
                                    )}
                                </div>
                            ))}
                        </div>
                    ))}
                </div>

                {/* Service log */}
                {run.serviceLog && (
                    <div className="flex flex-col gap-2 rounded-xl border border-card-lv2 p-5">
                        <Heading variant="h3">Service log</Heading>
                        <pre className="max-h-96 overflow-auto text-xs whitespace-pre-wrap text-text-secondary">
                            {run.serviceLog}
                        </pre>
                    </div>
                )}
            </Page.Content>
        </Page.Root>
    );
}
