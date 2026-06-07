"use client";

import { Dialog as DialogPrimitive } from "radix-ui";

import { cn } from "../lib/cn";

export const Sheet = DialogPrimitive.Root;
export const SheetTrigger = DialogPrimitive.Trigger;
export const SheetClose = DialogPrimitive.Close;
export const SheetTitle = DialogPrimitive.Title;
export const SheetDescription = DialogPrimitive.Description;

export function SheetContent({
    className,
    side = "right",
    children,
    ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
    side?: "right" | "left";
}) {
    return (
        <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay className="fixed inset-0 z-50 animate-in-fade bg-overlay" />
            <DialogPrimitive.Content
                className={cn(
                    "fixed top-0 z-50 flex h-full w-[min(440px,calc(100vw-48px))] flex-col",
                    "border-border-strong bg-surface-1 p-6 shadow-pop",
                    "animate-in-fade focus:outline-none",
                    side === "right" ? "right-0 border-l" : "left-0 border-r",
                    className,
                )}
                {...props}>
                {children}
            </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
    );
}
