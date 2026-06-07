import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/cn";

const badgeVariants = cva(
    "inline-flex h-[22px] items-center gap-[5px] rounded-full px-[9px] text-[11.5px] font-semibold",
    {
        variants: {
            variant: {
                critical: "bg-danger-soft text-danger",
                high: "bg-warning-soft text-warning",
                medium: "bg-info-soft text-info",
                low: "bg-surface-2 text-text-2",
                success: "bg-success-soft text-success",
                violet: "bg-violet-soft text-violet",
                alert: "bg-alert-soft text-alert",
                accent: "bg-accent-soft text-accent",
            },
        },
        defaultVariants: { variant: "low" },
    },
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> &
    VariantProps<typeof badgeVariants> & {
        /** Status dot. Omit when the badge is a label, not a state. */
        dot?: boolean;
    };

export function Badge({
    className,
    variant,
    dot = true,
    children,
    ...props
}: BadgeProps) {
    return (
        <span className={cn(badgeVariants({ variant }), className)} {...props}>
            {dot && (
                <span
                    aria-hidden
                    className="size-[5px] rounded-full bg-current"
                />
            )}
            {children}
        </span>
    );
}

export { badgeVariants };
