"use client";

import { Lock } from "lucide-react";

import { cn } from "../lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/**
 * RBAC view-only wrapper: makes any control inert, adds a lock icon and a
 * tooltip explaining why. The wrapped value stays fully legible — this is
 * NOT disabled (use disabled for "temporarily unavailable", Locked for
 * "you can't change this").
 *
 * Requires a TooltipProvider up the tree.
 */
export function Locked({
    locked = true,
    reason = "You don't have permission to change this.",
    hideIcon,
    className,
    children,
}: {
    locked?: boolean;
    reason?: React.ReactNode;
    /** Hide the lock glyph when the surrounding UI already shows one. */
    hideIcon?: boolean;
    className?: string;
    children: React.ReactNode;
}) {
    if (!locked) return <>{children}</>;

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span
                    className={cn(
                        "inline-flex items-center gap-2",
                        className,
                    )}>
                    <span
                        aria-disabled
                        className="pointer-events-none select-none">
                        {children}
                    </span>
                    {!hideIcon && (
                        <Lock
                            aria-label="Locked"
                            className="size-3.5 shrink-0 text-text-3"
                        />
                    )}
                </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px]">{reason}</TooltipContent>
        </Tooltip>
    );
}
