"use client";

import { CircleHelp } from "lucide-react";

import { cn } from "../lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

/** The "?" next to a label. Requires a TooltipProvider up the tree. */
export function HelpTip({
    className,
    children,
}: {
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    aria-label="Help"
                    className={cn(
                        "inline-grid place-items-center align-middle text-text-3 hover:text-text-1",
                        "focus-visible:rounded-full focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                        className,
                    )}>
                    <CircleHelp className="size-3.5" />
                </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-[260px]">
                {children}
            </TooltipContent>
        </Tooltip>
    );
}
