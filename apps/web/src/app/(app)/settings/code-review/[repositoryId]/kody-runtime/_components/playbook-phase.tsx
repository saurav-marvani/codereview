"use client";

import { useEffect, useMemo, useState } from "react";
import { FormControl } from "@components/ui/form-control";
import { Textarea } from "@components/ui/textarea";
import { type FieldPath, useController, useFormContext } from "react-hook-form";

import type { CodeReviewFormType } from "../../../_types";

/**
 * One playbook phase = an ordered list of shell commands (one per line) run on
 * the VM. Newline-split into a string[] on the form, matching the backend
 * `EnvironmentConfigDto` arrays. Modeled on the general/ignore-paths editor.
 */
export const PlaybookPhase = ({
    name,
    label,
    helper,
    placeholder,
}: {
    name: FieldPath<CodeReviewFormType>;
    label: string;
    helper: string;
    placeholder: string;
}) => {
    const form = useFormContext<CodeReviewFormType>();
    const { field } = useController({ name, control: form.control });

    const fieldValue = useMemo(
        () => (Array.isArray(field.value) ? field.value.join("\n") : ""),
        [field.value],
    );
    const [draftValue, setDraftValue] = useState(fieldValue);
    const [isEditing, setIsEditing] = useState(false);

    useEffect(() => {
        if (!isEditing && draftValue !== fieldValue) {
            setDraftValue(fieldValue);
        }
    }, [isEditing, draftValue, fieldValue]);

    return (
        <FormControl.Root>
            <FormControl.Label htmlFor={field.name}>{label}</FormControl.Label>
            <FormControl.Input>
                <Textarea
                    id={field.name}
                    disabled={field.disabled}
                    value={draftValue}
                    onFocus={() => setIsEditing(true)}
                    onChange={(ev) => {
                        const next = ev.target.value;
                        setDraftValue(next);
                        field.onChange(
                            next
                                .split("\n")
                                .map((item) => item.trim())
                                .filter((item) => item !== ""),
                        );
                    }}
                    onBlur={() => {
                        setIsEditing(false);
                        field.onBlur();
                    }}
                    placeholder={placeholder}
                    className="min-h-28 font-mono text-xs"
                />
            </FormControl.Input>
            <FormControl.Helper>{helper}</FormControl.Helper>
        </FormControl.Root>
    );
};
