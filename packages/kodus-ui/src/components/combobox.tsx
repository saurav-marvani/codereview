"use client";

import { useState } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Check, ChevronsUpDown, Search, X } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";

import { cn } from "../lib/cn";

export type ComboboxOption = {
    value: string;
    label: string;
    /** Secondary line under the label. */
    description?: string;
    icon?: React.ReactNode;
    disabled?: boolean;
};

export type ComboboxProps = {
    options: ComboboxOption[];
    value: string | null;
    onValueChange: (value: string | null) => void;
    placeholder?: string;
    searchPlaceholder?: string;
    emptyMessage?: React.ReactNode;
    /** Show an × to clear the selection. */
    clearable?: boolean;
    disabled?: boolean;
    /** RBAC view-only: value legible, no interaction. */
    readOnly?: boolean;
    className?: string;
};

/** Single-select searchable autocomplete (cmdk + popover). */
export function Combobox({
    options,
    value,
    onValueChange,
    placeholder = "Select…",
    searchPlaceholder = "Search…",
    emptyMessage = "No results.",
    clearable,
    disabled,
    readOnly,
    className,
}: ComboboxProps) {
    const [open, setOpen] = useState(false);
    const selected = options.find((option) => option.value === value);

    return (
        <PopoverPrimitive.Root
            open={open}
            onOpenChange={readOnly ? undefined : setOpen}>
            <PopoverPrimitive.Trigger
                disabled={disabled || readOnly}
                data-readonly={readOnly ? "" : undefined}
                aria-readonly={readOnly}
                className={cn(
                    "flex h-[34px] w-full items-center justify-between gap-2 rounded-md border border-border bg-surface-1 px-3",
                    "text-sm",
                    selected ? "text-text-1" : "text-text-3",
                    "transition-[border-color] duration-150 ease-out-quart",
                    "hover:border-border-strong",
                    "focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--color-ring)] focus-visible:outline-none",
                    "disabled:pointer-events-none disabled:not-data-readonly:opacity-45",
                    "data-readonly:cursor-default data-readonly:bg-surface-2",
                    className,
                )}>
                <span className="flex min-w-0 items-center gap-2 truncate">
                    {selected?.icon}
                    {selected?.label ?? placeholder}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                    {clearable && selected && !readOnly && (
                        <X
                            role="button"
                            aria-label="Clear selection"
                            className="size-3.5 text-text-3 hover:text-text-1"
                            onClick={(event) => {
                                event.stopPropagation();
                                onValueChange(null);
                            }}
                        />
                    )}
                    {!readOnly && (
                        <ChevronsUpDown className="size-3.5 text-text-3" />
                    )}
                </span>
            </PopoverPrimitive.Trigger>
            <PopoverPrimitive.Portal>
                <PopoverPrimitive.Content
                    align="start"
                    sideOffset={4}
                    className="z-50 w-[var(--radix-popover-trigger-width)] animate-in-pop overflow-hidden rounded-md border border-border-strong bg-surface-1 shadow-pop">
                    <CommandPrimitive>
                        <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5">
                            <Search className="size-4 shrink-0 text-text-3" />
                            <CommandPrimitive.Input
                                autoFocus
                                placeholder={searchPlaceholder}
                                className="flex-1 bg-transparent text-sm text-text-1 outline-none placeholder:text-text-3"
                            />
                        </div>
                        <CommandPrimitive.List className="max-h-[280px] overflow-y-auto py-1">
                            <CommandPrimitive.Empty className="px-4 py-6 text-center text-[13px] text-text-3">
                                {emptyMessage}
                            </CommandPrimitive.Empty>
                            {options.map((option) => (
                                <CommandPrimitive.Item
                                    key={option.value}
                                    value={`${option.label} ${option.description ?? ""}`}
                                    disabled={option.disabled}
                                    onSelect={() => {
                                        onValueChange(option.value);
                                        setOpen(false);
                                    }}
                                    className={cn(
                                        "mx-1.5 flex cursor-pointer items-start gap-2.5 rounded-sm px-2.5 py-2 select-none",
                                        "data-[selected=true]:bg-surface-2",
                                        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-45",
                                        option.value === value &&
                                            "bg-accent-soft",
                                    )}>
                                    {option.icon && (
                                        <span className="mt-0.5 shrink-0 text-text-3">
                                            {option.icon}
                                        </span>
                                    )}
                                    <span className="min-w-0 flex-1">
                                        <span
                                            className={cn(
                                                "block truncate text-sm font-medium",
                                                option.value === value
                                                    ? "text-accent"
                                                    : "text-text-1",
                                            )}>
                                            {option.label}
                                        </span>
                                        {option.description && (
                                            <span className="block text-xs text-text-3">
                                                {option.description}
                                            </span>
                                        )}
                                    </span>
                                    {option.value === value && (
                                        <Check
                                            className="mt-1 size-3 shrink-0 text-accent"
                                            strokeWidth={3}
                                        />
                                    )}
                                </CommandPrimitive.Item>
                            ))}
                        </CommandPrimitive.List>
                    </CommandPrimitive>
                </PopoverPrimitive.Content>
            </PopoverPrimitive.Portal>
        </PopoverPrimitive.Root>
    );
}
