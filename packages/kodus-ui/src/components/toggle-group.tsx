"use client";

import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";

import { cn } from "../lib/cn";

export function ToggleGroup({
    className,
    ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
    return (
        <ToggleGroupPrimitive.Root
            className={cn(
                "inline-flex gap-0.5 rounded-md border border-border bg-surface-1 p-0.5",
                className,
            )}
            {...props}
        />
    );
}

export function ToggleGroupItem({
    className,
    ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
    return (
        <ToggleGroupPrimitive.Item
            className={cn(
                "rounded-[6px] px-3 py-[5px] text-[13px] font-medium text-text-2",
                "transition-colors duration-150 ease-out-quart",
                "hover:text-text-1",
                "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                "data-[state=on]:bg-surface-3 data-[state=on]:font-semibold data-[state=on]:text-text-1",
                className,
            )}
            {...props}
        />
    );
}
