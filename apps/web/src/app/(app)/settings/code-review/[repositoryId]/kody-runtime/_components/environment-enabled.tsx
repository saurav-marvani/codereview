"use client";

import { Button } from "@components/ui/button";
import { CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Switch } from "@components/ui/switch";
import { Controller, useFormContext } from "react-hook-form";

import type { CodeReviewFormType } from "../../../_types";

export const EnvironmentEnabled = () => {
    const form = useFormContext<CodeReviewFormType>();

    return (
        <Controller
            name="environment.enabled.value"
            control={form.control}
            defaultValue={false}
            render={({ field }) => (
                <Button
                    size="sm"
                    variant="helper"
                    disabled={field.disabled}
                    onClick={() => field.onChange(!field.value)}
                    className="w-full">
                    <CardHeader className="flex flex-row items-center justify-between gap-6">
                        <div className="flex flex-col gap-1">
                            <Heading variant="h3">
                                Enable Kody Runtime (alpha)
                            </Heading>
                            <p className="text-text-secondary text-sm">
                                When enabled, Kody boots this repository&apos;s
                                app on an ephemeral VM from the playbook below and
                                <b> executes </b> the pull request to find bugs
                                that only surface at run time (SSRF/IDOR, wrong DB
                                queries, price tampering, runtime regressions).
                                This runs in addition to the normal review.
                            </p>
                        </div>
                        <Switch decorative checked={!!field.value} />
                    </CardHeader>
                </Button>
            )}
        />
    );
};
