"use client";

import { useEffect, useRef } from "react";
import { Button } from "@components/ui/button";
import { Skeleton } from "@components/ui/skeleton";
import { Spinner } from "@components/ui/spinner";
import { useVirtualizer } from "@tanstack/react-virtual";
import { GitPullRequestIcon } from "lucide-react";

import { PrListItem } from "./pr-list-item";
import type { PullRequestExecutionGroup } from "./types";

// Shared column template for the header + every row so a virtualized `<div>`
// grid stays aligned (a real `<table>` can't be virtualized with the expandable
// variable-height rows this list has). Responsive column hiding was dropped in
// favor of horizontal scroll on narrow viewports.
export const PR_GRID_COLS =
    "2rem 4.5rem minmax(16rem,1fr) 8rem 9rem 9rem 4.5rem 8rem 8rem 6rem 7rem";
export const PR_MIN_WIDTH = "72rem";

const HEADERS = [
    "",
    "PR",
    "Title",
    "Repository",
    "Branch",
    "Author",
    "Reviews",
    "Last Review",
    "Created",
    "Suggestions",
    "Status",
];
const CENTERED = new Set([6, 9, 10]);

interface PrDataTableProps {
    data: PullRequestExecutionGroup[];
    loading?: boolean;
    hasNextPage?: boolean;
    isFetchingNextPage?: boolean;
    fetchNextPage?: () => void;
    hasActiveFilters?: boolean;
    onClearFilters?: () => void;
}

export const PrDataTable = ({
    data,
    loading,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    hasActiveFilters,
    onClearFilters,
}: PrDataTableProps) => {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const loadMoreRef = useRef<HTMLDivElement | null>(null);

    const virtualizer = useVirtualizer({
        count: data.length,
        getScrollElement: () => scrollRef.current,
        // Collapsed row height; measureElement corrects it (and any expanded
        // row) to the real value via ResizeObserver.
        estimateSize: () => 52,
        overscan: 8,
        getItemKey: (index) => data[index]?.prId ?? index,
    });

    useEffect(() => {
        const node = loadMoreRef.current;
        const root = scrollRef.current;
        if (!node || !root || !fetchNextPage) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (
                    entries[0]?.isIntersecting &&
                    hasNextPage &&
                    !isFetchingNextPage
                ) {
                    fetchNextPage();
                }
            },
            { root, rootMargin: "0px 0px 400px 0px" },
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

    if (loading) {
        return (
            <div className="border-card-lv3/40 bg-card-lv1/50 flex flex-col gap-px overflow-hidden rounded-xl border">
                {Array.from({ length: 8 }).map((_, i) => (
                    <div
                        key={i}
                        className="flex items-center gap-4 px-4 py-3.5">
                        <Skeleton className="size-4 shrink-0 rounded" />
                        <Skeleton className="h-4 w-10 shrink-0" />
                        <Skeleton className="h-4 flex-1" />
                        <Skeleton className="h-4 w-24 shrink-0" />
                        <Skeleton className="hidden h-4 w-28 shrink-0 lg:block" />
                        <Skeleton className="h-5 w-16 shrink-0 rounded-md" />
                    </div>
                ))}
            </div>
        );
    }

    if (!data.length) {
        return (
            <div className="border-card-lv3/40 bg-card-lv1/50 flex flex-col items-center justify-center gap-3 rounded-xl border py-16 text-center">
                <div className="bg-card-lv2/60 text-text-tertiary flex size-11 items-center justify-center rounded-full">
                    <GitPullRequestIcon className="size-5" />
                </div>
                {hasActiveFilters ? (
                    <>
                        <p className="text-text-secondary text-sm">
                            No pull requests match these filters.
                        </p>
                        {onClearFilters && (
                            <Button
                                size="xs"
                                variant="helper"
                                onClick={onClearFilters}>
                                Clear filters
                            </Button>
                        )}
                    </>
                ) : (
                    <p className="text-text-secondary text-sm">
                        No pull requests reviewed yet.
                    </p>
                )}
            </div>
        );
    }

    const items = virtualizer.getVirtualItems();

    return (
        <div
            ref={scrollRef}
            className="border-card-lv3/40 bg-card-lv1/50 max-h-[calc(100vh-13rem)] overflow-auto rounded-xl border">
            <div style={{ minWidth: PR_MIN_WIDTH }}>
                {/* Sticky header */}
                <div
                    className="bg-card-lv1 border-card-lv3/40 sticky top-0 z-10 grid items-center gap-x-3 border-b px-4 py-2.5"
                    style={{ gridTemplateColumns: PR_GRID_COLS }}>
                    {HEADERS.map((label, i) => (
                        <div
                            key={i}
                            className={`text-text-tertiary min-w-0 truncate text-xs font-medium tracking-wide uppercase ${
                                CENTERED.has(i) ? "text-center" : ""
                            }`}>
                            {label}
                        </div>
                    ))}
                </div>

                {/* Virtualized body */}
                <div
                    style={{
                        height: `${virtualizer.getTotalSize()}px`,
                        position: "relative",
                    }}>
                    {items.map((virtualRow) => (
                        <div
                            key={virtualRow.key}
                            data-index={virtualRow.index}
                            ref={virtualizer.measureElement}
                            style={{
                                position: "absolute",
                                top: 0,
                                left: 0,
                                width: "100%",
                                transform: `translateY(${virtualRow.start}px)`,
                            }}>
                            <PrListItem group={data[virtualRow.index]} />
                        </div>
                    ))}
                </div>

                <div ref={loadMoreRef} className="h-1 w-full" aria-hidden />
                {isFetchingNextPage && (
                    <div className="flex justify-center py-4">
                        <Spinner className="size-5" />
                    </div>
                )}
            </div>
        </div>
    );
};
