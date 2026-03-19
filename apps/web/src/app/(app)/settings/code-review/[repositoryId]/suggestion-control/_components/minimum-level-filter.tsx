"use client";

import { Button } from "@components/ui/button";
import { Checkbox } from "@components/ui/checkbox";
import { FormControl } from "@components/ui/form-control";
import { Heading } from "@components/ui/heading";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import { Controller, useFormContext } from "react-hook-form";

import { OverrideIndicatorForm } from "../../../_components/override";
import type { CodeReviewFormType } from "../../../_types";

const levelOptions = [
    {
        value: "low",
        name: "All findings",
        description: "Issues + Warnings",
        default: true,
    },
    {
        value: "high",
        name: "Issues only",
        description: "Hide warnings and nits",
    },
] satisfies Array<{
    value: string;
    name: string;
    description: string;
    default?: boolean;
}>;

/**
 * V3 agent level filter: binary issue/warning instead of 4-level severity.
 * Maps to the existing severityLevelFilter field for backwards compatibility:
 * - "low" = show all findings (issues + warnings)
 * - "high" = show only issues (hide warnings)
 */
export const MinimumLevelFilter = () => {
    const form = useFormContext<CodeReviewFormType>();

    return (
        <>
            <div>
                <Heading variant="h2">Finding level</Heading>
                <span className="text-text-secondary text-sm">
                    Choose which findings Kody should post as review comments
                </span>
            </div>

            <div className="mt-3">
                <Controller
                    name="suggestionControl.severityLevelFilter.value"
                    control={form.control}
                    render={({ field }) => {
                        const currentValue =
                            field.value === "high" ||
                            field.value === "critical"
                                ? "high"
                                : "low";

                        return (
                            <FormControl.Root className="flex-1">
                                <FormControl.Input>
                                    <ToggleGroup.Root
                                        id={field.name}
                                        type="single"
                                        disabled={field.disabled}
                                        className="flex flex-1 flex-col gap-2"
                                        value={currentValue}
                                        onValueChange={(value) => {
                                            if (value) field.onChange(value);
                                        }}>
                                        {levelOptions.map((option) => (
                                            <ToggleGroup.ToggleGroupItem
                                                asChild
                                                key={option.value}
                                                value={option.value}>
                                                <Button
                                                    size="md"
                                                    variant="helper"
                                                    className="h-auto w-full justify-between py-4">
                                                    <div className="flex flex-col gap-2">
                                                        <div className="flex items-center gap-1">
                                                            <Heading variant="h3">
                                                                {option.name}
                                                            </Heading>
                                                            {option.default && (
                                                                <small className="text-text-secondary">
                                                                    (default)
                                                                </small>
                                                            )}
                                                        </div>
                                                        <small className="text-text-secondary text-left">
                                                            {option.description}
                                                        </small>
                                                    </div>

                                                    <Checkbox
                                                        decorative
                                                        checked={
                                                            currentValue ===
                                                            option.value
                                                        }
                                                    />
                                                </Button>
                                            </ToggleGroup.ToggleGroupItem>
                                        ))}

                                        <OverrideIndicatorForm
                                            fieldName="suggestionControl.severityLevelFilter"
                                            className="mb-2"
                                        />
                                    </ToggleGroup.Root>
                                </FormControl.Input>
                            </FormControl.Root>
                        );
                    }}
                />
            </div>
        </>
    );
};
