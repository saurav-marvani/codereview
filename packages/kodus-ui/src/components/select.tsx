"use client";

import { Check, ChevronDown } from "lucide-react";
import { Select as SelectPrimitive } from "radix-ui";

import { cn } from "../lib/cn";

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectGroup = SelectPrimitive.Group;

export function SelectTrigger({
    className,
    children,
    readOnly,
    ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
    /** Value is visible but not changeable (RBAC view-only). */
    readOnly?: boolean;
}) {
    return (
        <SelectPrimitive.Trigger
            data-readonly={readOnly ? "" : undefined}
            aria-readonly={readOnly}
            disabled={props.disabled ?? readOnly}
            className={cn(
                "flex h-[34px] w-full items-center justify-between gap-2 rounded-md border border-border bg-surface-1 px-3",
                "text-sm text-text-1 data-placeholder:text-text-3",
                "transition-[border-color] duration-150 ease-out-quart",
                "hover:border-border-strong",
                "focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--color-ring)] focus-visible:outline-none",
                "aria-invalid:border-danger aria-invalid:focus-visible:shadow-[0_0_0_3px_var(--color-danger-soft)]",
                "disabled:pointer-events-none disabled:not-data-readonly:opacity-45",
                "data-readonly:cursor-default data-readonly:bg-surface-2",
                className,
            )}
            {...props}>
            {children}
            <SelectPrimitive.Icon>
                <ChevronDown
                    className={cn(
                        "size-3.5 text-text-3",
                        readOnly && "opacity-0",
                    )}
                />
            </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
    );
}

export function SelectContent({
    className,
    children,
    position = "popper",
    ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
    return (
        <SelectPrimitive.Portal>
            <SelectPrimitive.Content
                position={position}
                sideOffset={4}
                className={cn(
                    "z-50 min-w-[var(--radix-select-trigger-width)] animate-in-pop overflow-hidden rounded-md border border-border-strong bg-surface-2 p-[5px] shadow-pop",
                    className,
                )}
                {...props}>
                <SelectPrimitive.Viewport>
                    {children}
                </SelectPrimitive.Viewport>
            </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
    );
}

export function SelectLabel({
    className,
    ...props
}: React.ComponentProps<typeof SelectPrimitive.Label>) {
    return (
        <SelectPrimitive.Label
            className={cn(
                "px-[9px] pt-[7px] pb-1 text-[11px] font-semibold tracking-[0.07em] text-text-3 uppercase",
                className,
            )}
            {...props}
        />
    );
}

export function SelectItem({
    className,
    children,
    ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
    return (
        <SelectPrimitive.Item
            className={cn(
                "flex cursor-pointer items-center gap-[9px] rounded-sm px-[9px] py-[7px]",
                "text-[13.5px] text-text-1 outline-none select-none",
                "transition-colors duration-100 ease-out-quart",
                "focus:bg-surface-3 data-highlighted:bg-surface-3",
                "data-[state=checked]:bg-accent-soft data-[state=checked]:text-accent",
                "data-disabled:pointer-events-none data-disabled:opacity-45",
                className,
            )}
            {...props}>
            <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
            <SelectPrimitive.ItemIndicator className="ml-auto">
                <Check className="size-3" strokeWidth={3} />
            </SelectPrimitive.ItemIndicator>
        </SelectPrimitive.Item>
    );
}
