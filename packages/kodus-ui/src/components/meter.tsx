import { cn } from "../lib/cn";

/**
 * Labeled usage bar: "Monthly spend limit — $0 of $1 · 0%".
 * Bar shifts to warning past `warnAt` and danger past `dangerAt`.
 */
export function Meter({
    label,
    value,
    max,
    formatValue = (current, total) => `${current} of ${total}`,
    warnAt = 0.75,
    dangerAt = 0.95,
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement> & {
    label: React.ReactNode;
    value: number;
    max: number;
    formatValue?: (value: number, max: number) => React.ReactNode;
    warnAt?: number;
    dangerAt?: number;
}) {
    const ratio = max > 0 ? Math.min(1, value / max) : 0;
    const tone =
        ratio >= dangerAt
            ? "bg-danger"
            : ratio >= warnAt
              ? "bg-warning"
              : "bg-accent";

    return (
        <div className={cn("min-w-0", className)} {...props}>
            <div className="flex items-baseline gap-2 text-[13px]">
                <span className="font-semibold text-text-2">{label}</span>
                <span className="ml-auto font-mono text-xs text-text-1 tabular-nums">
                    {formatValue(value, max)}
                </span>
                <span className="font-mono text-xs text-text-3 tabular-nums">
                    {Math.round(ratio * 100)}%
                </span>
            </div>
            <div
                role="meter"
                aria-valuenow={value}
                aria-valuemin={0}
                aria-valuemax={max}
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                    className={cn(
                        "h-full rounded-full transition-[width] duration-250 ease-out-quart",
                        tone,
                    )}
                    style={{ width: `${ratio * 100}%` }}
                />
            </div>
        </div>
    );
}
