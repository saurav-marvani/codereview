import { cva, type VariantProps } from "class-variance-authority";
import {
    AlertTriangle,
    CheckCircle2,
    Info,
    XCircle,
    type LucideIcon,
} from "lucide-react";

import { cn } from "../lib/cn";

const alertVariants = cva(
    "flex items-start gap-[11px] rounded-md border px-3.5 py-3 text-[13.5px]",
    {
        variants: {
            variant: {
                info: "border-info/35 bg-info-soft",
                warning: "border-warning/35 bg-warning-soft",
                danger: "border-danger/35 bg-danger-soft",
                success: "border-success/35 bg-success-soft",
            },
        },
        defaultVariants: { variant: "info" },
    },
);

const icons: Record<string, { Icon: LucideIcon; color: string }> = {
    info: { Icon: Info, color: "text-info" },
    warning: { Icon: AlertTriangle, color: "text-warning" },
    danger: { Icon: XCircle, color: "text-danger" },
    success: { Icon: CheckCircle2, color: "text-success" },
};

export type AlertProps = React.HTMLAttributes<HTMLDivElement> &
    VariantProps<typeof alertVariants>;

export function Alert({
    className,
    variant = "info",
    children,
    ...props
}: AlertProps) {
    const { Icon, color } = icons[variant ?? "info"];

    return (
        <div
            role="alert"
            className={cn(alertVariants({ variant }), className)}
            {...props}>
            <Icon className={cn("mt-px size-4 shrink-0", color)} />
            <div className="min-w-0">{children}</div>
        </div>
    );
}

export function AlertTitle({
    className,
    ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
    return (
        <h5
            className={cn("text-[13.5px] font-semibold text-text-1", className)}
            {...props}
        />
    );
}

export function AlertDescription({
    className,
    ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
    return (
        <p
            className={cn("mt-0.5 text-[13px] text-text-2", className)}
            {...props}
        />
    );
}
