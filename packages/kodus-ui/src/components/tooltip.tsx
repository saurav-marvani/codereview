"use client";

import { Tooltip as TooltipPrimitive } from "radix-ui";

import { cn } from "../lib/cn";

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
    className,
    sideOffset = 6,
    ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
    return (
        <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
                sideOffset={sideOffset}
                className={cn(
                    "z-50 animate-in-pop rounded-sm bg-surface-3 px-[9px] py-[5px]",
                    "text-xs text-text-1 shadow-pop",
                    className,
                )}
                {...props}
            />
        </TooltipPrimitive.Portal>
    );
}
