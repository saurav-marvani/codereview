"use client";

import { useEffect, useRef, useState } from "react";
// js-yaml is pinned to 4.x (the version already in the lockfile) and ships no
// bundled types; @types/js-yaml isn't in the lockfile, so type it locally.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { CheckIcon, FileCode2Icon, TriangleAlertIcon } from "lucide-react";
import { useFormContext } from "react-hook-form";

import type { CodeReviewFormType } from "../../../_types";

// The playbook phases the editor round-trips to/from the form. Everything else
// on the page (enabled/trigger, secrets, infra) stays its own control.
const PHASES = [
    "setup",
    "build",
    "services",
    "test",
    "healthcheck",
    "requiredEnv",
] as const;

const PLACEHOLDER = `setup:
  - npm ci
build:
  - npm run db:migrate
services:
  - npm run start
healthcheck:
  - curl -sf http://localhost:3000/health
requiredEnv:
  - JWT_SECRET`;

/**
 * A single `.kody/runtime.yml` editor for the playbook — the same artifact you'd
 * commit to the repo. It's a view over the form's phase fields: it dumps them to
 * YAML, and parsing what you type writes them back, so the existing save path is
 * unchanged. "Detect from repo" fills the phase fields and the editor re-renders.
 */
export function PlaybookYamlEditor({ disabled }: { disabled?: boolean }) {
    const form = useFormContext<CodeReviewFormType>();

    const readConfig = (): Record<string, string[]> => {
        const cfg: Record<string, string[]> = {};
        for (const p of PHASES) {
            const v = form.getValues(`environment.${p}.value` as any) as
                | string[]
                | undefined;
            if (Array.isArray(v) && v.length) cfg[p] = v;
        }
        return cfg;
    };

    const dump = (cfg: Record<string, string[]>) =>
        Object.keys(cfg).length ? dumpYaml(cfg, { lineWidth: 120 }) : "";

    const [text, setText] = useState<string>(() => dump(readConfig()));
    const [error, setError] = useState<string | null>(null);
    const selfEdit = useRef(false);

    // Rebuild the YAML when the phase fields change from OUTSIDE the editor
    // (e.g. the "Detect from repo" button setValue's them). The selfEdit guard
    // skips the rebuild for the editor's own edits so typing isn't clobbered.
    const watched = form.watch(
        PHASES.map((p) => `environment.${p}.value`) as any,
    );
    useEffect(() => {
        if (selfEdit.current) {
            selfEdit.current = false;
            return;
        }
        setText(dump(readConfig()));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [JSON.stringify(watched)]);

    const onChange = (val: string) => {
        setText(val);
        selfEdit.current = true;

        let parsed: unknown;
        try {
            parsed = val.trim() ? loadYaml(val) : {};
        } catch (e: any) {
            setError(e?.reason || e?.message || "Invalid YAML");
            return;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            setError("The playbook must be a YAML mapping (key: value)");
            return;
        }
        const obj = parsed as Record<string, unknown>;
        for (const p of PHASES) {
            const v = obj[p];
            if (
                v != null &&
                (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
            ) {
                setError(`'${p}' must be a list of command strings`);
                return;
            }
        }
        setError(null);
        for (const p of PHASES) {
            form.setValue(
                `environment.${p}.value` as any,
                (obj[p] as string[]) ?? [],
                { shouldDirty: true },
            );
        }
    };

    return (
        <div className="flex flex-col gap-2">
            <div
                className={
                    "bg-card-lv1 overflow-hidden rounded-lg border " +
                    (error
                        ? "border-danger/50"
                        : "border-card-lv2 focus-within:border-primary/40")
                }>

                <div className="border-card-lv2 flex items-center justify-between border-b px-3 py-2">
                    <span className="text-text-secondary flex items-center gap-2 font-mono text-xs">
                        <FileCode2Icon size={13} />
                        .kody/runtime.yml
                    </span>
                    {error ? (
                        <span className="text-danger flex items-center gap-1 text-xs">
                            <TriangleAlertIcon size={12} /> invalid
                        </span>
                    ) : text.trim() ? (
                        <span className="text-success flex items-center gap-1 text-xs">
                            <CheckIcon size={12} /> valid
                        </span>
                    ) : null}
                </div>
                <textarea
                    value={text}
                    onChange={(ev) => onChange(ev.target.value)}
                    placeholder={PLACEHOLDER}
                    disabled={disabled}
                    spellCheck={false}
                    rows={14}
                    className="text-text-primary w-full resize-y bg-transparent p-4 font-mono text-xs leading-relaxed outline-none"
                />
            </div>
            {error && (
                <span className="text-danger text-xs">⚠ {error}</span>
            )}
        </div>
    );
}
