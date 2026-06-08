"use client";

import { DataTableColumnHeader } from "@components/ui/data-table";
import type { ColumnDef } from "@tanstack/react-table";
import { cn } from "src/core/utils/components";

import type {
    KodyRuleHealthRow,
    KodyRuleHealthState,
} from "../../_services/analytics/review/fetch";
import { ImplRateBar } from "./impl-rate-bar";

export const stateMeta: Record<
    KodyRuleHealthState,
    { label: string; className: string }
> = {
    healthy: { label: "Healthy", className: "bg-success/15 text-success" },
    noisy: { label: "Noisy", className: "bg-danger/15 text-danger" },
    ignored: { label: "Ignored", className: "bg-warning/15 text-warning" },
    stale: { label: "Stale", className: "bg-card-lv3 text-text-tertiary" },
    low_data: { label: "Low data", className: "bg-info/15 text-info" },
};

export const rulesColumns: ColumnDef<KodyRuleHealthRow>[] = [
    {
        accessorKey: "title",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Rule" />
        ),
        cell: ({ row }) => (
            <span className="text-text-primary max-w-md truncate text-xs font-medium">
                {row.original.title}
            </span>
        ),
    },
    {
        accessorKey: "triggers",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Triggers" />
        ),
        cell: ({ row }) => (
            <span className="font-mono text-xs">{row.original.triggers}</span>
        ),
    },
    {
        accessorKey: "rate",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Impl. rate" />
        ),
        cell: ({ row }) => <ImplRateBar rate={row.original.rate} />,
    },
    {
        id: "feedback",
        accessorFn: (r) => r.thumbsDown,
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="👍 / 👎" />
        ),
        cell: ({ row }) => (
            <span className="text-xs whitespace-nowrap">
                <span className="text-success">▲ {row.original.thumbsUp}</span>{" "}
                <span className="text-danger">▼ {row.original.thumbsDown}</span>
            </span>
        ),
    },
    {
        accessorKey: "state",
        header: ({ column }) => (
            <DataTableColumnHeader column={column} title="Status" />
        ),
        cell: ({ row }) => (
            <span
                className={cn(
                    "rounded-full px-2.5 py-1 text-[11px] font-bold whitespace-nowrap",
                    stateMeta[row.original.state].className,
                )}>
                {stateMeta[row.original.state].label}
            </span>
        ),
    },
];
