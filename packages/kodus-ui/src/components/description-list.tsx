import { cn } from "../lib/cn";

/**
 * Key-value metadata grid: Path / Source / Scope rows on rule cards.
 * Columns divide with hairlines; values default to mono (paths, globs).
 */
export function DescriptionList({
    className,
    ...props
}: React.HTMLAttributes<HTMLDListElement>) {
    return (
        <dl
            className={cn(
                "grid grid-cols-2 gap-y-4 md:grid-cols-3",
                "*:border-l *:border-border *:px-3.5 *:first:border-l-0 *:first:pl-0",
                className,
            )}
            {...props}
        />
    );
}

export function DescriptionItem({
    label,
    mono = true,
    className,
    children,
    ...props
}: React.HTMLAttributes<HTMLDivElement> & {
    label: React.ReactNode;
    /** Paths/globs default to mono; set false for prose values. */
    mono?: boolean;
}) {
    return (
        <div className={cn("min-w-0", className)} {...props}>
            <dt className="text-[12.5px] font-semibold text-text-2">
                {label}
            </dt>
            <dd
                className={cn(
                    "mt-1 break-words text-text-1",
                    mono ? "font-mono text-xs" : "text-[13px]",
                )}>
                {children}
            </dd>
        </div>
    );
}
