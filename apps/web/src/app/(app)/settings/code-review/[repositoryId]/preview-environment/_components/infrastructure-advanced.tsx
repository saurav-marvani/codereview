"use client";

import { useEffect, useState } from "react";
import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { Heading } from "@components/ui/heading";
import { Input } from "@components/ui/input";
import { toast } from "@components/ui/toaster/use-toast";
import {
    getEnvironmentInfraStatus,
    setEnvironmentInfra,
} from "@services/parameters/fetch";
import { SaveIcon } from "lucide-react";

/**
 * Advanced / self-hosted: WHERE the preview VMs are provisioned (org-level).
 * Bring-your-own-cloud — the customer's PR code boots inside THEIR cloud
 * account. The API token is write-only (encrypted at rest, never returned);
 * we only display whether one is configured. Left empty, the platform
 * default (server-level token) applies — how the managed cloud alpha runs.
 */
export const InfrastructureAdvanced = ({
    teamId,
    canEdit,
}: {
    teamId: string;
    canEdit: boolean;
}) => {
    const [tokenConfigured, setTokenConfigured] = useState(false);
    const [token, setToken] = useState("");
    const [region, setRegion] = useState("");
    const [serverType, setServerType] = useState("");
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            setLoading(true);
            const res = await getEnvironmentInfraStatus(teamId);
            if (cancelled) return;
            setLoading(false);
            if (res && "tokenConfigured" in res) {
                setTokenConfigured(res.tokenConfigured);
                setRegion(res.region ?? "");
                setServerType(res.serverType ?? "");
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [teamId]);

    const save = async (removeToken = false) => {
        setSaving(true);
        const res = await setEnvironmentInfra(teamId, {
            provider: "hetzner",
            // '' removes, omitted keeps — mirror the API contract.
            token: removeToken ? "" : token.trim() || undefined,
            region: region.trim() || undefined,
            serverType: serverType.trim() || undefined,
        });
        setSaving(false);
        if (res && "error" in res) {
            toast({
                title: "Error",
                description: "Could not save the infrastructure config.",
                variant: "danger",
            });
            return;
        }
        toast({ description: "Infrastructure saved", variant: "success" });
        setToken("");
        if (res && "tokenConfigured" in res) {
            setTokenConfigured(res.tokenConfigured);
        }
    };

    return (
        <div className="flex flex-col gap-4 rounded-xl border border-card-lv2 p-5">
            <div className="flex flex-col gap-1">
                <Heading variant="h3">Infrastructure (advanced)</Heading>
                <p className="text-text-secondary text-sm">
                    Where the preview VMs run. Bring your own cloud so the code
                    never leaves your account — required for self-hosted. Leave
                    empty to use the platform default.
                </p>
            </div>

            <div className="flex flex-row flex-wrap items-end gap-3">
                <FormControl.Root>
                    <FormControl.Label htmlFor="infra-provider">
                        Provider
                    </FormControl.Label>
                    <FormControl.Input>
                        <Input
                            id="infra-provider"
                            value="Hetzner Cloud"
                            disabled
                            className="text-xs"
                        />
                    </FormControl.Input>
                </FormControl.Root>

                <FormControl.Root className="flex-1">
                    <FormControl.Label htmlFor="infra-token">
                        API token{" "}
                        {tokenConfigured && (
                            <span className="text-success">(configured)</span>
                        )}
                    </FormControl.Label>
                    <FormControl.Input>
                        <Input
                            id="infra-token"
                            type="password"
                            disabled={!canEdit || saving || loading}
                            value={token}
                            placeholder={
                                tokenConfigured
                                    ? "•••••••• (leave empty to keep)"
                                    : "Cloud API token"
                            }
                            className="font-mono text-xs"
                            onChange={(ev) => setToken(ev.target.value)}
                        />
                    </FormControl.Input>
                </FormControl.Root>

                <FormControl.Root>
                    <FormControl.Label htmlFor="infra-region">
                        Region
                    </FormControl.Label>
                    <FormControl.Input>
                        <Input
                            id="infra-region"
                            disabled={!canEdit || saving || loading}
                            value={region}
                            placeholder="hil"
                            className="font-mono text-xs"
                            onChange={(ev) => setRegion(ev.target.value)}
                        />
                    </FormControl.Input>
                </FormControl.Root>

                <FormControl.Root>
                    <FormControl.Label htmlFor="infra-server-type">
                        Server type
                    </FormControl.Label>
                    <FormControl.Input>
                        <Input
                            id="infra-server-type"
                            disabled={!canEdit || saving || loading}
                            value={serverType}
                            placeholder="cpx31"
                            className="font-mono text-xs"
                            onChange={(ev) => setServerType(ev.target.value)}
                        />
                    </FormControl.Input>
                </FormControl.Root>
            </div>

            <div className="flex flex-row items-center justify-end gap-2">
                {tokenConfigured && (
                    <Button
                        size="sm"
                        variant="cancel"
                        disabled={!canEdit || saving}
                        onClick={() => save(true)}>
                        Remove token
                    </Button>
                )}
                <Button
                    size="sm"
                    variant="primary"
                    leftIcon={<SaveIcon />}
                    loading={saving}
                    disabled={!canEdit || saving || loading}
                    onClick={() => save(false)}>
                    Save infrastructure
                </Button>
            </div>
        </div>
    );
};
