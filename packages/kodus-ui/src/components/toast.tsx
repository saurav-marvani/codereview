"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";

import { cn } from "../lib/cn";

export type ToastVariant = "success" | "error" | "info";

export type ToastOptions = {
    title: React.ReactNode;
    description?: React.ReactNode;
    variant?: ToastVariant;
    /** Trailing action button. */
    action?: { label: string; onClick: () => void };
    /** ms before auto-dismiss. 0 disables. */
    duration?: number;
};

type ToastEntry = ToastOptions & { id: number };

let nextId = 0;
let entries: ToastEntry[] = [];
const listeners = new Set<(toasts: ToastEntry[]) => void>();

function emit() {
    for (const listener of listeners) listener(entries);
}

/** Imperative API: `toast({ title: "Review completed", variant: "success" })` */
export function toast(options: ToastOptions) {
    const id = nextId++;
    entries = [...entries, { id, ...options }];
    emit();

    const duration = options.duration ?? 5000;
    if (duration > 0) setTimeout(() => dismissToast(id), duration);

    return id;
}

export function dismissToast(id: number) {
    entries = entries.filter((entry) => entry.id !== id);
    emit();
}

const icons: Record<ToastVariant, { Icon: typeof Info; color: string }> = {
    success: { Icon: CheckCircle2, color: "text-success" },
    error: { Icon: XCircle, color: "text-danger" },
    info: { Icon: Info, color: "text-info" },
};

/** Mount once, app-root level. Renders the bottom-right stack. */
export function Toaster() {
    const [toasts, setToasts] = useState<ToastEntry[]>(entries);

    useEffect(() => {
        listeners.add(setToasts);
        return () => {
            listeners.delete(setToasts);
        };
    }, []);

    return (
        <div className="fixed right-4 bottom-4 z-[100] flex w-[360px] flex-col gap-2.5">
            {toasts.map(({ id, title, description, variant, action }) => {
                const { Icon, color } = icons[variant ?? "info"];

                return (
                    <div
                        key={id}
                        role="status"
                        className={cn(
                            "flex animate-in-pop items-start gap-[11px] rounded-md border border-border-strong bg-surface-2 px-3.5 py-3 shadow-pop",
                        )}>
                        <Icon className={cn("mt-px size-4 shrink-0", color)} />
                        <div className="min-w-0 flex-1">
                            <h5 className="text-[13.5px] font-semibold text-text-1">
                                {title}
                            </h5>
                            {description && (
                                <p className="mt-0.5 text-[12.5px] text-text-2">
                                    {description}
                                </p>
                            )}
                        </div>
                        {action && (
                            <button
                                onClick={() => {
                                    action.onClick();
                                    dismissToast(id);
                                }}
                                className="shrink-0 self-center text-[12.5px] font-semibold text-accent hover:text-accent-hover">
                                {action.label}
                            </button>
                        )}
                        <button
                            aria-label="Dismiss"
                            onClick={() => dismissToast(id)}
                            className="shrink-0 text-text-3 hover:text-text-1">
                            <X className="size-3.5" />
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
