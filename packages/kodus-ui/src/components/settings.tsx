import { cn } from "../lib/cn";
import { Locked } from "./locked";

/**
 * Settings page pattern: related settings share one card with internal
 * dividers. A group per concern — never one floating card per toggle.
 */
export function SettingsGroup({
    title,
    description,
    className,
    children,
    ...props
}: React.HTMLAttributes<HTMLDivElement> & {
    title?: React.ReactNode;
    description?: React.ReactNode;
}) {
    return (
        <div
            className={cn(
                "overflow-hidden rounded-lg border border-border bg-surface-1",
                className,
            )}
            {...props}>
            {title && (
                <div className="flex items-baseline gap-2.5 border-b border-border bg-surface-2 px-[18px] py-[13px]">
                    <h4 className="text-[13.5px] font-semibold text-text-1">
                        {title}
                    </h4>
                    {description && (
                        <span className="text-xs text-text-3">
                            {description}
                        </span>
                    )}
                </div>
            )}
            <div className="divide-y divide-border">{children}</div>
        </div>
    );
}

export function Setting({
    title,
    description,
    note,
    control,
    disabled,
    lockedReason,
    className,
    children,
    ...props
}: React.HTMLAttributes<HTMLDivElement> & {
    title: React.ReactNode;
    description?: React.ReactNode;
    /** Small tertiary line under the description. */
    note?: React.ReactNode;
    /** Rendered on the right, vertically centered: switch, select, badge+switch... */
    control?: React.ReactNode;
    disabled?: boolean;
    /** RBAC view-only: wraps the control in <Locked> with this reason. Text stays fully legible. */
    lockedReason?: React.ReactNode;
}) {
    return (
        <div
            className={cn("flex items-center gap-6 px-[18px] py-[15px]", className)}
            {...props}>
            <div className={cn("min-w-0 flex-1", disabled && "opacity-50")}>
                <h5 className="text-sm font-semibold text-text-1">{title}</h5>
                {description && (
                    <p className="mt-[3px] max-w-[62ch] text-[13px] text-text-2">
                        {description}
                    </p>
                )}
                {note && (
                    <p className="mt-[5px] text-xs text-text-3">{note}</p>
                )}
                {children && (
                    <div className="mt-3 rounded-md border border-border bg-background px-3.5 py-3">
                        {children}
                    </div>
                )}
            </div>
            {control && (
                <div className="flex shrink-0 items-center gap-2.5">
                    {lockedReason ? (
                        <Locked reason={lockedReason}>{control}</Locked>
                    ) : (
                        control
                    )}
                </div>
            )}
        </div>
    );
}
