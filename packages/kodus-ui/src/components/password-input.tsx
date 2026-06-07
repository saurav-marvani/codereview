"use client";

import { useState } from "react";
import { Check, Eye, EyeOff } from "lucide-react";

import { cn } from "../lib/cn";
import { Input, type InputProps } from "./input";

/** Input with a visibility toggle. */
export function PasswordInput({
    className,
    ...props
}: Omit<InputProps, "type" | "rightSlot">) {
    const [visible, setVisible] = useState(false);
    const Icon = visible ? EyeOff : Eye;

    return (
        <Input
            type={visible ? "text" : "password"}
            className={className}
            rightSlot={
                <button
                    type="button"
                    aria-label={visible ? "Hide password" : "Show password"}
                    aria-pressed={visible}
                    onClick={() => setVisible((current) => !current)}
                    className="grid shrink-0 place-items-center text-text-3 hover:text-text-1 focus-visible:rounded-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring">
                    <Icon className="size-4" />
                </button>
            }
            {...props}
        />
    );
}

/**
 * Validation pills under a field: "You must have at least: 8 characters…".
 * Pending = dot, met = green check, failed (after submit) = danger.
 */
export function RequirementList({
    title,
    requirements,
    invalid,
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement> & {
    title?: React.ReactNode;
    requirements: Array<{ label: string; met: boolean }>;
    /** Paint unmet requirements as errors (e.g. after submit). */
    invalid?: boolean;
}) {
    return (
        <div className={cn("text-[13px]", className)} {...props}>
            {title && <p className="mb-2 text-text-2">{title}</p>}
            <ul className="flex flex-wrap gap-1.5">
                {requirements.map(({ label, met }) => (
                    <li
                        key={label}
                        className={cn(
                            "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium",
                            "transition-colors duration-150 ease-out-quart",
                            met
                                ? "border-success/40 text-success"
                                : invalid
                                  ? "border-danger/40 text-danger"
                                  : "border-border-strong text-text-2",
                        )}>
                        {met ? (
                            <Check className="size-3" strokeWidth={3} />
                        ) : (
                            <span
                                aria-hidden
                                className="size-[5px] rounded-full bg-current"
                            />
                        )}
                        {label}
                    </li>
                ))}
            </ul>
        </div>
    );
}
