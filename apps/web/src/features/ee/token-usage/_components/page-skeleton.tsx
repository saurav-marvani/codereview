"use client";

import { Page } from "@components/ui/page";
import { Skeleton } from "@components/ui/skeleton";

// Page-shell skeleton for Token Usage. Mirrors the real layout so the page
// doesn't visually jump when data lands (same pattern as KodyRulesPageSkeleton):
//   - real "Token Usage" title (static, known before data)
//   - a "preparing data" hint so the wait reads as intentional
//   - filters row (models multiselect + "Filter by" select) — flex gap-4
//   - one KPI row (Total cost / Total tokens / Uncached input / Cache read /
//     Output), matching SummaryCards' repeat(5, 1fr) grid
//   - the usage chart
// Reuses Page.Root / Page.Header / Page.Content so container width and spacing
// are identical to the loaded page.
export const TokenUsagePageSkeleton = () => {
    return (
        <Page.Root>
            <Page.Header>
                <Page.Title>Token Usage</Page.Title>
            </Page.Header>

            <Page.Content>
                <p className="text-text-secondary animate-pulse text-sm">
                    Preparing your usage data…
                </p>

                {/* filters row: models multiselect + "Filter by" select */}
                <div className="flex gap-4">
                    <Skeleton className="h-10 w-[300px] max-w-[350px]" />
                    <Skeleton className="h-10 w-[200px]" />
                </div>

                {/* KPI row — one row, equal columns */}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                    {Array.from({ length: 5 }).map((_, i) => (
                        <Skeleton key={i} className="h-28 w-full rounded-xl" />
                    ))}
                </div>

                {/* usage chart */}
                <Skeleton className="h-[440px] w-full rounded-xl" />
            </Page.Content>
        </Page.Root>
    );
};
