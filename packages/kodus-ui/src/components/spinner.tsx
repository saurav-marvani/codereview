import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/cn";

const spinnerVariants = cva(
    "inline-block animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-[spin_2s_linear_infinite]",
    {
        variants: {
            size: {
                sm: "size-[13px]",
                md: "size-4",
                lg: "size-6 border-[2.5px]",
            },
            variant: {
                accent: "text-accent",
                muted: "text-text-3",
                current: "",
            },
        },
        defaultVariants: { size: "md", variant: "accent" },
    },
);

export type SpinnerProps = React.HTMLAttributes<HTMLSpanElement> &
    VariantProps<typeof spinnerVariants>;

export function Spinner({ className, size, variant, ...props }: SpinnerProps) {
    return (
        <span
            role="status"
            aria-label="Loading"
            className={cn(spinnerVariants({ size, variant }), className)}
            {...props}
        />
    );
}
