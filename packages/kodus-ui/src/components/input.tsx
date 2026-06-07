import { cn } from "../lib/cn";
import { Spinner } from "./spinner";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
    leftSlot?: React.ReactNode;
    rightSlot?: React.ReactNode;
    /** Async validation/lookup in flight: spinner in the right slot, input stays readable. */
    loading?: boolean;
};

export function Input({
    className,
    leftSlot,
    rightSlot,
    disabled,
    loading,
    readOnly,
    "aria-invalid": ariaInvalid,
    ...props
}: InputProps) {
    return (
        <div
            data-disabled={disabled ? "" : undefined}
            data-loading={loading ? "" : undefined}
            data-invalid={ariaInvalid ? "" : undefined}
            className={cn(
                "flex h-[34px] items-center gap-2 rounded-md border border-border bg-surface-1 px-3",
                "transition-[border-color,box-shadow] duration-150 ease-out-quart",
                "hover:border-border-strong",
                "focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--color-ring)]",
                "data-invalid:border-danger data-invalid:focus-within:shadow-[0_0_0_3px_var(--color-danger-soft)]",
                "data-disabled:pointer-events-none data-disabled:opacity-45",
                "data-loading:pointer-events-none",
                readOnly && "bg-surface-2 focus-within:border-border focus-within:shadow-none",
                className,
            )}>
            {leftSlot}
            <input
                className="min-w-0 flex-1 bg-transparent text-sm text-text-1 outline-none read-only:text-text-2 placeholder:text-text-3"
                disabled={disabled}
                readOnly={readOnly ?? loading}
                aria-invalid={ariaInvalid}
                aria-busy={loading}
                {...props}
            />
            {loading ? <Spinner size="sm" variant="muted" /> : rightSlot}
        </div>
    );
}

export function Textarea({
    className,
    ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
    return (
        <textarea
            className={cn(
                "min-h-[88px] w-full resize-y rounded-md border border-border bg-surface-1 px-3 py-2.5",
                "text-sm leading-[1.55] text-text-1 outline-none placeholder:text-text-3",
                "transition-[border-color,box-shadow] duration-150 ease-out-quart",
                "hover:border-border-strong",
                "focus:border-accent focus:shadow-[0_0_0_3px_var(--color-ring)]",
                "aria-invalid:border-danger aria-invalid:focus:shadow-[0_0_0_3px_var(--color-danger-soft)]",
                "read-only:bg-surface-2 read-only:text-text-2 read-only:focus:border-border read-only:focus:shadow-none",
                "disabled:pointer-events-none disabled:opacity-45",
                className,
            )}
            {...props}
        />
    );
}

export function Label({
    className,
    ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
    return (
        <label
            className={cn("text-[13px] font-semibold text-text-2", className)}
            {...props}
        />
    );
}

export function Field({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn("flex max-w-[380px] flex-col gap-1.5", className)}
            {...props}
        />
    );
}

export function FieldHint({
    className,
    ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
    return (
        <p className={cn("text-xs text-text-3", className)} {...props} />
    );
}

export function FieldError({
    className,
    ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
    return (
        <p className={cn("text-xs text-danger", className)} {...props} />
    );
}
