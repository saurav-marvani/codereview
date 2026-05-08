"use client";

import { useMemo, useCallback, useState } from "react";
import { Button } from "@components/ui/button";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from "@components/ui/tabs";
import { LockIcon, RotateCcwIcon, SaveIcon } from "lucide-react";
import { cn } from "src/core/utils/components";

import {
    useRoutingRules,
    useUpsertRoutingRules,
    useResetRoutingRules,
} from "@services/notifications/hooks";
import type {
    RoutingRule,
    UpsertRoutingRulePayload,
} from "@services/notifications/types";

// Catalog metadata mirrored from the backend for display
const EVENT_CATALOG: Array<{
    event: string;
    label: string;
    category: string;
    criticality: "critical" | "transactional" | "informational";
}> = [
    {
        event: "auth.email_confirmation",
        label: "Email Confirmation",
        category: "Auth",
        criticality: "transactional",
    },
    {
        event: "auth.forgot_password",
        label: "Forgot Password",
        category: "Auth",
        criticality: "transactional",
    },
    {
        event: "team.member_invited",
        label: "Team Invite",
        category: "Team",
        criticality: "transactional",
    },
    {
        event: "kody_rules.generated",
        label: "Kody Rules Generated",
        category: "Kody Rules",
        criticality: "informational",
    },
    {
        event: "sso.domain_verification",
        label: "SSO Domain Verification",
        category: "SSO",
        criticality: "transactional",
    },
    {
        event: "cockpit.weekly_recap",
        label: "Weekly Recap",
        category: "Cockpit",
        criticality: "informational",
    },
];

const CHANNELS = ["email", "in_app"] as const;
const CHANNEL_LABELS: Record<string, string> = {
    email: "Email",
    in_app: "In-App",
};

const ROLES = [
    { value: "*", label: "All Roles" },
    { value: "owner", label: "Owner" },
    { value: "billing_manager", label: "Billing Manager" },
    { value: "repo_admin", label: "Repo Admin" },
    { value: "contributor", label: "Contributor" },
];

const CRITICALITY_BADGE: Record<string, { label: string; className: string }> =
    {
        critical: {
            label: "Critical",
            className: "bg-red-500/15 text-red-400 border-red-500/30",
        },
        transactional: {
            label: "Transactional",
            className: "bg-amber-500/15 text-amber-400 border-amber-500/30",
        },
        informational: {
            label: "Informational",
            className: "bg-blue-500/15 text-blue-400 border-blue-500/30",
        },
    };

