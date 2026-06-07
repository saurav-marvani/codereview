"use client";

import { ChevronDown, ChevronsUpDown, ChevronUp } from "lucide-react";

import { cn } from "../lib/cn";

export function TableContainer({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn(
                "overflow-hidden rounded-lg border border-border bg-surface-1",
                className,
            )}
            {...props}
        />
    );
}

export function Table({
    className,
    ...props
}: React.TableHTMLAttributes<HTMLTableElement>) {
    return (
        <table
            className={cn("w-full border-collapse text-sm", className)}
            {...props}
        />
    );
}

export function TableHeader(props: React.HTMLAttributes<HTMLTableSectionElement>) {
    return <thead {...props} />;
}

export function TableBody(props: React.HTMLAttributes<HTMLTableSectionElement>) {
    return <tbody {...props} />;
}

export function TableRow({
    className,
    ...props
}: React.HTMLAttributes<HTMLTableRowElement>) {
    return (
        <tr
            className={cn(
                "transition-colors duration-120 ease-out-quart hover:bg-surface-2",
                className,
            )}
            {...props}
        />
    );
}

export type SortDirection = "asc" | "desc" | false;

export function TableHead({
    className,
    sort,
    onSort,
    children,
    ...props
}: React.ThHTMLAttributes<HTMLTableCellElement> & {
    /** Current sort direction; pass `false` for sortable-but-inactive. Omit for non-sortable. */
    sort?: SortDirection;
    onSort?: () => void;
}) {
    const sortable = sort !== undefined;
    const SortIcon =
        sort === "asc" ? ChevronUp : sort === "desc" ? ChevronDown : ChevronsUpDown;

    return (
        <th
            aria-sort={
                sort === "asc"
                    ? "ascending"
                    : sort === "desc"
                      ? "descending"
                      : undefined
            }
            className={cn(
                "border-b border-border bg-surface-2 px-4 py-2.5 text-left",
                "text-[11px] font-semibold tracking-[0.07em] text-text-3 uppercase",
                className,
            )}
            {...props}>
            {sortable ? (
                <button
                    type="button"
                    onClick={onSort}
                    className={cn(
                        "inline-flex items-center gap-1 uppercase",
                        "transition-colors duration-120 ease-out-quart hover:text-text-1",
                        "focus-visible:rounded-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                        sort && "text-text-1",
                    )}>
                    {children}
                    <SortIcon
                        className={cn(
                            "size-3",
                            sort ? "text-accent" : "opacity-60",
                        )}
                    />
                </button>
            ) : (
                children
            )}
        </th>
    );
}

export function TableCell({
    className,
    numeric,
    ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
    return (
        <td
            className={cn(
                "border-b border-border px-4 py-3 align-middle in-[tr:last-child]:border-b-0",
                numeric &&
                    "text-right font-mono text-[13px] tabular-nums text-text-2",
                className,
            )}
            {...props}
        />
    );
}

export function TableFooter({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn(
                "flex items-center gap-2 px-4 py-2.5 text-[12.5px] text-text-3",
                className,
            )}
            {...props}
        />
    );
}

export function TablePagination({
    page,
    pageCount,
    onPageChange,
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement> & {
    page: number;
    pageCount: number;
    onPageChange: (page: number) => void;
}) {
    const pages: Array<number | "…"> = [];
    for (let i = 1; i <= pageCount; i++) {
        if (i === 1 || i === pageCount || Math.abs(i - page) <= 1) {
            pages.push(i);
        } else if (pages[pages.length - 1] !== "…") {
            pages.push("…");
        }
    }

    return (
        <div className={cn("ml-auto flex gap-1", className)} {...props}>
            <PageButton
                disabled={page === 1}
                onClick={() => onPageChange(page - 1)}>
                ‹
            </PageButton>
            {pages.map((entry, index) =>
                entry === "…" ? (
                    <span
                        key={`gap-${index}`}
                        className="grid size-[26px] place-items-center text-text-3">
                        …
                    </span>
                ) : (
                    <PageButton
                        key={entry}
                        current={entry === page}
                        onClick={() => onPageChange(entry)}>
                        {entry}
                    </PageButton>
                ),
            )}
            <PageButton
                disabled={page === pageCount}
                onClick={() => onPageChange(page + 1)}>
                ›
            </PageButton>
        </div>
    );
}

function PageButton({
    current,
    className,
    ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { current?: boolean }) {
    return (
        <button
            className={cn(
                "grid h-[26px] min-w-[26px] place-items-center rounded-sm px-1.5",
                "text-[12.5px] text-text-2 tabular-nums",
                "transition-colors duration-120 ease-out-quart",
                "hover:bg-surface-2 hover:text-text-1",
                "disabled:pointer-events-none disabled:opacity-45",
                current &&
                    "bg-accent-soft font-semibold text-accent hover:bg-accent-soft hover:text-accent",
                className,
            )}
            {...props}
        />
    );
}
