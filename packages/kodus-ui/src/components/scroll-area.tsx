"use client";

import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";

import { cn } from "../lib/cn";

export function ScrollArea({
    className,
    children,
    ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root>) {
    return (
        <ScrollAreaPrimitive.Root
            className={cn("overflow-hidden", className)}
            {...props}>
            <ScrollAreaPrimitive.Viewport className="size-full rounded-[inherit]">
                {children}
            </ScrollAreaPrimitive.Viewport>
            <ScrollAreaPrimitive.Scrollbar
                orientation="vertical"
                className="flex w-2 touch-none p-px select-none">
                <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-surface-3" />
            </ScrollAreaPrimitive.Scrollbar>
            <ScrollAreaPrimitive.Scrollbar
                orientation="horizontal"
                className="flex h-2 touch-none flex-col p-px select-none">
                <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-surface-3" />
            </ScrollAreaPrimitive.Scrollbar>
            <ScrollAreaPrimitive.Corner />
        </ScrollAreaPrimitive.Root>
    );
}
