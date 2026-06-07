import { cn } from "../lib/cn";

/**
 * Wizard progress: a row of segments. Past = dim accent, current = accent,
 * upcoming = surface. Screen readers get "Step N of M".
 */
export function Steps({
    total,
    current,
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement> & {
    total: number;
    /** 1-based. */
    current: number;
}) {
    return (
        <div
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={total}
            aria-valuenow={current}
            aria-valuetext={`Step ${current} of ${total}`}
            className={cn("flex gap-2", className)}
            {...props}>
            {Array.from({ length: total }, (_, index) => {
                const step = index + 1;

                return (
                    <span
                        key={step}
                        className={cn(
                            "h-[5px] w-9 rounded-full transition-colors duration-200 ease-out-quart",
                            step === current
                                ? "bg-accent"
                                : step < current
                                  ? "bg-accent/35"
                                  : "bg-surface-2",
                        )}
                    />
                );
            })}
        </div>
    );
}
