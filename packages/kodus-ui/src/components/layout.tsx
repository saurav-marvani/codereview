import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "../lib/cn";

const headingVariants = cva("font-sans text-text-1", {
    variants: {
        level: {
            display: "text-[26px] font-bold tracking-[-0.02em]",
            h1: "text-[22px] font-bold tracking-[-0.015em]",
            h2: "text-lg font-[650]",
            h3: "text-[15.5px] font-semibold",
        },
    },
    defaultVariants: { level: "h2" },
});

export type HeadingProps = React.HTMLAttributes<HTMLHeadingElement> &
    VariantProps<typeof headingVariants> & {
        as?: "h1" | "h2" | "h3" | "h4";
    };

export function Heading({
    className,
    level,
    as: Comp = "h2",
    ...props
}: HeadingProps) {
    return (
        <Comp
            className={cn(headingVariants({ level }), className)}
            {...props}
        />
    );
}

/**
 * Page layout compound (mirrors apps/web Page.* — 400+ call sites).
 * Root scrolls; Header/Content share the same centered column.
 */
function PageRoot({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn(
                "flex min-h-0 flex-1 flex-col overflow-y-auto",
                className,
            )}
            {...props}
        />
    );
}

function PageHeaderContainer({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn(
                "mx-auto flex w-full max-w-[1180px] flex-col gap-2 px-8 pt-7",
                className,
            )}
            {...props}
        />
    );
}

function PageTitleContainer({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn("flex items-end gap-4", className)}
            {...props}
        />
    );
}

function PageTitle({
    className,
    ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
    return <Heading level="h1" as="h1" className={className} {...props} />;
}

function PageDescription({
    className,
    ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
    return (
        <p
            className={cn(
                "max-w-[70ch] text-[13px] text-text-2",
                className,
            )}
            {...props}
        />
    );
}

function PageHeaderActions({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn("ml-auto flex shrink-0 gap-2", className)}
            {...props}
        />
    );
}

function PageContent({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn(
                "mx-auto flex w-full max-w-[1180px] flex-1 flex-col gap-6 px-8 py-6",
                className,
            )}
            {...props}
        />
    );
}

function PageFooter({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn(
                "mx-auto flex w-full max-w-[1180px] items-center gap-2 border-t border-border px-8 py-4",
                className,
            )}
            {...props}
        />
    );
}

/** Content column that sits next to a <Sidebar>. */
function PageWithSidebar({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn(
                "flex min-w-0 flex-1 flex-col overflow-y-auto",
                className,
            )}
            {...props}
        />
    );
}

export const Page = {
    Root: PageRoot,
    Header: PageHeaderContainer,
    TitleContainer: PageTitleContainer,
    Title: PageTitle,
    Description: PageDescription,
    HeaderActions: PageHeaderActions,
    Content: PageContent,
    Footer: PageFooter,
    WithSidebar: PageWithSidebar,
};

export function Section({
    title,
    description,
    className,
    children,
    ...props
}: React.HTMLAttributes<HTMLElement> & {
    title?: React.ReactNode;
    description?: React.ReactNode;
}) {
    return (
        <section className={cn("mt-10 first:mt-0", className)} {...props}>
            {title && (
                <Heading level="h3" as="h3">
                    {title}
                </Heading>
            )}
            {description && (
                <p className="mt-1 max-w-[70ch] text-[13px] text-text-2">
                    {description}
                </p>
            )}
            <div className={cn((title || description) && "mt-4")}>
                {children}
            </div>
        </section>
    );
}

export function TextLink({
    className,
    asChild,
    ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { asChild?: boolean }) {
    const Comp = asChild ? Slot.Root : "a";

    return (
        <Comp
            className={cn(
                "font-medium text-accent underline-offset-2 hover:text-accent-hover hover:underline",
                "focus-visible:rounded-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                className,
            )}
            {...props}
        />
    );
}

export function EmptyState({
    icon,
    title,
    description,
    action,
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement> & {
    icon?: React.ReactNode;
    title: React.ReactNode;
    description?: React.ReactNode;
    action?: React.ReactNode;
}) {
    return (
        <div
            className={cn(
                "flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border-strong px-6 py-12 text-center",
                className,
            )}
            {...props}>
            {icon && (
                <div className="mb-1 text-[22px] text-text-3">{icon}</div>
            )}
            <h4 className="text-[15px] font-semibold text-text-1">{title}</h4>
            {description && (
                <p className="max-w-[42ch] text-[13px] text-text-2">
                    {description}
                </p>
            )}
            {action && <div className="mt-3">{action}</div>}
        </div>
    );
}
