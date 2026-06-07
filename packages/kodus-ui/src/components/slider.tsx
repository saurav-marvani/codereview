"use client";

import { Slider as SliderPrimitive } from "radix-ui";

import { cn } from "../lib/cn";

export function Slider({
    className,
    ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
    return (
        <SliderPrimitive.Root
            className={cn(
                "relative flex h-5 w-full max-w-[380px] touch-none items-center select-none",
                "data-disabled:opacity-45",
                className,
            )}
            {...props}>
            <SliderPrimitive.Track className="relative h-[5px] grow rounded-full bg-surface-2">
                <SliderPrimitive.Range className="absolute h-full rounded-full bg-accent" />
            </SliderPrimitive.Track>
            <SliderPrimitive.Thumb
                className={cn(
                    "block size-4 rounded-full border-[3px] border-background bg-accent",
                    "shadow-[0_0_0_1px_var(--color-border-strong)]",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                )}
            />
        </SliderPrimitive.Root>
    );
}

/**
 * Discrete slider with labeled stops: the severity picker
 * (Low · Medium · High · Critical). Value is the mark index.
 */
export function SliderWithMarks({
    marks,
    value,
    onValueChange,
    className,
    ...props
}: Omit<
    React.ComponentProps<typeof SliderPrimitive.Root>,
    "value" | "onValueChange" | "min" | "max" | "step"
> & {
    marks: string[];
    value: number;
    onValueChange: (index: number) => void;
}) {
    return (
        <div className={cn("w-full max-w-[440px]", className)}>
            <SliderPrimitive.Root
                min={0}
                max={marks.length - 1}
                step={1}
                value={[value]}
                onValueChange={([next]) => onValueChange(next)}
                className="relative flex h-5 w-full touch-none items-center select-none data-disabled:opacity-45"
                {...props}>
                <SliderPrimitive.Track className="relative h-[5px] grow rounded-full bg-surface-2">
                    <SliderPrimitive.Range className="absolute h-full rounded-full bg-accent" />
                    {marks.map((_, index) => (
                        <span
                            key={index}
                            aria-hidden
                            className={cn(
                                "absolute top-1/2 size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full",
                                index <= value
                                    ? "bg-accent-down"
                                    : "bg-surface-3",
                            )}
                            style={{
                                left: `${(index / (marks.length - 1)) * 100}%`,
                            }}
                        />
                    ))}
                </SliderPrimitive.Track>
                <SliderPrimitive.Thumb
                    aria-valuetext={marks[value]}
                    className={cn(
                        "block size-4 rounded-full border-[3px] border-background bg-accent",
                        "shadow-[0_0_0_1px_var(--color-border-strong)]",
                        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    )}
                />
            </SliderPrimitive.Root>
            <div className="mt-1.5 flex justify-between">
                {marks.map((mark, index) => (
                    <button
                        key={mark}
                        type="button"
                        onClick={() => onValueChange(index)}
                        className={cn(
                            "text-xs transition-colors duration-150 ease-out-quart",
                            "first:-translate-x-1 last:translate-x-1",
                            index === value
                                ? "font-semibold text-text-1"
                                : "text-text-3 hover:text-text-2",
                        )}>
                        {mark}
                    </button>
                ))}
            </div>
        </div>
    );
}
