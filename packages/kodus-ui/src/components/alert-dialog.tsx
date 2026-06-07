"use client";

import { AlertDialog as AlertDialogPrimitive } from "radix-ui";

import { cn } from "../lib/cn";
import { buttonVariants } from "./button";

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

export function AlertDialogContent({
    className,
    children,
    ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Content>) {
    return (
        <AlertDialogPrimitive.Portal>
            <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 animate-in-fade bg-overlay" />
            <AlertDialogPrimitive.Content
                className={cn(
                    "fixed top-1/2 left-1/2 z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2",
                    "animate-in-pop rounded-lg border border-border-strong bg-surface-1 p-6 shadow-pop",
                    "focus:outline-none",
                    className,
                )}
                {...props}>
                {children}
            </AlertDialogPrimitive.Content>
        </AlertDialogPrimitive.Portal>
    );
}

export function AlertDialogTitle({
    className,
    ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Title>) {
    return (
        <AlertDialogPrimitive.Title
            className={cn(
                "text-base font-bold tracking-[-0.01em] text-text-1",
                className,
            )}
            {...props}
        />
    );
}

export function AlertDialogDescription({
    className,
    ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Description>) {
    return (
        <AlertDialogPrimitive.Description
            className={cn("mt-2 text-sm text-text-2", className)}
            {...props}
        />
    );
}

export function AlertDialogFooter({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn("mt-6 flex justify-end gap-2", className)}
            {...props}
        />
    );
}

export function AlertDialogCancel({
    className,
    ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Cancel>) {
    return (
        <AlertDialogPrimitive.Cancel
            className={cn(buttonVariants({ variant: "ghost" }), className)}
            {...props}
        />
    );
}

export function AlertDialogAction({
    className,
    destructive,
    ...props
}: React.ComponentProps<typeof AlertDialogPrimitive.Action> & {
    /** Destructive confirm (delete) — danger styling. */
    destructive?: boolean;
}) {
    return (
        <AlertDialogPrimitive.Action
            className={cn(
                buttonVariants({
                    variant: destructive ? "danger" : "primary",
                }),
                className,
            )}
            {...props}
        />
    );
}
