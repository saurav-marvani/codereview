"use client";

import { FormControl } from "@components/ui/form-control";
import TagInput from "@components/ui/tag-input";
import { useController, useFormContext } from "react-hook-form";

import type { CodeReviewFormType } from "../../../_types";

/**
 * The NAMES of the environment variables the booted app requires. These are
 * matched at run time against the encrypted secrets vault (below) — the values
 * are never entered here.
 */
export const RequiredEnv = () => {
    const form = useFormContext<CodeReviewFormType>();
    const { field } = useController({
        name: "environment.requiredEnv.value",
        control: form.control,
    });

    return (
        <FormControl.Root>
            <FormControl.Label htmlFor={field.name}>
                Required environment variables
            </FormControl.Label>
            <FormControl.Input>
                <TagInput
                    id={field.name}
                    disabled={field.disabled}
                    tags={Array.isArray(field.value) ? field.value : []}
                    onTagsChange={field.onChange}
                    placeholder="e.g. DATABASE_URL — press Enter to add"
                />
            </FormControl.Input>
            <FormControl.Helper>
                Names only. Add each secret&apos;s value in the vault below.
            </FormControl.Helper>
        </FormControl.Root>
    );
};
