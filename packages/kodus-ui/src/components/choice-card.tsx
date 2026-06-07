"use client";

import { Check } from "lucide-react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";

import { cn } from "../lib/cn";

/**
 * Card-sized radio group: execution mode picker, BYOK model picker.
 * Selected card gets the accent border; orange is selection.
 */
export function ChoiceCards({
    className,
    ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
    return (
        <RadioGroupPrimitive.Root
            className={cn("grid gap-3 md:grid-cols-2", className)}
            {...props}
        />
    );
}

export function ChoiceCard({
    icon,
    media,
    title,
    description,
    detail,
    badge,
    hideIndicator,
    className,
    children,
    ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item> & {
    icon?: React.ReactNode;
    /** Larger leading visual (mascot image); replaces the icon tile. */
    media?: React.ReactNode;
    title: React.ReactNode;
    description?: React.ReactNode;
    /** Emphasized consequence line, e.g. "→ Inline review comments". */
    detail?: React.ReactNode;
    /** Floating tag on the top edge, e.g. "Recommended based on your repo". */
    badge?: React.ReactNode;
    /** Survey-style cards: selection shown by border only. */
    hideIndicator?: boolean;
}) {
    return (
        <RadioGroupPrimitive.Item
            className={cn(
                "group relative flex items-start gap-3 rounded-lg border border-border bg-surface-1 p-4 text-left",
                "transition-[border-color,background] duration-150 ease-out-quart",
                "hover:border-border-strong",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                "data-[state=checked]:border-accent data-[state=checked]:bg-accent-soft/40",
                "disabled:pointer-events-none disabled:opacity-45",
                className,
            )}
            {...props}>
            {badge && (
                <span className="absolute -top-2.5 right-3.5 rounded-full bg-accent px-2.5 py-0.5 text-[10.5px] font-bold text-on-accent">
                    {badge}
                </span>
            )}
            {media ? (
                <span className="shrink-0">{media}</span>
            ) : (
                icon && (
                    <span className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-2 text-text-2 group-data-[state=checked]:bg-accent-soft group-data-[state=checked]:text-accent">
                        {icon}
                    </span>
                )
            )}
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-text-1">
                    {title}
                </span>
                {description && (
                    <span className="mt-0.5 block text-[12.5px] text-text-2">
                        {description}
                    </span>
                )}
                {detail && (
                    <span className="mt-1 block text-[12.5px] font-semibold text-accent">
                        {detail}
                    </span>
                )}
                {children}
            </span>
            {!hideIndicator && (
                <span
                    aria-hidden
                    className="grid size-[18px] shrink-0 place-items-center rounded-full border-[1.5px] border-border-strong group-data-[state=checked]:border-accent group-data-[state=checked]:bg-accent">
                    <RadioGroupPrimitive.Indicator>
                        <Check
                            className="size-3 text-on-accent"
                            strokeWidth={3}
                        />
                    </RadioGroupPrimitive.Indicator>
                </span>
            )}
        </RadioGroupPrimitive.Item>
    );
}
