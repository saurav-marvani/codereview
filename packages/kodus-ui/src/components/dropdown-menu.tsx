"use client";

import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

import { cn } from "../lib/cn";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;

export function DropdownMenuContent({
    className,
    sideOffset = 4,
    ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
    return (
        <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
                sideOffset={sideOffset}
                className={cn(
                    "z-50 min-w-[220px] animate-in-pop rounded-md border border-border-strong bg-surface-2 p-[5px] shadow-pop",
                    className,
                )}
                {...props}
            />
        </DropdownMenuPrimitive.Portal>
    );
}

export function DropdownMenuLabel({
    className,
    ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
    return (
        <DropdownMenuPrimitive.Label
            className={cn(
                "px-[9px] pt-[7px] pb-1 text-[11px] font-semibold tracking-[0.07em] text-text-3 uppercase",
                className,
            )}
            {...props}
        />
    );
}

export function DropdownMenuItem({
    className,
    destructive,
    shortcut,
    children,
    ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
    destructive?: boolean;
    shortcut?: string;
}) {
    return (
        <DropdownMenuPrimitive.Item
            className={cn(
                "flex cursor-pointer items-center gap-[9px] rounded-sm px-[9px] py-[7px]",
                "text-[13.5px] text-text-1 outline-none select-none",
                "transition-colors duration-100 ease-out-quart",
                "data-highlighted:bg-surface-3",
                "data-disabled:pointer-events-none data-disabled:opacity-45",
                destructive &&
                    "text-danger data-highlighted:bg-danger-soft",
                className,
            )}
            {...props}>
            {children}
            {shortcut && (
                <span className="ml-auto font-mono text-[11px] text-text-3">
                    {shortcut}
                </span>
            )}
        </DropdownMenuPrimitive.Item>
    );
}

export function DropdownMenuSeparator({
    className,
    ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
    return (
        <DropdownMenuPrimitive.Separator
            className={cn("mx-1 my-[5px] h-px bg-border", className)}
            {...props}
        />
    );
}
