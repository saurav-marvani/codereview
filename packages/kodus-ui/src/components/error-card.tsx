"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { CircleAlert, RefreshCw } from "lucide-react";

import { cn } from "../lib/cn";
import { Button } from "./button";

const errorCardVariants = cva("text-[13.5px]", {
    variants: {
        variant: {
            card: "flex flex-col items-center gap-2 rounded-lg border border-danger/35 bg-danger-soft px-6 py-8 text-center",
            inline: "flex items-center gap-2.5 rounded-md border border-danger/35 bg-danger-soft px-3.5 py-2.5",
            minimal: "flex items-center gap-2 text-danger",
        },
    },
    defaultVariants: { variant: "card" },
});

export type ErrorCardProps = React.HTMLAttributes<HTMLDivElement> &
    VariantProps<typeof errorCardVariants> & {
        message?: React.ReactNode;
        onRetry?: () => void;
        retryLabel?: string;
    };

export function ErrorCard({
    className,
    variant = "card",
    message = "Something went wrong.",
    onRetry,
    retryLabel = "Try again",
    ...props
}: ErrorCardProps) {
    return (
        <div
            role="alert"
            className={cn(errorCardVariants({ variant }), className)}
            {...props}>
            <CircleAlert
                className={cn(
                    "shrink-0 text-danger",
                    variant === "card" ? "size-5" : "size-4",
                )}
            />
            <span
                className={cn(
                    variant === "minimal" ? "text-danger" : "text-text-1",
                    "min-w-0",
                )}>
                {message}
            </span>
            {onRetry && (
                <Button
                    variant={variant === "card" ? "secondary" : "ghost"}
                    size="sm"
                    onClick={onRetry}
                    leftIcon={<RefreshCw className="size-3" />}
                    className={cn(
                        variant === "card" ? "mt-2" : "ml-auto shrink-0",
                    )}>
                    {retryLabel}
                </Button>
            )}
        </div>
    );
}
