"use client";

import { ChevronDown } from "lucide-react";
import {
    Accordion as AccordionPrimitive,
    Collapsible as CollapsiblePrimitive,
} from "radix-ui";

import { cn } from "../lib/cn";

export const Collapsible = CollapsiblePrimitive.Root;
export const CollapsibleTrigger = CollapsiblePrimitive.Trigger;

export function CollapsibleContent({
    className,
    ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Content>) {
    return (
        <CollapsiblePrimitive.Content
            className={cn(
                "overflow-hidden",
                "data-[state=closed]:animate-[kds-collapse-up_200ms_var(--ease-out-quart)]",
                "data-[state=open]:animate-[kds-collapse-down_200ms_var(--ease-out-quart)]",
                className,
            )}
            {...props}
        />
    );
}

export const Accordion = AccordionPrimitive.Root;

export function AccordionItem({
    className,
    ...props
}: React.ComponentProps<typeof AccordionPrimitive.Item>) {
    return (
        <AccordionPrimitive.Item
            className={cn(
                "overflow-hidden rounded-md border border-border bg-surface-1",
                "not-first:mt-2",
                className,
            )}
            {...props}
        />
    );
}

export function AccordionTrigger({
    className,
    children,
    ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
    return (
        <AccordionPrimitive.Header className="flex">
            <AccordionPrimitive.Trigger
                className={cn(
                    "group flex w-full items-center gap-2.5 px-3.5 py-3 text-left",
                    "text-[13.5px] font-semibold text-text-1",
                    "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    className,
                )}
                {...props}>
                {children}
                <ChevronDown className="ml-auto size-3.5 text-text-3 transition-transform duration-200 ease-out-quart group-data-[state=open]:rotate-180" />
            </AccordionPrimitive.Trigger>
        </AccordionPrimitive.Header>
    );
}

export function AccordionContent({
    className,
    children,
    ...props
}: React.ComponentProps<typeof AccordionPrimitive.Content>) {
    return (
        <AccordionPrimitive.Content
            className={cn(
                "overflow-hidden",
                "data-[state=closed]:animate-[kds-accordion-up_200ms_var(--ease-out-quart)]",
                "data-[state=open]:animate-[kds-accordion-down_200ms_var(--ease-out-quart)]",
            )}
            {...props}>
            <div
                className={cn(
                    "max-w-[70ch] px-3.5 pb-3 text-[13px] text-text-2",
                    className,
                )}>
                {children}
            </div>
        </AccordionPrimitive.Content>
    );
}
