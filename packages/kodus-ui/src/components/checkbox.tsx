"use client";

import { Check, Minus } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";

import { cn } from "../lib/cn";

export type CheckboxProps = React.ComponentProps<
    typeof CheckboxPrimitive.Root
> & {
    /** Value is visible but not changeable (RBAC view-only). */
    readOnly?: boolean;
};

export function Checkbox({ className, readOnly, ...props }: CheckboxProps) {
    return (
        <CheckboxPrimitive.Root
            data-readonly={readOnly ? "" : undefined}
            aria-readonly={readOnly}
            disabled={props.disabled ?? readOnly}
            className={cn(
                "grid size-4 shrink-0 place-items-center rounded-[4.5px] border-[1.5px] border-border-strong bg-surface-1",
                "transition-[background,border-color] duration-150 ease-out-quart",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                "data-[state=checked]:border-accent data-[state=checked]:bg-accent",
                "data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent",
                "disabled:pointer-events-none disabled:not-data-readonly:opacity-45",
                "data-readonly:cursor-default",
                className,
            )}
            {...props}>
            <CheckboxPrimitive.Indicator className="text-on-accent">
                {props.checked === "indeterminate" ? (
                    <Minus className="size-3" strokeWidth={3} />
                ) : (
                    <Check className="size-3" strokeWidth={3} />
                )}
            </CheckboxPrimitive.Indicator>
        </CheckboxPrimitive.Root>
    );
}
