"use client";

import { X } from "lucide-react";

import { cn } from "../lib/cn";

const chipColors = {
    critical: "text-danger border-danger/45 data-active:bg-danger-soft",
    high: "text-warning border-warning/45 data-active:bg-warning-soft",
    medium: "text-info border-info/45 data-active:bg-info-soft",
    low: "text-text-2 border-border-strong data-active:bg-surface-2",
    accent: "text-accent border-accent/45 data-active:bg-accent-soft",
    violet: "text-violet border-violet/45 data-active:bg-violet-soft",
} as const;

export type FilterChipProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
    color?: keyof typeof chipColors;
    active?: boolean;
    count?: number;
    /** Renders a trailing × and makes the chip removable. */
    onRemove?: () => void;
};

export function FilterChip({
    className,
    color = "low",
    active = true,
    count,
    onRemove,
    children,
    ...props
}: FilterChipProps) {
    return (
        <button
            data-active={active ? "" : undefined}
            aria-pressed={active}
            className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md border bg-transparent px-2.5",
                "text-xs font-semibold",
                "transition-[background,border-color,opacity] duration-150 ease-out-quart",
                "not-data-active:opacity-60 hover:not-data-active:opacity-100",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                chipColors[color],
                className,
            )}
            {...props}>
            {count !== undefined && (
                <span className="font-mono tabular-nums">{count}</span>
            )}
            {children}
            {onRemove && (
                <X
                    role="button"
                    aria-label="Remove filter"
                    className="-mr-0.5 size-3 opacity-70 hover:opacity-100"
                    onClick={(event) => {
                        event.stopPropagation();
                        onRemove();
                    }}
                />
            )}
        </button>
    );
}
