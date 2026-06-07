"use client";

import { createContext, useContext, useId } from "react";
import {
    Controller,
    FormProvider,
    useFormContext,
    useFormState,
    type ControllerProps,
    type FieldPath,
    type FieldValues,
} from "react-hook-form";
import { Slot } from "radix-ui";

import { cn } from "../lib/cn";

/**
 * react-hook-form binding (shadcn-style). Usage:
 *
 *   const form = useForm()
 *   <Form {...form}>
 *     <FormField control={form.control} name="webhookUrl" render={({ field }) => (
 *       <FormItem>
 *         <FormLabel>Webhook URL</FormLabel>
 *         <FormControl><Input {...field} /></FormControl>
 *         <FormDescription>Called on every review.</FormDescription>
 *         <FormMessage />
 *       </FormItem>
 *     )} />
 *   </Form>
 *
 * FormControl wires id/aria-describedby/aria-invalid into whatever single
 * child it wraps — Input, Select trigger, Switch, Combobox trigger…
 */
export const Form = FormProvider;

type FormFieldContextValue = { name: string };
const FormFieldContext = createContext<FormFieldContextValue | null>(null);

type FormItemContextValue = { id: string };
const FormItemContext = createContext<FormItemContextValue | null>(null);

export function FormField<
    TFieldValues extends FieldValues = FieldValues,
    TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>(props: ControllerProps<TFieldValues, TName>) {
    return (
        <FormFieldContext.Provider value={{ name: props.name }}>
            <Controller {...props} />
        </FormFieldContext.Provider>
    );
}

export function useFormField() {
    const fieldContext = useContext(FormFieldContext);
    const itemContext = useContext(FormItemContext);
    const fallbackId = useId();
    const { getFieldState } = useFormContext();
    const formState = useFormState({ name: fieldContext?.name });

    if (!fieldContext) {
        throw new Error("useFormField must be used inside <FormField>");
    }

    const fieldState = getFieldState(fieldContext.name, formState);
    // FormItem is optional: layouts like <Setting> are the row themselves.
    const id = itemContext?.id ?? fallbackId;

    return {
        id,
        name: fieldContext.name,
        formItemId: `${id}-form-item`,
        formDescriptionId: `${id}-form-item-description`,
        formMessageId: `${id}-form-item-message`,
        ...fieldState,
    };
}

export function FormItem({
    className,
    ...props
}: React.HTMLAttributes<HTMLDivElement>) {
    const id = useId();

    return (
        <FormItemContext.Provider value={{ id }}>
            <div
                className={cn("flex flex-col gap-1.5", className)}
                {...props}
            />
        </FormItemContext.Provider>
    );
}

export function FormLabel({
    className,
    ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
    const { formItemId, error } = useFormField();

    return (
        <label
            htmlFor={formItemId}
            className={cn(
                "text-[13px] font-semibold text-text-2",
                error && "text-danger",
                className,
            )}
            {...props}
        />
    );
}

export function FormControl(props: React.ComponentProps<typeof Slot.Root>) {
    const { formItemId, formDescriptionId, formMessageId, error } =
        useFormField();

    return (
        <Slot.Root
            id={formItemId}
            aria-describedby={
                error
                    ? `${formDescriptionId} ${formMessageId}`
                    : formDescriptionId
            }
            aria-invalid={!!error}
            {...props}
        />
    );
}

export function FormDescription({
    className,
    ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
    const { formDescriptionId } = useFormField();

    return (
        <p
            id={formDescriptionId}
            className={cn("text-xs text-text-3", className)}
            {...props}
        />
    );
}

export function FormMessage({
    className,
    children,
    ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
    const { formMessageId, error } = useFormField();
    const body = error ? String(error.message ?? "") : children;

    if (!body) return null;

    return (
        <p
            id={formMessageId}
            className={cn("text-xs text-danger", className)}
            {...props}>
            {body}
        </p>
    );
}
