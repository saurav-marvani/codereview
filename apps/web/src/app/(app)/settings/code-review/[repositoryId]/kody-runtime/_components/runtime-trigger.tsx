"use client";

import { Button } from "@components/ui/button";
import { CardHeader } from "@components/ui/card";
import { Heading } from "@components/ui/heading";
import { Switch } from "@components/ui/switch";
import { Controller, useFormContext } from "react-hook-form";

import type { CodeReviewFormType } from "../../../_types";

/**
 * When Kody Runtime runs. Off (default) = on-demand only: the dev comments
 * `@kody runtime` on the PR (or `kodus review --runtime` on the CLI) when a
 * run is worth a VM. On = every automatic review of the repo. On-demand is
 * the default because each run provisions a VM (cost + latency) and burns the
 * org's LLM quota — the dev opts in per PR.
 */
export const RuntimeTrigger = () => {
    const form = useFormContext<CodeReviewFormType>();

    return (
        <Controller
            name="environment.trigger.value"
            control={form.control}
            defaultValue="command"
            render={({ field }) => (
                <Button
                    size="sm"
                    variant="helper"
                    disabled={field.disabled}
                    onClick={() =>
                        field.onChange(
                            field.value === "auto" ? "command" : "auto",
                        )
                    }
                    className="w-full">
                    <CardHeader className="flex flex-row items-center justify-between gap-6">
                        <div className="flex flex-col gap-1">
                            <Heading variant="h3">
                                Run automatically on every PR
                            </Heading>
                            <p className="text-text-secondary text-sm">
                                Off (recommended): Kody Runtime only runs when
                                requested — comment <code>@kody runtime</code>{" "}
                                on the PR or use <code>--runtime</code> on the
                                CLI. On: it runs on every automatic review,
                                provisioning a VM per PR.
                            </p>
                        </div>
                        <Switch decorative checked={field.value === "auto"} />
                    </CardHeader>
                </Button>
            )}
        />
    );
};
