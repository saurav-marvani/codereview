"use client";

import { useState } from "react";
import { Card } from "@components/ui/card";
import { cn } from "src/core/utils/components";

import type { SuggestionsExplorerItem } from "../../_services/analytics/review/explorer-fetch";

const severityClassName: Record<string, string> = {
    critical: "bg-danger/15 text-danger",
    high: "bg-warning/15 text-warning",
    medium: "bg-alert/15 text-alert",
    low: "bg-info/15 text-info",
};

const statusLabel = (status: string | null) => {
    if (status === "implemented") return "✓ implemented";
    if (status === "partially_implemented") return "◐ partially implemented";
    return "○ not implemented";
};

export const SuggestionItem = ({
    item,
}: {
    item: SuggestionsExplorerItem;
}) => {
    const [open, setOpen] = useState(false);
    const hasDetail = Boolean(item.existingCode || item.improvedCode);
    const isImplemented =
        item.implementationStatus === "implemented" ||
        item.implementationStatus === "partially_implemented";

    return (
        <Card color="lv1" className="overflow-hidden p-0">
            <button
                type="button"
                onClick={() => hasDetail && setOpen((v) => !v)}
                className={cn(
                    "w-full px-4 py-3.5 text-left",
                    hasDetail && "hover:bg-card-lv2 cursor-pointer",
                )}>
                <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    {item.severity && (
                        <span
                            className={cn(
                                "rounded px-2 py-0.5 text-[10px] font-bold uppercase",
                                severityClassName[item.severity] ??
                                    "bg-card-lv3 text-text-secondary",
                            )}>
                            {item.severity}
                        </span>
                    )}
                    {item.category && (
                        <span className="bg-card-lv3 text-text-secondary rounded-full px-2.5 py-0.5 text-[11px] font-semibold">
                            {item.category}
                        </span>
                    )}
                    <span
                        className={cn(
                            "ml-auto text-[11px] font-semibold",
                            isImplemented
                                ? "text-success"
                                : "text-text-tertiary",
                        )}>
                        {statusLabel(item.implementationStatus)}
                    </span>
                </div>

                <p className="text-text-primary mb-1.5 text-sm leading-snug">
                    {item.summary ?? "(no summary)"}
                </p>

                <div className="text-text-tertiary flex flex-wrap gap-4 text-xs">
                    {item.repository && (
                        <span className="font-mono">{item.repository}</span>
                    )}
                    {item.filePath && (
                        <span className="font-mono text-[11px]">
                            {item.filePath}
                        </span>
                    )}
                    {item.prNumber && <span>PR #{item.prNumber}</span>}
                    {item.createdAt && (
                        <span>{item.createdAt.slice(0, 10)}</span>
                    )}
                    {hasDetail && (
                        <span className="text-primary-light ml-auto font-semibold">
                            {open ? "Hide code ↑" : "View code ↓"}
                        </span>
                    )}
                </div>
            </button>

            {open && hasDetail && (
                <div className="border-card-lv3 grid grid-cols-2 gap-2.5 border-t bg-[#14141f] p-4">
                    <div className="border-card-lv3 overflow-hidden rounded-md border">
                        <div className="bg-danger/10 text-danger px-3 py-1.5 text-[10px] font-bold uppercase">
                            Existing code
                        </div>
                        <pre className="bg-card-lv1 text-text-secondary overflow-x-auto p-3 font-mono text-[11px] leading-relaxed">
                            {item.existingCode ?? "—"}
                        </pre>
                    </div>
                    <div className="border-card-lv3 overflow-hidden rounded-md border">
                        <div className="bg-success/10 text-success px-3 py-1.5 text-[10px] font-bold uppercase">
                            Suggested code
                        </div>
                        <pre className="bg-card-lv1 text-text-secondary overflow-x-auto p-3 font-mono text-[11px] leading-relaxed">
                            {item.improvedCode ?? "—"}
                        </pre>
                    </div>
                </div>
            )}
        </Card>
    );
};