export default function NotificationsConfigPage() {
    const { data: rules, isLoading } = useRoutingRules();
    const upsertMutation = useUpsertRoutingRules();
    const resetMutation = useResetRoutingRules();
    const [selectedRole, setSelectedRole] = useState("*");
    const [localEdits, setLocalEdits] = useState<
        Map<string, Record<string, boolean>>
    >(new Map());
    const [hasChanges, setHasChanges] = useState(false);

    // Build a lookup: event → channels for the selected role
    const ruleMap = useMemo(() => {
        const map = new Map<string, Record<string, boolean>>();
        if (!rules) return map;

        for (const rule of rules) {
            if (rule.role === selectedRole || rule.role === "*") {
                // Prefer exact role match over wildcard
                const existing = map.get(rule.event);
                if (!existing || rule.role === selectedRole) {
                    map.set(rule.event, { ...rule.channels });
                }
            }
        }

        return map;
    }, [rules, selectedRole]);

    // Merge server state with local edits
    const getChannelState = useCallback(
        (event: string, channel: string): boolean => {
            const local = localEdits.get(event);
            if (local && channel in local) return local[channel];

            const serverRule = ruleMap.get(event);
            return serverRule?.[channel] ?? false;
        },
        [localEdits, ruleMap],
    );

    const toggleChannel = useCallback(
        (event: string, channel: string, criticality: string) => {
            // Critical events cannot be disabled
            if (criticality === "critical") return;

            setLocalEdits((prev) => {
                const next = new Map(prev);
                const current = next.get(event) ?? {};
                const currentValue = getChannelState(event, channel);
                next.set(event, { ...current, [channel]: !currentValue });
                return next;
            });
            setHasChanges(true);
        },
        [getChannelState],
    );

    const handleSave = useCallback(async () => {
        const payload: UpsertRoutingRulePayload[] = [];

        for (const [event, channels] of localEdits.entries()) {
            const serverChannels = ruleMap.get(event) ?? {};
            payload.push({
                event,
                role: selectedRole,
                channels: { ...serverChannels, ...channels },
            });
        }

        if (payload.length > 0) {
            await upsertMutation.mutateAsync(payload);
            setLocalEdits(new Map());
            setHasChanges(false);
        }
    }, [localEdits, ruleMap, selectedRole, upsertMutation]);

    const handleReset = useCallback(async () => {
        await resetMutation.mutateAsync();
        setLocalEdits(new Map());
        setHasChanges(false);
    }, [resetMutation]);

    // Group events by category
    const groupedEvents = useMemo(() => {
        const groups = new Map<
            string,
            typeof EVENT_CATALOG
        >();
        for (const ev of EVENT_CATALOG) {
            const list = groups.get(ev.category) ?? [];
            list.push(ev);
            groups.set(ev.category, list);
        }
        return groups;
    }, []);

    if (isLoading) {
        return (
            <Page.Root>
                <Page.Content>
                    <div className="flex items-center justify-center py-20">
                        <Spinner className="size-8" />
                    </div>
                </Page.Content>
            </Page.Root>
        );
    }

    return (
        <Page.Root>
            <Page.Header>
                <div className="flex w-full items-center justify-between">
                    <div>
                        <h1 className="text-lg font-semibold text-white">
                            Notification Settings
                        </h1>
                        <p className="text-text-tertiary mt-1 text-sm">
                            Configure which notification channels are active
                            for each event and role.
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            size="sm"
                            variant="secondary"
                            leftIcon={<RotateCcwIcon className="size-4" />}
                            onClick={handleReset}
                            disabled={resetMutation.isPending}>
                            Reset to defaults
                        </Button>
                        {hasChanges && (
                            <Button
                                size="sm"
                                variant="primary"
                                leftIcon={<SaveIcon className="size-4" />}
                                onClick={handleSave}
                                disabled={upsertMutation.isPending}>
                                Save changes
                            </Button>
                        )}
                    </div>
                </div>
            </Page.Header>

            <Page.Content>
                <Tabs
                    value={selectedRole}
                    onValueChange={(v) => {
                        setSelectedRole(v);
                        setLocalEdits(new Map());
                        setHasChanges(false);
                    }}>
                    <TabsList>
                        {ROLES.map((role) => (
                            <TabsTrigger key={role.value} value={role.value}>
                                {role.label}
                            </TabsTrigger>
                        ))}
                    </TabsList>

                    {ROLES.map((role) => (
                        <TabsContent key={role.value} value={role.value}>
                            <div className="mt-4 space-y-6">
                                {[...groupedEvents.entries()].map(
                                    ([category, events]) => (
                                        <div key={category}>
                                            <h3 className="text-text-secondary mb-3 text-xs font-semibold uppercase tracking-wider">
                                                {category}
                                            </h3>

                                            <div className="bg-card-lv2 border-primary-dark divide-primary-dark divide-y rounded-xl border">
                                                {/* Header row */}
                                                <div className="grid grid-cols-[1fr_repeat(2,100px)] items-center gap-4 px-4 py-3">
                                                    <span className="text-text-tertiary text-xs font-medium">
                                                        Event
                                                    </span>
                                                    {CHANNELS.map((ch) => (
                                                        <span
                                                            key={ch}
                                                            className="text-text-tertiary text-center text-xs font-medium">
                                                            {CHANNEL_LABELS[
                                                                ch
                                                            ]}
                                                        </span>
                                                    ))}
                                                </div>

                                                {/* Event rows */}
                                                {events.map((ev) => {
                                                    const badge =
                                                        CRITICALITY_BADGE[
                                                            ev.criticality
                                                        ];
                                                    const isCritical =
                                                        ev.criticality ===
                                                        "critical";

                                                    return (
                                                        <div
                                                            key={ev.event}
                                                            className="grid grid-cols-[1fr_repeat(2,100px)] items-center gap-4 px-4 py-3">
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-sm text-white">
                                                                    {ev.label}
                                                                </span>
                                                                <span
                                                                    className={cn(
                                                                        "rounded-full border px-2 py-0.5 text-[10px] font-medium",
                                                                        badge.className,
                                                                    )}>
                                                                    {
                                                                        badge.label
                                                                    }
                                                                </span>
                                                            </div>

                                                            {CHANNELS.map(
                                                                (ch) => {
                                                                    const enabled =
                                                                        getChannelState(
                                                                            ev.event,
                                                                            ch,
                                                                        );

                                                                    return (
                                                                        <div
                                                                            key={
                                                                                ch
                                                                            }
                                                                            className="flex justify-center">
                                                                            {isCritical ? (
                                                                                <div className="flex items-center gap-1 text-xs text-white/50">
                                                                                    <LockIcon className="size-3" />
                                                                                    <span>
                                                                                        On
                                                                                    </span>
                                                                                </div>
                                                                            ) : (
                                                                                <button
                                                                                    type="button"
                                                                                    role="switch"
                                                                                    aria-checked={
                                                                                        enabled
                                                                                    }
                                                                                    onClick={() =>
                                                                                        toggleChannel(
                                                                                            ev.event,
                                                                                            ch,
                                                                                            ev.criticality,
                                                                                        )
                                                                                    }
                                                                                    className={cn(
                                                                                        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors",
                                                                                        enabled
                                                                                            ? "bg-primary-light"
                                                                                            : "bg-[#3a3a4f]",
                                                                                    )}>
                                                                                    <span
                                                                                        className={cn(
                                                                                            "pointer-events-none block size-4 rounded-full bg-white shadow transition-transform",
                                                                                            enabled
                                                                                                ? "translate-x-4"
                                                                                                : "translate-x-0",
                                                                                        )}
                                                                                    />
                                                                                </button>
                                                                            )}
                                                                        </div>
                                                                    );
                                                                },
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    ),
                                )}
                            </div>
                        </TabsContent>
                    ))}
                </Tabs>
            </Page.Content>
        </Page.Root>
    );
}
