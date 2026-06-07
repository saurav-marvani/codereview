import { cn } from "../lib/cn";

/**
 * Dashboard KPI tile: icon + label + value. Value is mono/tabular.
 * Keep them in a row of equals; never one giant hero number.
 */
export function StatCard({
    icon,
    label,
    value,
    hint,
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement> & {
    icon?: React.ReactNode;
    label: React.ReactNode;
    value: React.ReactNode;
    /** Small trailing slot: help tip, delta, unit. */
    hint?: React.ReactNode;
}) {
    return (
        <div
            className={cn(
                "rounded-lg border border-border bg-surface-1 px-4 py-3.5",
                className,
            )}
            {...props}>
            <div className="flex items-center gap-2 text-[12.5px] font-medium text-text-2">
                {icon && (
                    <span className="grid size-5 place-items-center text-text-3">
                        {icon}
                    </span>
                )}
                {label}
                {hint && <span className="ml-auto">{hint}</span>}
            </div>
            <div className="mt-1.5 font-mono text-[22px] font-semibold tracking-[-0.01em] text-text-1 tabular-nums">
                {value}
            </div>
        </div>
    );
}

export function StatCardRow({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn(
                "grid grid-cols-2 gap-3 lg:grid-cols-4",
                className,
            )}
            {...props}
        />
    );
}
