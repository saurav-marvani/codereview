import { Separator as SeparatorPrimitive } from "radix-ui";

import { cn } from "../lib/cn";
import { Spinner } from "./spinner";

export function Skeleton({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            aria-hidden
            className={cn(
                "relative overflow-hidden rounded-sm bg-surface-2",
                "after:absolute after:inset-0 after:animate-shimmer after:bg-gradient-to-r after:from-transparent after:via-shimmer after:to-transparent",
                "motion-reduce:after:animate-none",
                className,
            )}
            {...props}
        />
    );
}

export function Separator({
    className,
    orientation = "horizontal",
    dashed,
    ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root> & {
    dashed?: boolean;
}) {
    return (
        <SeparatorPrimitive.Root
            orientation={orientation}
            className={cn(
                dashed
                    ? orientation === "horizontal"
                        ? "w-full border-t border-dashed border-border"
                        : "h-full border-l border-dashed border-border"
                    : cn(
                          "bg-border",
                          orientation === "horizontal"
                              ? "h-px w-full"
                              : "h-full w-px",
                      ),
                className,
            )}
            {...props}
        />
    );
}

/** Centered loading block for content areas (the old GenericLoading). */
export function LoadingState({
    className,
    children = "Doing some magic…",
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn(
                "flex flex-col items-center justify-center gap-3 py-12",
                className,
            )}
            {...props}>
            <Spinner size="lg" />
            <span className="text-[13px] text-text-2">{children}</span>
        </div>
    );
}

/** Divider with centered text: "Or sign in with". */
export function SeparatorWithLabel({
    className,
    children,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            role="separator"
            className={cn(
                "flex items-center gap-4 text-[13px] text-text-2",
                "before:h-px before:flex-1 before:bg-border",
                "after:h-px after:flex-1 after:bg-border",
                className,
            )}
            {...props}>
            {children}
        </div>
    );
}

export function Kbd({
    className,
    ...props
}: React.HTMLAttributes<HTMLElement>) {
    return (
        <kbd
            className={cn(
                "rounded-[5px] border border-border-strong border-b-2 bg-surface-1 px-[7px] py-0.5",
                "font-mono text-[11px] text-text-2",
                className,
            )}
            {...props}
        />
    );
}

export function InlineCode({
    className,
    ...props
}: React.HTMLAttributes<HTMLElement>) {
    return (
        <code
            className={cn(
                "rounded border border-border bg-surface-2 px-[5px] py-px",
                "font-mono text-xs text-text-1",
                className,
            )}
            {...props}
        />
    );
}

export function Progress({
    value,
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement> & { value: number }) {
    return (
        <div
            role="progressbar"
            aria-valuenow={value}
            aria-valuemin={0}
            aria-valuemax={100}
            className={cn(
                "h-1.5 overflow-hidden rounded-full bg-surface-2",
                className,
            )}
            {...props}>
            <div
                className="h-full rounded-full bg-accent transition-[width] duration-250 ease-out-quart"
                style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
            />
        </div>
    );
}
