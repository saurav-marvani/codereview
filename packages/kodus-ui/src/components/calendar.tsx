"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker, type DayPickerProps } from "react-day-picker";

import { cn } from "../lib/cn";

/** Themed react-day-picker v9. Used by DatePicker/DateRangePicker. */
export function Calendar({
    className,
    classNames,
    ...props
}: DayPickerProps) {
    return (
        <DayPicker
            className={cn("relative p-3", className)}
            classNames={{
                months: "flex gap-6",
                month: "flex flex-col gap-3",
                month_caption: "flex h-8 items-center justify-center",
                caption_label: "text-sm font-semibold text-text-1",
                nav: "absolute inset-x-3 top-3 z-10 flex h-8 items-center justify-between",
                button_previous:
                    "grid size-7 place-items-center rounded-sm text-text-3 transition-colors duration-120 hover:bg-surface-2 hover:text-text-1",
                button_next:
                    "grid size-7 place-items-center rounded-sm text-text-3 transition-colors duration-120 hover:bg-surface-2 hover:text-text-1",
                month_grid: "border-collapse",
                weekdays: "flex",
                weekday:
                    "w-8 text-center text-[10.5px] font-semibold tracking-[0.07em] text-text-3 uppercase",
                week: "mt-1 flex",
                day: "p-0",
                day_button: cn(
                    "grid size-8 place-items-center rounded-sm text-[13px] text-text-1 tabular-nums",
                    "transition-colors duration-120 ease-out-quart hover:bg-surface-2",
                    "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                ),
                selected:
                    "[&>button]:bg-accent [&>button]:font-semibold [&>button]:text-on-accent [&>button]:hover:bg-accent-hover",
                range_start:
                    "[&>button]:rounded-r-none [&>button]:bg-accent [&>button]:text-on-accent",
                range_end:
                    "[&>button]:rounded-l-none [&>button]:bg-accent [&>button]:text-on-accent",
                /* middle days also carry `selected`; force soft band + white text over it */
                range_middle:
                    "[&>button]:!rounded-none [&>button]:!bg-accent-soft [&>button]:!font-normal [&>button]:!text-text-1 [&>button:hover]:!bg-surface-3",
                today: "[&>button]:font-bold [&>button]:text-accent [&>button:hover]:text-on-accent",
                outside: "[&>button]:text-text-3",
                disabled: "[&>button]:pointer-events-none [&>button]:opacity-35",
                hidden: "invisible",
                ...classNames,
            }}
            components={{
                Chevron: ({ orientation }) =>
                    orientation === "left" ? (
                        <ChevronLeft className="size-4" />
                    ) : (
                        <ChevronRight className="size-4" />
                    ),
            }}
            {...props}
        />
    );
}
