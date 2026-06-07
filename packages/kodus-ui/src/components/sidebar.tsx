"use client";

import { ChevronDown } from "lucide-react";
import { Collapsible as CollapsiblePrimitive, Slot } from "radix-ui";

import { cn } from "../lib/cn";

export function Sidebar({
    className,
    ...props
}: React.HTMLAttributes<HTMLElement>) {
    return (
        <aside
            className={cn(
                "flex w-[264px] shrink-0 flex-col gap-5 overflow-y-auto",
                "border-r border-border bg-surface-1 px-3 py-4",
                className,
            )}
            {...props}
        />
    );
}

export function SidebarGroup({
    label,
    className,
    children,
    ...props
}: React.HTMLAttributes<HTMLDivElement> & { label?: React.ReactNode }) {
    return (
        <div className={className} {...props}>
            {label && (
                <div className="mb-1.5 px-2 text-[11px] font-semibold tracking-[0.09em] text-text-3 uppercase">
                    {label}
                </div>
            )}
            <div className="flex flex-col gap-px">{children}</div>
        </div>
    );
}

export type SidebarItemProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
    asChild?: boolean;
    active?: boolean;
    icon?: React.ReactNode;
    /** Override counter pill (accent, mono numerals). */
    count?: number;
    /** Trailing tag, e.g. Beta (violet). */
    tag?: React.ReactNode;
};

export function SidebarItem({
    className,
    asChild,
    active,
    icon,
    count,
    tag,
    children,
    ...props
}: SidebarItemProps) {
    const Comp = asChild ? Slot.Root : "button";

    return (
        <Comp
            data-active={active ? "" : undefined}
            className={cn(
                "flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left",
                "text-[13.5px] font-medium text-text-2",
                "transition-colors duration-120 ease-out-quart",
                "hover:bg-surface-2 hover:text-text-1",
                "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                "data-active:bg-accent-soft data-active:font-semibold data-active:text-accent",
                className,
            )}
            {...props}>
            {icon && (
                <span className="w-[15px] text-center text-xs text-text-3 in-data-active:text-accent">
                    {icon}
                </span>
            )}
            {asChild ? (
                <Slot.Slottable>{children}</Slot.Slottable>
            ) : (
                <span className="min-w-0 flex-1 truncate">{children}</span>
            )}
            {count !== undefined && count > 0 && (
                <span className="grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent-soft px-[5px] font-mono text-[10.5px] font-semibold text-accent">
                    {count}
                </span>
            )}
            {tag}
        </Comp>
    );
}

/**
 * Collapsible scope node: Global, repository, directory.
 * Max three levels: global → repo → directory.
 */
export function SidebarScope({
    label,
    count,
    defaultOpen = true,
    className,
    children,
    ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root> & {
    label: React.ReactNode;
    count?: number;
}) {
    return (
        <CollapsiblePrimitive.Root
            defaultOpen={defaultOpen}
            className={className}
            {...props}>
            <CollapsiblePrimitive.Trigger asChild>
                <SidebarItem
                    className="group"
                    icon={
                        <ChevronDown className="size-3 transition-transform duration-200 ease-out-quart group-data-[state=closed]:-rotate-90" />
                    }
                    count={count}>
                    {label}
                </SidebarItem>
            </CollapsiblePrimitive.Trigger>
            <CollapsiblePrimitive.Content className="overflow-hidden data-[state=closed]:animate-[kds-collapse-up_200ms_var(--ease-out-quart)] data-[state=open]:animate-[kds-collapse-down_200ms_var(--ease-out-quart)]">
                <div className="mt-0.5 mb-1 ml-[13px] flex flex-col gap-px border-l border-border pl-[9px]">
                    {children}
                </div>
            </CollapsiblePrimitive.Content>
        </CollapsiblePrimitive.Root>
    );
}
