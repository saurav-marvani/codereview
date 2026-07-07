"use client";

import { useEffect, useRef } from "react";
import { Button } from "@components/ui/button";
import { Skeleton } from "@components/ui/skeleton";
import { Spinner } from "@components/ui/spinner";
import { useVirtualizer } from "@tanstack/react-virtual";
import { GitPullRequestIcon } from "lucide-react";

import { PrListItem } from "./pr-list-item";
import type { PullRequestExecutionGroup } from "./types";

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
        estimateSize: () => 76,
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
            <div className="border-card-lv3/40 bg-card-lv1/50 divide-card-lv3/30 flex flex-col divide-y overflow-hidden rounded-xl border">
                {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="flex items-start gap-3 px-5 py-4">
                        <Skeleton className="mt-1 size-4 shrink-0 rounded" />
                        <div className="flex-1 space-y-2">
                            <Skeleton className="h-4 w-2/5" />
                            <Skeleton className="h-3 w-3/5" />
                        </div>
                        <div className="flex flex-col items-end gap-2">
                            <Skeleton className="h-5 w-16 rounded-md" />
                            <Skeleton className="h-4 w-24 rounded" />
                        </div>
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
            {/* Virtualized body — no column header; each row is a self-describing
                PR card (title + metadata subline + right-aligned signals). */}
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
    );
};
