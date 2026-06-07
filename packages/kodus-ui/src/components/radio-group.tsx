"use client";

import { RadioGroup as RadioGroupPrimitive } from "radix-ui";

import { cn } from "../lib/cn";

export function RadioGroup({
    className,
    ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
    return (
        <RadioGroupPrimitive.Root
            className={cn("flex flex-col gap-3", className)}
            {...props}
        />
    );
}

export function RadioGroupItem({
    className,
    readOnly,
    ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item> & {
    /** Value is visible but not changeable (RBAC view-only). */
    readOnly?: boolean;
}) {
    return (
        <RadioGroupPrimitive.Item
            data-readonly={readOnly ? "" : undefined}
            aria-readonly={readOnly}
            disabled={props.disabled ?? readOnly}
            className={cn(
                "grid size-4 shrink-0 place-items-center rounded-full border-[1.5px] border-border-strong bg-surface-1",
                "transition-[border-color] duration-150 ease-out-quart",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                "data-[state=checked]:border-accent",
                "disabled:pointer-events-none disabled:not-data-readonly:opacity-45",
                "data-readonly:cursor-default",
                className,
            )}
            {...props}>
            <RadioGroupPrimitive.Indicator className="size-2 rounded-full bg-accent" />
        </RadioGroupPrimitive.Item>
    );
}
