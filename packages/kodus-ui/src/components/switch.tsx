"use client";

import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "../lib/cn";

export type SwitchProps = React.ComponentProps<
    typeof SwitchPrimitive.Root
> & {
    loading?: boolean;
    /** Value is visible but not changeable (e.g. RBAC view-only). Full legibility, no interaction. */
    readOnly?: boolean;
};

export function Switch({
    className,
    loading,
    readOnly,
    ...props
}: SwitchProps) {
    return (
        <SwitchPrimitive.Root
            data-loading={loading ? "" : undefined}
            data-readonly={readOnly ? "" : undefined}
            aria-readonly={readOnly}
            disabled={props.disabled ?? (loading || readOnly)}
            className={cn(
                "relative h-5 w-9 shrink-0 rounded-full bg-surface-3",
                "transition-colors duration-180 ease-out-quart",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                "data-[state=checked]:bg-accent",
                "disabled:not-data-loading:not-data-readonly:opacity-45",
                "data-readonly:cursor-default",
                className,
            )}
            {...props}>
            <SwitchPrimitive.Thumb
                className={cn(
                    "block size-4 translate-x-0.5 rounded-full bg-text-2",
                    "transition-transform duration-180 ease-out-quart",
                    "data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-on-accent",
                    "in-data-loading:animate-spin in-data-loading:border-2 in-data-loading:border-text-2 in-data-loading:border-t-transparent in-data-loading:bg-transparent in-data-[state=checked]:in-data-loading:border-on-accent in-data-[state=checked]:in-data-loading:border-t-transparent",
                )}
            />
        </SwitchPrimitive.Root>
    );
}
