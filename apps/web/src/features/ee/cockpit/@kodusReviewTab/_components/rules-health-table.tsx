"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@components/ui/table";
import { cn } from "src/core/utils/components";

import { CockpitNoDataPlaceholder } from "../../_components/no-data-placeholder";
import type {
    KodyRuleHealthRow,
    KodyRuleHealthState,
} from "../../_services/analytics/review/fetch";
import { ImplRateBar } from "./impl-rate-bar";

const PREVIEW_ROWS = 6;

const stateMeta: Record<
    KodyRuleHealthState,
    { label: string; className: string }
> = {
    healthy: { label: "Healthy", className: "bg-success/15 text-success" },
    noisy: { label: "Noisy", className: "bg-danger/15 text-danger" },
    ignored: { label: "Ignored", className: "bg-warning/15 text-warning" },
    stale: {
        label: "Stale",
        className: "bg-card-lv3 text-text-tertiary",
    },
    low_data: {
        label: "Low data",
        className: "bg-info/15 text-info",
    },
};

const FILTERS: Array<{ value: KodyRuleHealthState | "all"; label: string }> = [
    { value: "all", label: "All" },
    { value: "healthy", label: "Healthy" },
    { value: "noisy", label: "Noisy" },
    { value: "ignored", label: "Ignored" },
    { value: "stale", label: "Stale" },
];

export const RulesHealthTable = ({ data }: { data: KodyRuleHealthRow[] }) => {
    const router = useRouter();
    const [filter, setFilter] = useState<KodyRuleHealthState | "all">("all");
    const [showAll, setShowAll] = useState(false);

    if (!data.length) {
        return (
            <div className="text-text-tertiary flex h-32 items-center justify-center text-sm">
                No Kody Rules triggered in this period.
            </div>
        );
    }

    const filtered = data.filter(
        (row) => filter === "all" || row.state === filter,
    );
    const visible = showAll ? filtered : filtered.slice(0, PREVIEW_ROWS);

    return (
        <div>
            <div className="mb-3 flex gap-2">
                {FILTERS.map((option) => (
                    <button
                        key={option.value}
                        type="button"
                        onClick={() => setFilter(option.value)}
                        className={cn(
                            "rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                            filter === option.value
                                ? "border-primary-light text-primary-light bg-primary-light/10"
                                : "border-card-lv3 bg-card-lv2 text-text-secondary",
                        )}>
                        {option.label}
                    </button>
                ))}
            </div>

            <Table>
                <TableHeader>
                    <TableRow className="*:text-text-tertiary *:text-[11px] *:font-semibold *:uppercase">
                        <TableHead>Rule</TableHead>
                        <TableHead>Triggers</TableHead>
                        <TableHead>Impl. rate</TableHead>
                        <TableHead>👍 / 👎</TableHead>
                        <TableHead>Status</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {visible.map((row) => (
                        <TableRow
                            key={row.ruleId}
                            className="hover:bg-card-lv2 cursor-pointer"
                            onClick={() =>
                                router.push(
                                    `/review-suggestions?ruleId=${encodeURIComponent(row.ruleId)}&ruleTitle=${encodeURIComponent(row.title)}`,
                                )
                            }>
                            <TableCell className="text-text-primary max-w-md truncate text-xs font-medium">
                                {row.title}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                                {row.triggers}
                            </TableCell>
                            <TableCell>
                                <ImplRateBar rate={row.rate} />
                            </TableCell>
                            <TableCell className="text-xs whitespace-nowrap">
                                <span className="text-success">
                                    ▲ {row.thumbsUp}
                                </span>{" "}
                                <span className="text-danger">
                                    ▼ {row.thumbsDown}
                                </span>
                            </TableCell>
                            <TableCell>
                                <span
                                    className={cn(
                                        "rounded-full px-2.5 py-1 text-[11px] font-bold whitespace-nowrap",
                                        stateMeta[row.state].className,
                                    )}>
                                    {stateMeta[row.state].label}
                                </span>
                            </TableCell>
                        </TableRow>
                    ))}
                </TableBody>
            </Table>

            {filtered.length > PREVIEW_ROWS && (
                <button
                    type="button"
                    onClick={() => setShowAll((v) => !v)}
                    className="text-primary-light mt-3 w-full text-center text-xs font-semibold">
                    {showAll
                        ? "Show less ↑"
                        : `Show all ${filtered.length} rules ↓`}
                </button>
            )}

            <p className="text-text-tertiary mt-3 text-[11px]">
                <strong>Healthy</strong> = good triggers + impl rate ·{" "}
                <strong>Noisy</strong> = high 👎 · <strong>Ignored</strong> =
                triggers a lot but nobody implements · <strong>Stale</strong> =
                no triggers in this period · <strong>Low data</strong> = not
                enough sample to judge
            </p>
        </div>
    );
};
