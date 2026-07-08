"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@components/ui/button";
import { toast } from "@components/ui/toaster/use-toast";
import {
    generateRuntimePlaybook,
    getRuntimePlaybookDraft,
    type GeneratedPlaybook,
} from "@services/parameters/fetch";
import { ScanSearchIcon, CopyIcon } from "lucide-react";
import { useFormContext } from "react-hook-form";

import { type CodeReviewFormType } from "../../../_types";

/**
 * "Generate config" — kicks off the detect agent (which boots a VM and drafts
 * the playbook from the real repo), polls the async job, and lets the user apply
 * the result to the form or copy it as `.kody/runtime.yml`. The user never
 * hand-writes the playbook.
 */
export function GenerateConfigButton({
    teamId,
    repositoryId,
    disabled,
}: {
    teamId: string;
    repositoryId: string;
    disabled?: boolean;
}) {
    const form = useFormContext<CodeReviewFormType>();
    const [running, setRunning] = useState(false);
    const [result, setResult] = useState<GeneratedPlaybook | null>(null);
    const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(
        () => () => {
            if (pollRef.current) clearTimeout(pollRef.current);
        },
        [],
    );

    const poll = useCallback((draftId: string) => {
        const tick = async () => {
            const draft = await getRuntimePlaybookDraft(draftId);
            if ((draft as any)?.error) {
                setRunning(false);
                toast({ variant: "danger", title: "Generation failed", description: "Could not reach the generator." });
                return;
            }
            if (draft.status === "running") {
                pollRef.current = setTimeout(tick, 5000);
                return;
            }
            setRunning(false);
            if (draft.status === "done" && draft.result) {
                setResult(draft.result);
                toast({ title: "Config generated", description: draft.result.summary?.slice(0, 140) });
            } else {
                const msg = draft.result?.error || "The detect agent could not produce a playbook.";
                toast({ variant: "danger", title: "Generation failed", description: msg });
            }
        };
        pollRef.current = setTimeout(tick, 4000);
    }, []);

    const onGenerate = useCallback(async () => {
        setResult(null);
        setRunning(true);
        const res = await generateRuntimePlaybook({ teamId, repositoryId });
        if ((res as any)?.error || !(res as any)?.draftId) {
            setRunning(false);
            toast({ variant: "danger", title: "Could not start generation", description: "Check that the runtime is enabled and a VM token is configured." });
            return;
        }
        poll((res as any).draftId as string);
    }, [teamId, repositoryId, poll]);

    const applyToForm = useCallback(() => {
        const cfg = result?.config;
        if (!cfg) return;
        const set = (key: string, val?: string[]) =>
            form.setValue(`environment.${key}.value` as any, val ?? [], {
                shouldDirty: true,
            });
        set("setup", cfg.setup);
        set("build", cfg.build);
        set("services", cfg.services);
        set("healthcheck", cfg.healthcheck);
        set("test", cfg.test);
        set("requiredEnv", cfg.requiredEnv);
        toast({ title: "Applied", description: "Review the phases below, then Save." });
    }, [result, form]);

    const copyYaml = useCallback(() => {
        if (!result?.playbookYaml) return;
        void navigator.clipboard?.writeText(result.playbookYaml);
        toast({ title: "Copied", description: "Commit it as .kody/runtime.yml" });
    }, [result]);

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    leftIcon={<ScanSearchIcon />}
                    loading={running}
                    onClick={onGenerate}
                    disabled={disabled || running}>
                    {running ? "Detecting…" : "Detect from repo"}
                </Button>
                {result?.playbookYaml && (
                    <Button
                        type="button"
                        variant="tertiary"
                        size="sm"
                        leftIcon={<CopyIcon />}
                        onClick={copyYaml}>
                        Copy as .kody/runtime.yml
                    </Button>
                )}
            </div>

            {result?.config && (
                <div className="border-card-lv2 bg-card-lv2 flex flex-col gap-2 rounded-lg border p-4">
                    <div className="text-text-primary text-sm font-medium">
                        Detected playbook{" "}
                        {result.verified ? (
                            <span className="text-success">
                                &middot; verified it boots
                            </span>
                        ) : (
                            <span className="text-warning">
                                &middot; not fully verified, review before saving
                            </span>
                        )}
                    </div>
                    {result.summary && (
                        <p className="text-text-secondary text-xs">{result.summary}</p>
                    )}
                    {result.requiredEnv?.length > 0 && (
                        <p className="text-text-secondary text-xs">
                            Needs secrets (set their values in the vault below):{" "}
                            <span className="text-text-primary">
                                {result.requiredEnv.join(", ")}
                            </span>
                        </p>
                    )}
                    <pre className="bg-card-lv1 max-h-64 overflow-auto rounded-md p-3 text-xs">
                        {result.playbookYaml}
                    </pre>
                    <div>
                        <Button type="button" size="sm" onClick={applyToForm}>
                            Apply to the form
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
