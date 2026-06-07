import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "../lib/cn";
import { Spinner } from "./spinner";

const buttonVariants = cva(
    [
        "inline-flex items-center justify-center gap-[7px] rounded-md border border-transparent",
        "text-sm font-semibold tracking-[0.005em] whitespace-nowrap",
        "transition-[background,color,border-color,transform] duration-150 ease-out-quart",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "active:translate-y-[0.5px]",
        "disabled:pointer-events-none disabled:opacity-45",
        "data-[loading]:pointer-events-none",
    ],
    {
        variants: {
            variant: {
                primary:
                    "bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-down",
                secondary:
                    "border-border bg-surface-2 text-text-1 hover:border-border-strong hover:bg-surface-3",
                ghost: "text-text-2 hover:bg-surface-2 hover:text-text-1",
                danger: "bg-danger-soft text-danger hover:bg-danger hover:text-background",
            },
            size: {
                md: "h-8 px-3.5",
                sm: "h-7 px-2.5 text-[13px]",
                lg: "h-11 rounded-lg px-5 text-[15px]",
                icon: "size-8 px-0",
            },
        },
        defaultVariants: { variant: "primary", size: "md" },
    },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
    VariantProps<typeof buttonVariants> & {
        asChild?: boolean;
        loading?: boolean;
        leftIcon?: React.ReactNode;
        rightIcon?: React.ReactNode;
    };

export function Button({
    className,
    variant,
    size,
    asChild,
    loading,
    leftIcon,
    rightIcon,
    children,
    disabled,
    ...props
}: ButtonProps) {
    const Comp = asChild ? Slot.Root : "button";

    return (
        <Comp
            data-loading={loading ? "" : undefined}
            disabled={disabled ?? loading}
            className={cn(buttonVariants({ variant, size }), className)}
            {...props}>
            {loading ? <Spinner size="sm" variant="current" /> : leftIcon}
            <Slot.Slottable>{children}</Slot.Slottable>
            {rightIcon}
        </Comp>
    );
}

export { buttonVariants };
