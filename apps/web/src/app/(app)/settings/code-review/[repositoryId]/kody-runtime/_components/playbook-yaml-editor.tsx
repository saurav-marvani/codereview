"use client";

import { useEffect, useRef, useState } from "react";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { useFormContext } from "react-hook-form";
import { CodeInputSimple } from "@components/ui/code-input-simple";

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
            <CodeInputSimple
                value={text}
                onChangeAction={onChange}
                language="yaml"
                placeholder={PLACEHOLDER}
                disabled={disabled}
                className="min-h-64"
            />
            {error && <span className="text-danger text-xs">{error}</span>}
        </div>
    );
}
