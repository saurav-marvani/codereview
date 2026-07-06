"use client";

import { useMemo } from "react";
import { Button } from "@components/ui/button";
import { Page } from "@components/ui/page";
import { useDebounce } from "@hooks/use-debounce";
import {
    useInfinitePullRequestExecutions,
    usePullRequestExecutionSSE,
    type PullRequestExecution,
} from "@services/pull-requests";
import { XIcon } from "lucide-react";
import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { PrDataTable } from "./pr-data-table";
import { PullRequestsFilters } from "./pull-requests-filters";

// Filters live in the URL (nuqs) so a filtered view is shareable / deep-linkable
// and survives reload — same pattern the Issues page uses. Writes are shallow
// with history:replace so typing doesn't spam the back button; the query itself
// stays debounced below.
const urlOpts = { shallow: true, history: "replace" } as const;
const SUGGESTIONS = ["all", "true", "false"] as const;
const AUTHOR_POLICIES = ["all", "reviewable", "excluded"] as const;

export function PullRequestsPageClient() {
    const { teamId } = useSelectedTeamId();
    usePullRequestExecutionSSE();
    const [selectedRepository, setSelectedRepository] = useQueryState(
        "repo",
        parseAsString.withOptions(urlOpts),
    );
    const [pullRequestTitle, setPullRequestTitle] = useQueryState(
        "title",
        parseAsString.withDefault("").withOptions(urlOpts),
    );
    const [pullRequestNumber, setPullRequestNumber] = useQueryState(
        "pr",
        parseAsString.withDefault("").withOptions(urlOpts),
    );
    const [suggestionsFilter, setSuggestionsFilter] = useQueryState(
        "suggestions",
        parseAsStringLiteral(SUGGESTIONS)
            .withDefault("all")
            .withOptions(urlOpts),
    );
    const [authorPolicy, setAuthorPolicy] = useQueryState(
        "authors",
        parseAsStringLiteral(AUTHOR_POLICIES)
            .withDefault("reviewable")
            .withOptions(urlOpts),
    );

    const debouncedTitle = useDebounce(pullRequestTitle, 400);
    const debouncedNumber = useDebounce(pullRequestNumber, 400);

    const normalizedTitle = debouncedTitle.trim();
    const normalizedNumber = debouncedNumber.trim();
    const hasSentSuggestionsParam =
        suggestionsFilter === "true"
            ? true
            : suggestionsFilter === "false"
              ? false
              : undefined;

    const {
        items: pullRequests,
        isLoading,
        error,
        hasNextPage,
        fetchNextPage,
        isFetchingNextPage,
    } = useInfinitePullRequestExecutions(
        {
            teamId,
            repositoryName: selectedRepository ?? undefined,
            pullRequestTitle: normalizedTitle ? normalizedTitle : undefined,
            pullRequestNumber: normalizedNumber ? normalizedNumber : undefined,
            hasSentSuggestions: hasSentSuggestionsParam,
            authorPolicy,
        },
        // This view mounts usePullRequestExecutionSSE (above), which invalidates
        // the query on every execution_updated event — so skip the redundant
        // 30s first-page poll.
        { pageSize: 30, poll: false },
    );

    const groupedPullRequests = useMemo(() => {
        const byPr = new Map<string, PullRequestExecution[]>();

        const getExecutionTime = (pr: PullRequestExecution) => {
            const value =
                pr.automationExecution?.createdAt ||
                pr.automationExecution?.updatedAt ||
                pr.updatedAt ||
                pr.createdAt;
            return value ? Date.parse(value) : 0;
        };

        pullRequests.forEach((pr) => {
            const existing = byPr.get(pr.prId) ?? [];
            existing.push(pr);
            byPr.set(pr.prId, existing);
        });

        const groups = Array.from(byPr.values()).map((executions) => {
            const sorted = [...executions].sort(
                (a, b) => getExecutionTime(b) - getExecutionTime(a),
            );
            const latest = sorted[0];

            return {
                prId: latest.prId,
                latest,
                executions: sorted,
                reviewCount: sorted.length,
            };
        });

        return groups.sort(
            (a, b) => getExecutionTime(b.latest) - getExecutionTime(a.latest),
        );
    }, [pullRequests]);

    const clearAllFilters = () => {
        setSelectedRepository(null);
        setPullRequestTitle("");
        setPullRequestNumber("");
        setSuggestionsFilter("all");
        setAuthorPolicy("reviewable");
    };

    // Surface the applied filters as removable chips (the popover only shows a
    // count). Defaults — suggestions "all", authors "reviewable" — are not chips.
    const suggestionsChipLabel = {
        true: "Has suggestions",
        false: "No suggestions",
    };
    const authorChipLabel = { all: "All authors", excluded: "Excluded only" };
    const activeChips = [
        selectedRepository && {
            key: "repo",
            label: `Repo: ${selectedRepository}`,
            clear: () => {
                setSelectedRepository(null);
            },
        },
        pullRequestTitle.trim() && {
            key: "title",
            label: `Title: "${pullRequestTitle.trim()}"`,
            clear: () => {
                setPullRequestTitle("");
            },
        },
        pullRequestNumber.trim() && {
            key: "pr",
            label: `PR #${pullRequestNumber.trim()}`,
            clear: () => {
                setPullRequestNumber("");
            },
        },
        suggestionsFilter !== "all" && {
            key: "suggestions",
            label: suggestionsChipLabel[suggestionsFilter],
            clear: () => {
                setSuggestionsFilter("all");
            },
        },
        authorPolicy !== "reviewable" && {
            key: "authors",
            label: authorChipLabel[authorPolicy],
            clear: () => {
                setAuthorPolicy("reviewable");
            },
        },
    ].filter(
        (chip): chip is { key: string; label: string; clear: () => void } =>
            Boolean(chip),
    );

    return (
        <Page.Root className="pb-0">
            <Page.Header className="max-w-full">
                <div className="flex w-full items-center justify-between">
                    <div className="flex items-center gap-4">
                        <Page.Title className="text-balance">
                            Pull Requests
                        </Page.Title>

                        {groupedPullRequests.length > 0 && (
                            <span className="text-text-tertiary text-sm tabular-nums">
                                {groupedPullRequests.length} pull request
                                {groupedPullRequests.length > 1 ? "s" : ""}
                                {selectedRepository && (
                                    <>
                                        {" "}
                                        in{" "}
                                        <span className="text-text-secondary font-medium">
                                            {selectedRepository}
                                        </span>
                                    </>
                                )}
                            </span>
                        )}
                    </div>

                    <div className="ml-auto flex flex-wrap items-center gap-3">
                        <PullRequestsFilters
                            teamId={teamId}
                            selectedRepository={selectedRepository ?? undefined}
                            onRepositoryChange={(value) =>
                                setSelectedRepository(value ?? null)
                            }
                            pullRequestTitle={pullRequestTitle}
                            onTitleChange={(value) =>
                                setPullRequestTitle(value)
                            }
                            pullRequestNumber={pullRequestNumber}
                            onPullRequestNumberChange={(value) =>
                                setPullRequestNumber(
                                    value.replace(/[^\d]/g, ""),
                                )
                            }
                            suggestionsFilter={suggestionsFilter}
                            onSuggestionsFilterChange={(value) =>
                                setSuggestionsFilter(value)
                            }
                            authorPolicy={authorPolicy}
                            onAuthorPolicyChange={(value) =>
                                setAuthorPolicy(value)
                            }
                        />
                    </div>
                </div>
            </Page.Header>

            <Page.Content className="max-w-full px-6">
                {activeChips.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 pb-4">
                        {activeChips.map((chip) => (
                            <Button
                                key={chip.key}
                                size="xs"
                                variant="helper"
                                rightIcon={<XIcon />}
                                onClick={chip.clear}>
                                {chip.label}
                            </Button>
                        ))}
                        <Button
                            size="xs"
                            variant="cancel"
                            onClick={clearAllFilters}>
                            Clear all
                        </Button>
                    </div>
                )}

                {error ? (
                    <div className="py-12 text-center">
                        <p className="text-sm text-red-600">
                            Error loading pull requests. Please try again.
                        </p>
                    </div>
                ) : (
                    <PrDataTable
                        data={groupedPullRequests}
                        loading={isLoading && !groupedPullRequests.length}
                        hasNextPage={hasNextPage}
                        isFetchingNextPage={isFetchingNextPage}
                        fetchNextPage={fetchNextPage}
                        hasActiveFilters={activeChips.length > 0}
                        onClearFilters={clearAllFilters}
                    />
                )}
            </Page.Content>
        </Page.Root>
    );
}
