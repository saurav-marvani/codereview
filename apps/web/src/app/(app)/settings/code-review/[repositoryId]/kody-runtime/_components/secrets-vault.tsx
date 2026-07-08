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
import { FileTextIcon, ListIcon, PlusIcon, SaveIcon, Trash2Icon } from "lucide-react";

type Row = { name: string; value: string };

/**
 * Parse a pasted .env blob into a { NAME: value } map. Skips blank lines and
 * `#` comments, tolerates a leading `export `, splits on the first `=`, and
 * strips a single layer of surrounding quotes from the value.
 */
function parseDotEnv(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const body = line.replace(/^export\s+/, "");
        const eq = body.indexOf("=");
        if (eq <= 0) continue;
        const name = body.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
        let value = body.slice(eq + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        out[name] = value;
    }
    return out;
}

/**
 * Encrypted secrets vault. Values are write-only: the API never returns them,
 * so we only ever show the NAMES configured. Two ways to add — one at a time,
 * or paste a whole .env. A repo inherits the org's shared secrets (shown with a
 * badge); setting the same name here overrides it. Backend-agnostic: pass
 * `repositoryId="global"` for the org-shared scope.
 */
export const SecretsVault = ({
    teamId,
    repositoryId,
    canEdit,
    requiredEnv = [],
}: {
    teamId: string;
    repositoryId: string;
    canEdit: boolean;
    /** Names the playbook needs — flagged as missing until set/inherited. */
    requiredEnv?: string[];
}) => {
    const isGlobal = repositoryId === "global";
    const [configured, setConfigured] = useState<string[]>([]);
    const [inherited, setInherited] = useState<string[]>([]);
    const [mode, setMode] = useState<"rows" | "paste">("rows");
    const [rows, setRows] = useState<Row[]>([{ name: "", value: "" }]);
    const [pasted, setPasted] = useState("");
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);

    const refresh = async () => {
        setLoading(true);
        const [own, glob] = await Promise.all([
            getEnvironmentSecretsStatus(teamId, repositoryId),
            isGlobal
                ? Promise.resolve(null)
                : getEnvironmentSecretsStatus(teamId, "global"),
        ]);
        setLoading(false);
        const ownNames =
            own && "configured" in own && Array.isArray(own.configured)
                ? own.configured
                : [];
        setConfigured(ownNames);
        const globNames =
            glob && "configured" in glob && Array.isArray(glob.configured)
                ? glob.configured
                : [];
        setInherited(globNames.filter((n) => !ownNames.includes(n)));
    };

    useEffect(() => {
        if (repositoryId) void refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [teamId, repositoryId]);

    const missingRequired = useMemo(
        () =>
            requiredEnv.filter(
                (n) => n && !configured.includes(n) && !inherited.includes(n),
            ),
        [requiredEnv, configured, inherited],
    );

    const persist = async (secrets: Record<string, string>) => {
        setSaving(true);
        const res = await setEnvironmentSecrets(teamId, repositoryId, secrets);
        setSaving(false);
        return res;
    };

    const removeConfigured = async (name: string) => {
        const res = await persist({ [name]: "" });
        if (res && "error" in res) {
            toast({ title: "Error", description: `Could not remove ${name}`, variant: "danger" });
            return;
        }
        toast({ description: `Removed ${name}`, variant: "success" });
        void refresh();
    };

    const applyResult = (res: any, count: number) => {
        if (res && "error" in res) {
            toast({ title: "Error", description: "Could not save. Please try again.", variant: "danger" });
            return false;
        }
        toast({ description: `${count} secret${count === 1 ? "" : "s"} saved (encrypted)`, variant: "success" });
        if (res && "configured" in res && Array.isArray(res.configured)) {
            setConfigured(res.configured);
        } else {
            void refresh();
        }
        return true;
    };

    const saveRows = async () => {
        const secrets: Record<string, string> = {};
        for (const { name, value } of rows) {
            const key = name.trim();
            if (key) secrets[key] = value;
        }
        const count = Object.keys(secrets).length;
        if (count === 0) return;
        if (applyResult(await persist(secrets), count)) {
            setRows([{ name: "", value: "" }]);
        }
    };

    const savePasted = async () => {
        const secrets = parseDotEnv(pasted);
        const count = Object.keys(secrets).length;
        if (count === 0) {
            toast({ title: "Nothing to save", description: "No KEY=value lines found.", variant: "danger" });
            return;
        }
        if (applyResult(await persist(secrets), count)) {
            setPasted("");
            setMode("rows");
        }
    };

    const parsedCount = useMemo(
        () => Object.keys(parseDotEnv(pasted)).length,
        [pasted],
    );

    return (
        <div className="flex flex-col gap-4 rounded-xl border border-card-lv2 p-5">
            <div className="flex flex-col gap-1">
                <Heading variant="h3">
                    {isGlobal ? "Shared secrets" : "Secrets"}
                </Heading>
                <p className="text-text-secondary text-sm">
                    {isGlobal
                        ? "Secrets every repository inherits. A repo can override any of these by setting a secret with the same name. "
                        : "The app's .env, encrypted at rest and injected into the VM at run time. Shared secrets set at the org are inherited (a repo secret with the same name wins). "}
                    Values are encrypted and never shown again after saving.
                </p>
            </div>

            {/* Configured (names only) */}
            <div className="flex flex-col gap-2">
                <span className="text-text-secondary text-xs uppercase">
                    Configured {loading ? "(loading…)" : `(${configured.length})`}
                </span>
                {configured.length === 0 ? (
                    <span className="text-text-secondary text-sm">
                        No secrets set here yet.
                    </span>
                ) : (
                    <div className="flex flex-row flex-wrap gap-2">
                        {configured.map((name) => (
                            <span
                                key={name}
                                className="bg-card-lv2 flex flex-row items-center gap-1 rounded-md px-2 py-1 font-mono text-xs">
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
                {inherited.length > 0 && (
                    <div className="mt-1 flex flex-col gap-1">
                        <span className="text-text-secondary text-xs uppercase">
                            Inherited from org ({inherited.length})
                        </span>
                        <div className="flex flex-row flex-wrap gap-2">
                            {inherited.map((name) => (
                                <span
                                    key={name}
                                    title="Inherited from the org's shared secrets — override by setting the same name here"
                                    className="text-text-secondary bg-card-lv1 flex flex-row items-center gap-1 rounded-md px-2 py-1 font-mono text-xs">
                                    {name}
                                    <span className="text-[10px] uppercase opacity-70">
                                        org
                                    </span>
                                </span>
                            ))}
                        </div>
                    </div>
                )}
                {missingRequired.length > 0 && (
                    <span className="text-danger text-xs">
                        Required by the playbook, not set yet:{" "}
                        {missingRequired.join(", ")}
                    </span>
                )}
            </div>

            {/* Input mode — segmented control */}
            <div className="bg-card-lv2 flex w-fit flex-row gap-1 rounded-lg p-1">
                {(
                    [
                        ["rows", "One at a time", ListIcon],
                        ["paste", "Paste .env", FileTextIcon],
                    ] as const
                ).map(([m, label, Icon]) => (
                    <button
                        key={m}
                        type="button"
                        onClick={() => setMode(m)}
                        className={
                            "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition " +
                            (mode === m
                                ? "bg-card-lv1 text-text-primary"
                                : "text-text-secondary hover:text-text-primary")
                        }>
                        <Icon size={14} />
                        {label}
                    </button>
                ))}
            </div>

            {mode === "paste" ? (
                <div className="flex flex-col gap-3">
                    <textarea
                        disabled={!canEdit || saving}
                        value={pasted}
                        onChange={(ev) => setPasted(ev.target.value)}
                        placeholder={
                            "DATABASE_URL=postgres://user:pass@host/db\nJWT_SECRET=…\nSTRIPE_SECRET_KEY=sk_live_…"
                        }
                        spellCheck={false}
                        rows={7}
                        className="border-card-lv2 bg-card-lv1 text-text-primary focus:border-primary/40 w-full resize-y rounded-lg border p-3 font-mono text-xs outline-none"
                    />
                    <div className="flex flex-row items-center justify-between">
                        <span className="text-text-secondary text-xs">
                            {parsedCount > 0
                                ? `${parsedCount} secret${parsedCount === 1 ? "" : "s"} detected`
                                : "Paste your .env — comments and blank lines are ignored."}
                        </span>
                        <Button
                            size="sm"
                            variant="primary"
                            leftIcon={<SaveIcon />}
                            loading={saving}
                            disabled={!canEdit || saving || parsedCount === 0}
                            onClick={savePasted}>
                            Save {parsedCount > 0 ? parsedCount : ""} secrets
                        </Button>
                    </div>
                </div>
            ) : (
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
                                                    j === i ? { ...r, name: ev.target.value } : r,
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
                                                    j === i ? { ...r, value: ev.target.value } : r,
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
                                        setRows((prev) => prev.filter((_, j) => j !== i))
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
                            onClick={() => setRows((prev) => [...prev, { name: "", value: "" }])}>
                            Add secret
                        </Button>
                        <Button
                            size="sm"
                            variant="primary"
                            leftIcon={<SaveIcon />}
                            loading={saving}
                            disabled={!canEdit || saving || rows.every((r) => !r.name.trim())}
                            onClick={saveRows}>
                            Save secrets
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
};
