"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertTitle } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import { Heading } from "@components/ui/heading";
import { Page } from "@components/ui/page";
import { Spinner } from "@components/ui/spinner";
import { toast } from "@components/ui/toaster/use-toast";
import { useGetPastReviewers } from "@services/kodyRules/hooks";
import { createOrUpdateCodeReviewParameter } from "@services/parameters/fetch";
import { GitPullRequestIcon, ClockFadingIcon, Check } from "lucide-react";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "src/core/components/ui/command";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { cn } from "src/core/utils/components";

import { StepIndicators } from "../_components/step-indicators";

const NEXT_STEP = "/setup/review-mode";

export default function SelectReviewersPage() {
    const router = useRouter();
    const { teamId } = useSelectedTeamId();

    // Team-wide list (global scope): current members ∪ authors of PRs in the
    // last 3 months, so recently-departed devs are still selectable.
    const { data: reviewers = [], isLoading } = useGetPastReviewers({ teamId });

    const [excluded, setExcluded] = useState<string[]>([]);
    const [isSaving, setIsSaving] = useState(false);

    const toggle = (id: string) => {
        setExcluded((current) =>
            current.includes(id)
                ? current.filter((x) => x !== id)
                : [...current, id],
        );
    };

    const goNext = () => router.push(NEXT_STEP);

    const handleContinue = async () => {
        if (!teamId) {
            goNext();
            return;
        }
        try {
            setIsSaving(true);
            // Persist globally so it applies to every repo; refine per-repo
            // later in Settings.
            await createOrUpdateCodeReviewParameter(
                { kodyLearningExcludedReviewers: excluded },
                teamId,
                "global",
            );
            goNext();
        } catch (error) {
            console.error("Error saving excluded reviewers", error);
            toast({
                variant: "danger",
                description: "We couldn't save your selection. Please try again.",
            });
        } finally {
            setIsSaving(false);
        }
    };

    const excludedCount = excluded.length;

    return (
        <Page.Root className="mx-auto flex min-h-full w-full flex-col gap-6 p-6 lg:flex-row lg:gap-6">
            <div className="bg-card-lv1 flex w-full flex-col justify-center gap-10 rounded-3xl p-8 lg:max-w-none lg:flex-10 lg:p-12">
                <div className="flex-1 space-y-6 overflow-hidden">
                    <h1 className="flex items-center gap-2 text-2xl font-bold">
                        <GitPullRequestIcon /> Kody learns from your past reviews
                    </h1>
                    <p className="text-text-secondary text-md">
                        Kody learns coding standards from your team&apos;s last 3
                        months of PR reviews, and keeps learning every week.
                        Exclude anyone whose review comments you&apos;d rather
                        Kody not learn from.
                    </p>
                    <Alert>
                        <ClockFadingIcon size={24} />
                        <AlertTitle>
                            <span className="text-text-secondary text-sm">
                                You can change this anytime in Settings, per
                                repository.
                            </span>
                        </AlertTitle>
                    </Alert>
                </div>
            </div>

            <div className="flex w-full flex-col gap-10 lg:flex-14 lg:p-10">
                <div className="flex flex-1 flex-col gap-8">
                    <StepIndicators.Auto />

                    <div className="flex flex-col gap-2">
                        <Heading variant="h2">
                            Whose reviews should Kody learn from?
                        </Heading>
                        <span className="text-text-secondary text-sm">
                            Everyone is included by default. Select developers to
                            exclude
                            {excludedCount > 0
                                ? ` — ${excludedCount} excluded`
                                : ""}
                            .
                        </span>
                    </div>

                    <Command className="border-card-lv3 rounded-xl border">
                        <CommandInput placeholder="Search developers..." />
                        <CommandList className="max-h-[320px]">
                            <CommandEmpty>
                                {isLoading
                                    ? "Loading developers…"
                                    : "No developers found."}
                            </CommandEmpty>
                            <CommandGroup>
                                {reviewers.map((reviewer) => (
                                    <CommandItem
                                        key={reviewer.id}
                                        value={reviewer.name}
                                        onSelect={() => toggle(reviewer.id)}>
                                        <span className="flex-1">
                                            {reviewer.name}
                                        </span>
                                        {excluded.includes(reviewer.id) ? (
                                            <span className="text-text-secondary flex items-center gap-1 text-xs">
                                                Excluded <Check className="size-4" />
                                            </span>
                                        ) : null}
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        </CommandList>
                    </Command>

                    <div className="flex items-center gap-3">
                        <Button
                            size="lg"
                            variant="cancel"
                            className="flex-1"
                            onClick={goNext}
                            disabled={isSaving}>
                            Skip for now
                        </Button>
                        <Button
                            size="lg"
                            variant="primary"
                            className="flex-1"
                            onClick={handleContinue}
                            loading={isSaving}
                            disabled={isSaving}>
                            {isLoading ? (
                                <Spinner className="h-4 w-4" />
                            ) : (
                                "Continue"
                            )}
                        </Button>
                    </div>
                </div>
            </div>
        </Page.Root>
    );
}
