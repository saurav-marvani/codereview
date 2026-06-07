"use client";

import { Slot } from "radix-ui";

import { cn } from "../lib/cn";

export function Navbar({
    className,
    ...props
}: React.HTMLAttributes<HTMLElement>) {
    return (
        <header
            className={cn(
                "flex h-14 items-center gap-6 border-b border-border bg-surface-1 px-5",
                className,
            )}
            {...props}
        />
    );
}

export function NavbarBrand({
    className,
    asChild,
    ...props
}: React.HTMLAttributes<HTMLElement> & { asChild?: boolean }) {
    const Comp = asChild ? Slot.Root : "div";

    return (
        <Comp
            className={cn(
                "flex shrink-0 items-center gap-2 text-[15px] font-bold tracking-[-0.01em] text-text-1",
                className,
            )}
            {...props}
        />
    );
}

export function NavbarNav({
    className,
    ...props
}: React.HTMLAttributes<HTMLElement>) {
    return (
        <nav
            className={cn("flex min-w-0 items-center gap-1", className)}
            {...props}
        />
    );
}

export type NavbarItemProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
    asChild?: boolean;
    active?: boolean;
    icon?: React.ReactNode;
    /** Trailing slot: count pill, Beta tag. */
    badge?: React.ReactNode;
};

export function NavbarItem({
    className,
    asChild,
    active,
    icon,
    badge,
    children,
    ...props
}: NavbarItemProps) {
    const Comp = asChild ? Slot.Root : "button";

    return (
        <Comp
            data-active={active ? "" : undefined}
            aria-current={active ? "page" : undefined}
            className={cn(
                "flex h-8 items-center gap-2 rounded-sm px-2.5",
                "text-[13.5px] font-medium whitespace-nowrap text-text-2",
                "transition-colors duration-120 ease-out-quart",
                "hover:bg-surface-2 hover:text-text-1",
                "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                "data-active:bg-accent-soft data-active:font-semibold data-active:text-accent",
                className,
            )}
            {...props}>
            {icon && (
                <span className="grid place-items-center text-text-3 in-data-active:text-accent">
                    {icon}
                </span>
            )}
            <Slot.Slottable>{children}</Slot.Slottable>
            {badge}
        </Comp>
    );
}

/** Right-aligned action cluster: bell, plan badge, user menu. */
export function NavbarActions({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn(
                "ml-auto flex shrink-0 items-center gap-2",
                className,
            )}
            {...props}
        />
    );
}

/** Wraps an icon button (or anything) with an unread indicator dot. */
export function IndicatorDot({
    show = true,
    className,
    children,
    ...props
}: React.HTMLAttributes<HTMLSpanElement> & { show?: boolean }) {
    return (
        <span className={cn("relative inline-flex", className)} {...props}>
            {children}
            {show && (
                <span className="absolute top-1 right-1 size-2 rounded-full border-2 border-surface-1 bg-accent" />
            )}
        </span>
    );
}
