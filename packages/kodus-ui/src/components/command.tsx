"use client";

import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";
import { VisuallyHidden } from "radix-ui";

import { cn } from "../lib/cn";
import { Dialog, DialogContent, DialogTitle } from "./dialog";

export function Command({
    className,
    ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
    return (
        <CommandPrimitive
            className={cn(
                "overflow-hidden rounded-lg border border-border-strong bg-surface-1 shadow-pop",
                className,
            )}
            {...props}
        />
    );
}

/** ⌘K modal wrapper. */
export function CommandDialog({
    open,
    onOpenChange,
    children,
}: React.PropsWithChildren<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
}>) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                aria-describedby={undefined}
                className="top-[20%] w-[min(560px,calc(100vw-32px))] -translate-y-0 border-none p-0">
                <VisuallyHidden.Root>
                    <DialogTitle>Command palette</DialogTitle>
                </VisuallyHidden.Root>
                <Command>{children}</Command>
            </DialogContent>
        </Dialog>
    );
}

export function CommandInput({
    className,
    ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
    return (
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
            <Search className="size-4 shrink-0 text-text-3" />
            <CommandPrimitive.Input
                className={cn(
                    "flex-1 bg-transparent text-[15px] text-text-1 outline-none placeholder:text-text-3",
                    className,
                )}
                {...props}
            />
        </div>
    );
}

export function CommandList({
    className,
    ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
    return (
        <CommandPrimitive.List
            className={cn("max-h-[320px] overflow-y-auto pb-1.5", className)}
            {...props}
        />
    );
}

export function CommandEmpty({
    className,
    ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
    return (
        <CommandPrimitive.Empty
            className={cn(
                "px-4 py-8 text-center text-[13px] text-text-3",
                className,
            )}
            {...props}
        />
    );
}

export function CommandGroup({
    className,
    ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
    return (
        <CommandPrimitive.Group
            className={cn(
                "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1",
                "[&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold",
                "[&_[cmdk-group-heading]]:tracking-[0.07em] [&_[cmdk-group-heading]]:text-text-3 [&_[cmdk-group-heading]]:uppercase",
                className,
            )}
            {...props}
        />
    );
}

export function CommandItem({
    className,
    shortcut,
    children,
    ...props
}: React.ComponentProps<typeof CommandPrimitive.Item> & {
    shortcut?: string;
}) {
    return (
        <CommandPrimitive.Item
            className={cn(
                "mx-[5px] flex cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-[9px]",
                "text-[13.5px] text-text-1 select-none",
                "data-[selected=true]:bg-surface-2",
                "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45",
                className,
            )}
            {...props}>
            {children}
            {shortcut && (
                <kbd className="ml-auto rounded-[5px] border border-border-strong border-b-2 bg-surface-1 px-[7px] py-0.5 font-mono text-[11px] text-text-2">
                    {shortcut}
                </kbd>
            )}
        </CommandPrimitive.Item>
    );
}
