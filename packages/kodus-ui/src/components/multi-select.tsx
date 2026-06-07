"use client";

import { useState } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";

import { cn } from "../lib/cn";

export type MultiSelectOption = {
    value: string;
    label: string;
    /** Secondary line, e.g. "Last activity about 14 hours ago". */
    description?: string;
};

export type MultiSelectProps = {
    options: MultiSelectOption[];
    values: string[];
    onValuesChange: (values: string[]) => void;
    placeholder?: string;
    searchPlaceholder?: string;
    /** Show the "Select all" action. */
    selectAll?: boolean;
    emptyMessage?: React.ReactNode;
    disabled?: boolean;
    className?: string;
};

/**
 * Searchable checkbox combobox: the repository picker.
 * Selected items group at the top; trigger summarizes the selection.
 */
export function MultiSelect({
    options,
    values,
    onValuesChange,
    placeholder = "Select…",
    searchPlaceholder = "Search…",
    selectAll = true,
    emptyMessage = "No results.",
    disabled,
    className,
}: MultiSelectProps) {
    const [open, setOpen] = useState(false);

    const toggle = (value: string) =>
        onValuesChange(
            values.includes(value)
                ? values.filter((current) => current !== value)
                : [...values, value],
        );

    const selected = options.filter((option) =>
        values.includes(option.value),
    );
    const unselected = options.filter(
        (option) => !values.includes(option.value),
    );

    const summary =
        selected.length === 0
            ? placeholder
            : selected.length <= 2
              ? selected.map((option) => option.label).join(", ")
              : `${selected.length} selected`;

    return (
        <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
            <PopoverPrimitive.Trigger
                disabled={disabled}
                className={cn(
                    "flex h-[38px] w-full items-center justify-between gap-2 rounded-md border border-border bg-surface-1 px-3",
                    "text-sm",
                    selected.length === 0 ? "text-text-3" : "text-text-1",
                    "transition-[border-color] duration-150 ease-out-quart",
                    "hover:border-border-strong",
                    "focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--color-ring)] focus-visible:outline-none",
                    "disabled:pointer-events-none disabled:opacity-45",
                    className,
                )}>
                <span className="truncate">{summary}</span>
                <ChevronsUpDown className="size-3.5 shrink-0 text-text-3" />
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
                                placeholder={searchPlaceholder}
                                className="flex-1 bg-transparent text-sm text-text-1 outline-none placeholder:text-text-3"
                            />
                        </div>
                        {selectAll && (
                            <div className="flex justify-end border-b border-border px-3.5 py-1.5">
                                <button
                                    type="button"
                                    onClick={() =>
                                        onValuesChange(
                                            values.length === options.length
                                                ? []
                                                : options.map(
                                                      (option) => option.value,
                                                  ),
                                        )
                                    }
                                    className="text-xs font-semibold text-accent hover:text-accent-hover">
                                    {values.length === options.length
                                        ? "Clear all"
                                        : "Select all"}
                                </button>
                            </div>
                        )}
                        <CommandPrimitive.List className="max-h-[280px] overflow-y-auto py-1">
                            <CommandPrimitive.Empty className="px-4 py-6 text-center text-[13px] text-text-3">
                                {emptyMessage}
                            </CommandPrimitive.Empty>
                            {selected.length > 0 && (
                                <MultiSelectGroup heading="Selected">
                                    {selected.map((option) => (
                                        <MultiSelectItem
                                            key={option.value}
                                            option={option}
                                            checked
                                            onToggle={toggle}
                                        />
                                    ))}
                                </MultiSelectGroup>
                            )}
                            {unselected.length > 0 && (
                                <MultiSelectGroup heading="Not selected">
                                    {unselected.map((option) => (
                                        <MultiSelectItem
                                            key={option.value}
                                            option={option}
                                            checked={false}
                                            onToggle={toggle}
                                        />
                                    ))}
                                </MultiSelectGroup>
                            )}
                        </CommandPrimitive.List>
                    </CommandPrimitive>
                </PopoverPrimitive.Content>
            </PopoverPrimitive.Portal>
        </PopoverPrimitive.Root>
    );
}

function MultiSelectGroup({
    heading,
    children,
}: React.PropsWithChildren<{ heading: string }>) {
    return (
        <CommandPrimitive.Group
            heading={heading}
            className={cn(
                "[&_[cmdk-group-heading]]:px-3.5 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1",
                "[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-accent",
            )}>
            {children}
        </CommandPrimitive.Group>
    );
}

function MultiSelectItem({
    option,
    checked,
    onToggle,
}: {
    option: MultiSelectOption;
    checked: boolean;
    onToggle: (value: string) => void;
}) {
    return (
        <CommandPrimitive.Item
            value={`${option.label} ${option.description ?? ""}`}
            onSelect={() => onToggle(option.value)}
            className={cn(
                "mx-1.5 flex cursor-pointer items-start gap-2.5 rounded-sm px-2.5 py-2 select-none",
                "data-[selected=true]:bg-surface-2",
            )}>
            <span
                aria-hidden
                className={cn(
                    "mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4.5px] border-[1.5px]",
                    checked
                        ? "border-accent bg-accent text-on-accent"
                        : "border-border-strong bg-surface-1",
                )}>
                {checked && <Check className="size-3" strokeWidth={3} />}
            </span>
            <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-text-1">
                    {option.label}
                </span>
                {option.description && (
                    <span className="block text-xs text-text-3">
                        {option.description}
                    </span>
                )}
            </span>
        </CommandPrimitive.Item>
    );
}
