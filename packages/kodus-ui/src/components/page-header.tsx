import { ChevronRight } from "lucide-react";

import { cn } from "../lib/cn";

export function Breadcrumb({
    className,
    children,
    ...props
}: React.HTMLAttributes<HTMLElement>) {
    return (
        <nav
            aria-label="Breadcrumb"
            className={cn("flex items-center gap-2 text-[13px]", className)}
            {...props}>
            {children}
        </nav>
    );
}

export function BreadcrumbLink({
    className,
    ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
    return (
        <a
            className={cn(
                "font-medium text-accent no-underline hover:text-accent-hover",
                className,
            )}
            {...props}
        />
    );
}

export function BreadcrumbSeparator() {
    return <ChevronRight aria-hidden className="size-3 text-text-3" />;
}

export function BreadcrumbCurrent({
    className,
    ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
    return (
        <span
            aria-current="page"
            className={cn("font-semibold text-text-1", className)}
            {...props}
        />
    );
}

export function PageHeader({
    title,
    description,
    actions,
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement> & {
    title: React.ReactNode;
    description?: React.ReactNode;
    actions?: React.ReactNode;
}) {
    return (
        <div
            className={cn("flex items-end gap-4", className)}
            {...props}>
            <div>
                <h2 className="text-[22px] font-bold tracking-[-0.015em] text-text-1">
                    {title}
                </h2>
                {description && (
                    <p className="mt-[3px] text-[13px] text-text-2">
                        {description}
                    </p>
                )}
            </div>
            {actions && (
                <div className="ml-auto flex shrink-0 gap-2">{actions}</div>
            )}
        </div>
    );
}
