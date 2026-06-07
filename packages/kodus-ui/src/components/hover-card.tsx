"use client";

import { HoverCard as HoverCardPrimitive } from "radix-ui";

import { cn } from "../lib/cn";

export const HoverCard = HoverCardPrimitive.Root;
export const HoverCardTrigger = HoverCardPrimitive.Trigger;

export function HoverCardContent({
    className,
    sideOffset = 6,
    ...props
}: React.ComponentProps<typeof HoverCardPrimitive.Content>) {
    return (
        <HoverCardPrimitive.Portal>
            <HoverCardPrimitive.Content
                sideOffset={sideOffset}
                className={cn(
                    "z-50 w-[300px] animate-in-pop rounded-md border border-border-strong bg-surface-2 p-4 shadow-pop",
                    className,
                )}
                {...props}
            />
        </HoverCardPrimitive.Portal>
    );
}
