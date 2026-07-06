"use client";

import { Card } from "@components/ui/card";
import { Page } from "@components/ui/page";
import { Skeleton } from "@components/ui/skeleton";

// Page-shell skeleton for Token Usage. Mirrors the real layout so the page
// doesn't visually jump when data lands (same pattern as KodyRulesPageSkeleton):
//   - real "Token Usage" title (static, known before data)
//   - a "preparing data" hint so the wait reads as intentional
//   - filters row (models multiselect + "Filter by" select) — flex gap-4
//   - 5 summary cards in a single row (Uncached Input / Cache Read / Output /
//     Cache Write / Total), matching SummaryCards' repeat(5, 1fr) grid
//   - one cost card split into 3 (Total Cost / Avg. per Day / Avg. per PR),
//     matching CostCards' single grid-cols-3 divide-x card
//   - the usage chart
// Reuses Page.Root / Page.Header / Page.Content so container width and spacing
// are identical to the loaded page.
// Content-only skeleton (no Page.Root/Header) so it can be reused by both the
// route-level loading.tsx (wrapped below) AND TokenUsagePageClient's pre-mount
// state — which already renders inside <Page.Content>, and would otherwise flash
// an empty body between SSR and client mount (returning null).
export const TokenUsageContentSkeleton = () => {
    return (
        <>
            <p className="text-text-secondary animate-pulse text-sm">
                Preparing your usage data…
            </p>

            {/* filters row: models multiselect + "Filter by" select */}
            <div className="flex gap-4">
                <Skeleton className="h-10 w-[300px] max-w-[350px]" />
                <Skeleton className="h-10 w-[200px]" />
            </div>

            {/* 5 summary cards — one row, equal columns */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-24 w-full rounded-xl" />
                ))}
            </div>

            {/* cost card: single card split into 3 (Total / Avg day / Avg PR) */}
            <Card className="overflow-hidden">
                <div className="grid grid-cols-1 divide-y divide-[var(--color-card-lv1)] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                    {Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} className="flex items-center gap-4 p-4">
                            <Skeleton className="size-12 shrink-0 rounded-xl" />
                            <div className="flex-1 space-y-2">
                                <Skeleton className="h-3 w-24" />
                                <Skeleton className="h-5 w-20" />
                            </div>
                        </div>
                    ))}
                </div>
            </Card>

            {/* usage chart */}
            <Skeleton className="h-80 w-full rounded-xl" />
        </>
    );
};

export const TokenUsagePageSkeleton = () => {
    return (
        <Page.Root>
            <Page.Header>
                <Page.Title>Token Usage</Page.Title>
            </Page.Header>

            <Page.Content>
                <TokenUsageContentSkeleton />
            </Page.Content>
        </Page.Root>
    );
};
