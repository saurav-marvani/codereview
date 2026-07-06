"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { Heading } from "@components/ui/heading";
import { Input } from "@components/ui/input";
import { toast } from "@components/ui/toaster/use-toast";
import {
    getEnvironmentSecretsStatus,
    setEnvironmentSecrets,
} from "@services/parameters/fetch";
import { PlusIcon, SaveIcon, Trash2Icon } from "lucide-react";
import { useFormContext } from "react-hook-form";

import type { CodeReviewFormType } from "../../../_types";

type Row = { name: string; value: string };

/**
 * Encrypted secrets vault (alpha). Values are write-only: the API never returns
 * them, so we only ever show the NAMES that are configured. Editing a secret
 * means re-entering its value; leaving a configured secret untouched keeps it.
 * Removing a configured secret sends an empty value (the backend deletes it).
 */
export const SecretsVault = ({
    teamId,
    repositoryId,
    canEdit,
}: {
    teamId: string;
    repositoryId: string;
    canEdit: boolean;
}) => {
    const form = useFormContext<CodeReviewFormType>();
    const requiredEnv: string[] =
        (form.watch("environment.requiredEnv.value") as string[]) ?? [];

    const [configured, setConfigured] = useState<string[]>([]);
    const [rows, setRows] = useState<Row[]>([{ name: "", value: "" }]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);

    const refresh = async () => {
        setLoading(true);
        const res = await getEnvironmentSecretsStatus(teamId, repositoryId);
        setLoading(false);
        if (res && "configured" in res && Array.isArray(res.configured)) {
            setConfigured(res.configured);
        }
    };

    useEffect(() => {
        if (repositoryId && repositoryId !== "global") void refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [teamId, repositoryId]);

    const missingRequired = useMemo(
        () => requiredEnv.filter((n) => n && !configured.includes(n)),
        [requiredEnv, configured],
    );

    const removeConfigured = async (name: string) => {
        setSaving(true);
        const res = await setEnvironmentSecrets(teamId, repositoryId, {
            [name]: "",
        });
        setSaving(false);
        if (res && "error" in res) {
            toast({ title: "Error", description: `Could not remove ${name}`, variant: "danger" });
            return;
        }
        toast({ description: `Removed ${name}`, variant: "success" });
        void refresh();
    };

    const save = async () => {
        const secrets: Record<string, string> = {};
        for (const { name, value } of rows) {
            const key = name.trim();
            if (key) secrets[key] = value;
        }
        if (Object.keys(secrets).length === 0) return;

        setSaving(true);
        const res = await setEnvironmentSecrets(teamId, repositoryId, secrets);
        setSaving(false);
        if (res && "error" in res) {
            toast({
                title: "Error",
                description: "Could not save secrets. Please try again.",
                variant: "danger",
            });
            return;
        }
        toast({ description: "Secrets saved (encrypted)", variant: "success" });
        setRows([{ name: "", value: "" }]);
        if (res && "configured" in res && Array.isArray(res.configured)) {
            setConfigured(res.configured);
        } else {
            void refresh();
        }
    };

    return (
        <div className="flex flex-col gap-4 rounded-xl border border-card-lv2 p-5">
            <div className="flex flex-col gap-1">
                <Heading variant="h3">Secrets vault</Heading>
                <p className="text-text-secondary text-sm">
                    The app&apos;s <code>.env</code>, encrypted at rest and
                    injected into the VM at run time. Values are never displayed
                    again after saving.
                </p>
            </div>

            {/* Configured (names only) */}
            <div className="flex flex-col gap-2">
                <span className="text-text-secondary text-xs uppercase">
                    Configured {loading ? "(loading…)" : `(${configured.length})`}
                </span>
                {configured.length === 0 ? (
                    <span className="text-text-secondary text-sm">
                        No secrets configured yet.
                    </span>
                ) : (
                    <div className="flex flex-row flex-wrap gap-2">
                        {configured.map((name) => (
                            <span
                                key={name}
                                className="flex flex-row items-center gap-1 rounded-md bg-card-lv2 px-2 py-1 font-mono text-xs">
                                {name}
                                {canEdit && (
                                    <button
                                        type="button"
                                        aria-label={`Remove ${name}`}
                                        disabled={saving}
                                        onClick={() => removeConfigured(name)}
                                        className="text-text-secondary hover:text-danger">
                                        <Trash2Icon size={12} />
                                    </button>
                                )}
                            </span>
                        ))}
                    </div>
                )}
                {missingRequired.length > 0 && (
                    <span className="text-danger text-xs">
                        Missing required: {missingRequired.join(", ")}
                    </span>
                )}
            </div>

            {/* Editor rows */}
            <div className="flex flex-col gap-3">
                {rows.map((row, i) => (
                    <div key={i} className="flex flex-row items-end gap-2">
                        <FormControl.Root className="flex-1">
                            <FormControl.Label htmlFor={`secret-name-${i}`}>
                                Name
                            </FormControl.Label>
                            <FormControl.Input>
                                <Input
                                    id={`secret-name-${i}`}
                                    disabled={!canEdit || saving}
                                    value={row.name}
                                    placeholder="DATABASE_URL"
                                    className="font-mono text-xs"
                                    onChange={(ev) =>
                                        setRows((prev) =>
                                            prev.map((r, j) =>
                                                j === i
                                                    ? { ...r, name: ev.target.value }
                                                    : r,
                                            ),
                                        )
                                    }
                                />
                            </FormControl.Input>
                        </FormControl.Root>
                        <FormControl.Root className="flex-1">
                            <FormControl.Label htmlFor={`secret-value-${i}`}>
                                Value
                            </FormControl.Label>
                            <FormControl.Input>
                                <Input
                                    id={`secret-value-${i}`}
                                    type="password"
                                    disabled={!canEdit || saving}
                                    value={row.value}
                                    placeholder="••••••••"
                                    className="font-mono text-xs"
                                    onChange={(ev) =>
                                        setRows((prev) =>
                                            prev.map((r, j) =>
                                                j === i
                                                    ? { ...r, value: ev.target.value }
                                                    : r,
                                            ),
                                        )
                                    }
                                />
                            </FormControl.Input>
                        </FormControl.Root>
                        {rows.length > 1 && (
                            <Button
                                size="icon-md"
                                variant="cancel"
                                disabled={!canEdit || saving}
                                onClick={() =>
                                    setRows((prev) =>
                                        prev.filter((_, j) => j !== i),
                                    )
                                }>
                                <Trash2Icon size={16} />
                            </Button>
                        )}
                    </div>
                ))}

                <div className="flex flex-row items-center justify-between">
                    <Button
                        size="sm"
                        variant="secondary"
                        leftIcon={<PlusIcon />}
                        disabled={!canEdit || saving}
                        onClick={() =>
                            setRows((prev) => [...prev, { name: "", value: "" }])
                        }>
                        Add secret
                    </Button>
                    <Button
                        size="sm"
                        variant="primary"
                        leftIcon={<SaveIcon />}
                        loading={saving}
                        disabled={
                            !canEdit ||
                            saving ||
                            rows.every((r) => !r.name.trim())
                        }
                        onClick={save}>
                        Save secrets
                    </Button>
                </div>
            </div>
        </div>
    );
};
