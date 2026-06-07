"use client";

import { Tabs as TabsPrimitive } from "radix-ui";

import { cn } from "../lib/cn";

export const Tabs = TabsPrimitive.Root;

export function TabsList({
    className,
    ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
    return (
        <TabsPrimitive.List
            className={cn("flex gap-0.5 border-b border-border", className)}
            {...props}
        />
    );
}

export function TabsTrigger({
    className,
    count,
    children,
    ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger> & {
    count?: number;
}) {
    return (
        <TabsPrimitive.Trigger
            className={cn(
                "-mb-px border-b-2 border-transparent px-3.5 py-2",
                "text-[13.5px] font-medium text-text-2",
                "transition-colors duration-150 ease-out-quart",
                "hover:text-text-1",
                "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                "data-[state=active]:border-accent data-[state=active]:font-semibold data-[state=active]:text-text-1",
                className,
            )}
            {...props}>
            {children}
            {count !== undefined && (
                <span className="ml-1.5 rounded-full bg-surface-2 px-1.5 py-px font-mono text-[10.5px] text-text-3 in-data-[state=active]:bg-accent-soft in-data-[state=active]:text-accent">
                    {count}
                </span>
            )}
        </TabsPrimitive.Trigger>
    );
}

export function TabsContent({
    className,
    ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
    return (
        <TabsPrimitive.Content
            className={cn("pt-4 outline-none", className)}
            {...props}
        />
    );
}
