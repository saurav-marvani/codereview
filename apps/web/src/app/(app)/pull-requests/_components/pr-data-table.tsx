"use client";

import { useEffect, useRef } from "react";
import { Button } from "@components/ui/button";
import { Skeleton } from "@components/ui/skeleton";
import { Spinner } from "@components/ui/spinner";
import {
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableHeader,
    TableRow,
} from "@components/ui/table";
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
    const containerRef = useRef<HTMLDivElement | null>(null);
    const loadMoreRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        const node = loadMoreRef.current;
        const root = containerRef.current;

        if (!node || !root || !fetchNextPage) return;

        const observer = new IntersectionObserver(
            (entries) => {
                const [entry] = entries;

                if (
                    entry?.isIntersecting &&
                    hasNextPage &&
                    !isFetchingNextPage
                ) {
                    fetchNextPage();
                }
            },
            { root, rootMargin: "0px 0px 200px 0px" },
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

    return (
        <TableContainer
            ref={containerRef}
            className="border-card-lv3/40 bg-card-lv1/50 max-h-[calc(100vh-13rem)] overflow-auto rounded-xl border">
            <Table className="w-full">
                <TableHeader sticky>
                    <TableRow className="hover:bg-transparent">
                        <TableHead className="w-8"></TableHead>
                        <TableHead className="text-text-tertiary w-20 text-xs font-medium tracking-wide uppercase">
                            PR
                        </TableHead>
                        <TableHead className="text-text-tertiary min-w-[18rem] text-xs font-medium tracking-wide uppercase">
                            Title
                        </TableHead>
                        <TableHead className="text-text-tertiary w-32 text-xs font-medium tracking-wide uppercase">
                            Repository
                        </TableHead>
                        <TableHead className="text-text-tertiary w-40 text-xs font-medium tracking-wide uppercase">
                            Branch
                        </TableHead>
                        <TableHead className="text-text-tertiary w-40 text-xs font-medium tracking-wide uppercase">
                            Author
                        </TableHead>
                        <TableHead className="text-text-tertiary w-20 text-center text-xs font-medium tracking-wide uppercase">
                            Reviews
                        </TableHead>
                        <TableHead className="text-text-tertiary w-32 text-xs font-medium tracking-wide uppercase">
                            Last Review
                        </TableHead>
                        <TableHead className="text-text-tertiary w-32 text-xs font-medium tracking-wide uppercase">
                            Created
                        </TableHead>
                        <TableHead className="text-text-tertiary w-20 text-center text-xs font-medium tracking-wide uppercase">
                            Suggestions
                        </TableHead>
                        <TableHead className="text-text-tertiary w-32 text-center text-xs font-medium tracking-wide uppercase">
                            Status
                        </TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {data.map((group) => (
                        <PrListItem key={group.prId} group={group} />
                    ))}
                </TableBody>
            </Table>
            <div ref={loadMoreRef} className="h-1 w-full" aria-hidden />
            {isFetchingNextPage && data.length > 0 && (
                <div className="flex justify-center py-4">
                    <Spinner className="size-5" />
                </div>
            )}
        </TableContainer>
    );
};
