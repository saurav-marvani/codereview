"use client";

import { Minus, Plus } from "lucide-react";

import { cn } from "../lib/cn";

export type NumberInputProps = Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "value" | "onChange" | "type"
> & {
    value: number;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    step?: number;
};

export function NumberInput({
    className,
    value,
    onChange,
    min = -Infinity,
    max = Infinity,
    step = 1,
    disabled,
    ...props
}: NumberInputProps) {
    const clamp = (next: number) => Math.min(max, Math.max(min, next));

    return (
        <div
            data-disabled={disabled ? "" : undefined}
            className={cn(
                "flex h-[34px] w-[140px] items-stretch overflow-hidden rounded-md border border-border bg-surface-1",
                "transition-[border-color,box-shadow] duration-150 ease-out-quart",
                "hover:border-border-strong",
                "focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--color-ring)]",
                "data-disabled:pointer-events-none data-disabled:opacity-45",
                className,
            )}>
            <button
                type="button"
                aria-label="Decrease"
                disabled={disabled || value <= min}
                onClick={() => onChange(clamp(value - step))}
                className="grid w-9 place-items-center text-text-3 transition-colors duration-120 hover:bg-surface-2 hover:text-text-1 disabled:pointer-events-none disabled:opacity-45">
                <Minus className="size-3.5" />
            </button>
            <input
                type="text"
                inputMode="numeric"
                value={value}
                disabled={disabled}
                onChange={(event) => {
                    const parsed = Number(event.target.value);
                    if (!Number.isNaN(parsed)) onChange(clamp(parsed));
                }}
                className="min-w-0 flex-1 border-x border-border bg-transparent text-center font-mono text-[13px] text-text-1 tabular-nums outline-none"
                {...props}
            />
            <button
                type="button"
                aria-label="Increase"
                disabled={disabled || value >= max}
                onClick={() => onChange(clamp(value + step))}
                className="grid w-9 place-items-center text-text-3 transition-colors duration-120 hover:bg-surface-2 hover:text-text-1 disabled:pointer-events-none disabled:opacity-45">
                <Plus className="size-3.5" />
            </button>
        </div>
    );
}
