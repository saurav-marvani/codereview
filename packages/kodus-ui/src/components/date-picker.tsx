"use client";

import { useState } from "react";
import { Calendar as CalendarIcon } from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { type DateRange } from "react-day-picker";

import { cn } from "../lib/cn";
import { Calendar } from "./calendar";

const formatDate = (date: Date) =>
    new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
    }).format(date);

const triggerClasses = (hasValue: boolean, readOnly?: boolean) =>
    cn(
        "flex h-[34px] w-full items-center gap-2 rounded-md border border-border bg-surface-1 px-3",
        "text-sm",
        hasValue ? "text-text-1" : "text-text-3",
        "transition-[border-color] duration-150 ease-out-quart",
        "hover:border-border-strong",
        "focus-visible:border-accent focus-visible:shadow-[0_0_0_3px_var(--color-ring)] focus-visible:outline-none",
        "disabled:pointer-events-none disabled:not-data-readonly:opacity-45",
        "data-readonly:cursor-default data-readonly:bg-surface-2",
    );

export type DatePickerProps = {
    value: Date | null;
    onValueChange: (date: Date | null) => void;
    placeholder?: string;
    disabled?: boolean;
    /** RBAC view-only. */
    readOnly?: boolean;
    className?: string;
};

export function DatePicker({
    value,
    onValueChange,
    placeholder = "Pick a date",
    disabled,
    readOnly,
    className,
}: DatePickerProps) {
    const [open, setOpen] = useState(false);

    return (
        <PopoverPrimitive.Root
            open={open}
            onOpenChange={readOnly ? undefined : setOpen}>
            <PopoverPrimitive.Trigger
                disabled={disabled || readOnly}
                data-readonly={readOnly ? "" : undefined}
                aria-readonly={readOnly}
                className={cn(triggerClasses(!!value, readOnly), className)}>
                <CalendarIcon className="size-3.5 shrink-0 text-text-3" />
                {value ? formatDate(value) : placeholder}
            </PopoverPrimitive.Trigger>
            <PopoverPrimitive.Portal>
                <PopoverPrimitive.Content
                    align="start"
                    sideOffset={4}
                    className="z-50 animate-in-pop rounded-md border border-border-strong bg-surface-1 shadow-pop">
                    <Calendar
                        mode="single"
                        selected={value ?? undefined}
                        defaultMonth={value ?? undefined}
                        onSelect={(date) => {
                            onValueChange(date ?? null);
                            setOpen(false);
                        }}
                    />
                </PopoverPrimitive.Content>
            </PopoverPrimitive.Portal>
        </PopoverPrimitive.Root>
    );
}

export type DateRangePreset = {
    label: string;
    /** Computed on click so "Last week" is always relative to now. */
    range: () => DateRange;
};

export type DateRangePickerProps = {
    value: DateRange | null;
    onValueChange: (range: DateRange | null) => void;
    placeholder?: string;
    disabled?: boolean;
    readOnly?: boolean;
    /** Months shown side by side. */
    numberOfMonths?: number;
    /** Quick ranges above the calendar: Last week, Last month… Active when it matches the value. */
    presets?: DateRangePreset[];
    className?: string;
};

const sameDay = (a?: Date, b?: Date) =>
    !!a &&
    !!b &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

export function DateRangePicker({
    value,
    onValueChange,
    placeholder = "Pick a date range",
    disabled,
    readOnly,
    numberOfMonths = 2,
    presets,
    className,
}: DateRangePickerProps) {
    const [open, setOpen] = useState(false);

    const label = value?.from
        ? value.to
            ? `${formatDate(value.from)} – ${formatDate(value.to)}`
            : formatDate(value.from)
        : placeholder;

    const isPresetActive = (preset: DateRangePreset) => {
        const range = preset.range();
        return (
            sameDay(range.from, value?.from ?? undefined) &&
            sameDay(range.to, value?.to ?? undefined)
        );
    };

    return (
        <PopoverPrimitive.Root
            open={open}
            onOpenChange={readOnly ? undefined : setOpen}>
            <PopoverPrimitive.Trigger
                disabled={disabled || readOnly}
                data-readonly={readOnly ? "" : undefined}
                aria-readonly={readOnly}
                className={cn(
                    triggerClasses(!!value?.from, readOnly),
                    className,
                )}>
                <CalendarIcon className="size-3.5 shrink-0 text-text-3" />
                {label}
            </PopoverPrimitive.Trigger>
            <PopoverPrimitive.Portal>
                <PopoverPrimitive.Content
                    align="start"
                    sideOffset={4}
                    className="z-50 animate-in-pop rounded-md border border-border-strong bg-surface-1 shadow-pop">
                    {presets && presets.length > 0 && (
                        <div className="grid grid-cols-2 gap-1.5 border-b border-border p-3">
                            {presets.map((preset) => {
                                const active = isPresetActive(preset);

                                return (
                                    <button
                                        key={preset.label}
                                        type="button"
                                        aria-pressed={active}
                                        onClick={() =>
                                            onValueChange(preset.range())
                                        }
                                        className={cn(
                                            "h-7 rounded-full px-3 text-xs font-semibold",
                                            "transition-colors duration-120 ease-out-quart",
                                            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                                            active
                                                ? "bg-accent-soft text-accent"
                                                : "text-text-2 hover:bg-surface-2 hover:text-text-1",
                                        )}>
                                        {preset.label}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                    <Calendar
                        mode="range"
                        numberOfMonths={numberOfMonths}
                        selected={value ?? undefined}
                        defaultMonth={value?.from ?? undefined}
                        onSelect={(range) => onValueChange(range ?? null)}
                    />
                </PopoverPrimitive.Content>
            </PopoverPrimitive.Portal>
        </PopoverPrimitive.Root>
    );
}
