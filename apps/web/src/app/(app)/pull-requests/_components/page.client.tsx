"use client";

import { useMemo, useRef } from "react";
import { Button } from "@components/ui/button";
import { Page } from "@components/ui/page";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@components/ui/select";
import { useDebounce } from "@hooks/use-debounce";
import {
    useInfinitePullRequestExecutions,
    usePullRequestExecutionSSE,
    usePullRequestsDailyDigest,
    usePullRequestsFacets,
    type PullRequestExecution,
} from "@services/pull-requests";
import { ClockIcon, SearchIcon, UserIcon, XIcon } from "lucide-react";
import { parseAsString, parseAsStringLiteral, useQueryState } from "nuqs";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { cn } from "src/core/utils/components";

import { AwaitingList } from "./pr-awaiting-list";
import { PrDataTable } from "./pr-data-table";
import { PullRequestsFilters } from "./pull-requests-filters";

// Filters live in the URL (nuqs) so a filtered view is shareable / deep-linkable
// and survives reload — same pattern the Issues page uses. Writes are shallow
// with history:replace so typing doesn't spam the back button; the query itself
// stays debounced below.
const urlOpts = { shallow: true, history: "replace" } as const;
const SUGGESTIONS = ["all", "true", "false"] as const;
const AUTHOR_POLICIES = ["all", "reviewable", "excluded"] as const;
const STATUSES = [
    "success",
    "error",
    "partial_error",
    "skipped",
    "in_progress",
    "pending",
] as const;
// Mirrors the automation_execution status values verbatim.
const STATUS_LABEL: Record<(typeof STATUSES)[number], string> = {
    success: "Success",
    error: "Error",
    partial_error: "Partial error",
    skipped: "Skipped",
    in_progress: "In progress",
    pending: "Pending",
};
const SEVERITIES = ["critical", "high", "medium", "low"] as const;
const SEVERITY_LABEL: Record<(typeof SEVERITIES)[number], string> = {
    critical: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
};
// Severity color dot shown in the severity dropdown — keeps the color cue
// without loud always-on chips in the bar.
const SEVERITY_DOT: Record<(typeof SEVERITIES)[number], string> = {
    critical: "bg-danger",
    high: "bg-warning",
    medium: "bg-warning/60",
    low: "bg-text-tertiary",
};

export function PullRequestsPageClient() {
    const { teamId } = useSelectedTeamId();
    usePullRequestExecutionSSE();
    const [selectedRepository, setSelectedRepository] = useQueryState(
        "repo",
        parseAsString.withOptions(urlOpts),
    );
    // Search box with an explicit Title|Number scope toggle inside it.
    const [searchQuery, setSearchQuery] = useQueryState(
        "q",
        parseAsString.withDefault("").withOptions(urlOpts),
    );
    const [searchMode, setSearchMode] = useQueryState(
        "by",
        parseAsStringLiteral(["title", "number", "author"] as const)
            .withDefault("title")
            .withOptions(urlOpts),
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
    const [statusFilter, setStatusFilter] = useQueryState(
        "status",
        parseAsStringLiteral(STATUSES).withOptions(urlOpts),
    );
    const [severityFilter, setSeverityFilter] = useQueryState(
        "severity",
        parseAsStringLiteral(SEVERITIES).withOptions(urlOpts),
    );
    const [createdAtFrom, setCreatedAtFrom] = useQueryState(
        "from",
        parseAsString.withOptions(urlOpts),
    );
    const [createdAtTo, setCreatedAtTo] = useQueryState(
        "to",
        parseAsString.withOptions(urlOpts),
    );
    // Segment-tab params. needsAttention (crit/high) and author=me are dedicated;
    // the "errored" segment reuses statusFilter; "awaiting" is a distinct view.
    const [needsAttention, setNeedsAttention] = useQueryState(
        "needsAttention",
        parseAsString.withOptions(urlOpts),
    );
    const [authorFilter, setAuthorFilter] = useQueryState(
        "author",
        parseAsString.withOptions(urlOpts),
    );
    const [view, setView] = useQueryState(
        "view",
        parseAsStringLiteral(["awaiting"] as const).withOptions(urlOpts),
    );

    const searchRef = useRef<HTMLInputElement>(null);

    const debouncedQuery = useDebounce(searchQuery, 400);
    // Author name search is debounced too — the URL updates per keystroke but
    // the (loop-filtered) request only fires once typing settles.
    const debouncedAuthor = useDebounce(authorFilter ?? "", 400);

    // The scope toggle decides where the query is applied.
    const trimmedQuery = debouncedQuery.trim();
    const titleQuery = searchMode === "title" ? trimmedQuery : "";
    const numberQuery =
        searchMode === "number" ? trimmedQuery.replace(/^#/, "") : "";
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
            pullRequestTitle: titleQuery || undefined,
            pullRequestNumber: numberQuery || undefined,
            hasSentSuggestions: hasSentSuggestionsParam,
            authorPolicy,
            status: statusFilter ?? undefined,
            severity: severityFilter ?? undefined,
            needsAttention: needsAttention === "true" ? true : undefined,
            author: debouncedAuthor.trim() || undefined,
            createdAtFrom: createdAtFrom ?? undefined,
            // Make the "to" bound inclusive of the whole selected day.
            createdAtTo: createdAtTo
                ? `${createdAtTo}T23:59:59.999`
                : undefined,
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
        setSearchQuery("");
        setSuggestionsFilter("all");
        setAuthorPolicy("reviewable");
        setStatusFilter(null);
        setSeverityFilter(null);
        setNeedsAttention(null);
        setAuthorFilter(null);
        setView(null);
        setCreatedAtFrom(null);
        setCreatedAtTo(null);
    };

    // "Awaiting review" is a distinct dataset (open PRs with no review), so it's
    // a toggle in the filter bar rather than a filter value. Its count comes
    // from the facets endpoint.
    const isAwaiting = view === "awaiting";
    const { data: facets } = usePullRequestsFacets(teamId);
    // Daily "pulse of the review process" — how it's going today, not the state
    // of any single PR. Drives the summary strip below the header.
    const { data: digest } = usePullRequestsDailyDigest(teamId);

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
        searchQuery.trim() && {
            key: "q",
            label:
                searchMode === "number"
                    ? `PR #${searchQuery.trim().replace(/^#/, "")}`
                    : `Title: "${searchQuery.trim()}"`,
            clear: () => {
                setSearchQuery("");
            },
        },
        authorFilter?.trim() && {
            key: "author",
            label: `Author: ${authorFilter.trim()}`,
            clear: () => {
                setAuthorFilter(null);
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
        statusFilter && {
            key: "status",
            label: `Status: ${STATUS_LABEL[statusFilter]}`,
            clear: () => {
                setStatusFilter(null);
            },
        },
        severityFilter && {
            key: "severity",
            label: `Severity: ${SEVERITY_LABEL[severityFilter]}`,
            clear: () => {
                setSeverityFilter(null);
            },
        },
        (createdAtFrom || createdAtTo) && {
            key: "date",
            label: `Date: ${createdAtFrom || "…"} → ${createdAtTo || "…"}`,
            clear: () => {
                setCreatedAtFrom(null);
                setCreatedAtTo(null);
            },
        },
    ].filter(
        (chip): chip is { key: string; label: string; clear: () => void } =>
            Boolean(chip),
    );

    // Header count. `groupedPullRequests.length` is only the window loaded so far
    // by the infinite scroll, so on its own it understates the real total (it
    // read "150 pull requests" next to "665 awaiting"). The authoritative total
    // is the unfiltered team facet (`facets.all`); use it whenever no filter
    // narrows the set. With filters active there is no server-side filtered
    // total, so fall back to the loaded count and mark it partial ("+") while
    // more pages remain — never present the loaded window as the whole set.
    // needsAttention and awaiting are segment toggles (not removable chips), but
    // they still narrow the list — count them so the header doesn't show the
    // full team total next to a narrowed view.
    const hasActiveFilters =
        activeChips.length > 0 ||
        needsAttention === "true" ||
        isAwaiting ||
        authorPolicy !== "reviewable";
    const totalCount =
        !hasActiveFilters && typeof facets?.all === "number"
            ? facets.all
            : groupedPullRequests.length;
    const isPartialCount = hasActiveFilters && hasNextPage;

    // "Pulse of the review process" strip. Each card is a shortcut that filters
    // the list below to its segment (toggles off if already active). The number
    // is today's digest value; Awaiting/Needs-attention are current totals.
    const pulseCards = digest
        ? [
              {
                  key: "reviewed",
                  label: "Reviewed today",
                  sub: "today",
                  hint: "Distinct PRs Kody reviewed today (UTC).",
                  value: digest.reviewedToday,
                  tone: "text-success",
                  active: !isAwaiting && statusFilter === "success",
                  onClick: () => {
                      setView(null);
                      setNeedsAttention(null);
                      setStatusFilter(
                          !isAwaiting && statusFilter === "success"
                              ? null
                              : "success",
                      );
                  },
              },
              {
                  key: "failed",
                  label: "Review failed today",
                  sub: "today",
                  hint: "PRs whose review errored today (error / partial error).",
                  value: digest.erroredToday,
                  tone: "text-destructive",
                  active: !isAwaiting && statusFilter === "error",
                  onClick: () => {
                      setView(null);
                      setNeedsAttention(null);
                      setStatusFilter(
                          !isAwaiting && statusFilter === "error"
                              ? null
                              : "error",
                      );
                  },
              },
              {
                  key: "awaiting",
                  label: "Awaiting review",
                  sub: "backlog",
                  hint: "Open PRs with no Kody review yet (not merged, not closed) — current backlog, not today.",
                  // Backlog is a current total, not a "today" number — read it
                  // from facets (same source as the toggle's 665), so the card
                  // and the toggle never disagree.
                  value: facets?.awaiting ?? 0,
                  tone: "text-text-primary",
                  active: isAwaiting,
                  onClick: () => {
                      setStatusFilter(null);
                      setNeedsAttention(null);
                      setView(isAwaiting ? null : "awaiting");
                  },
              },
              {
                  key: "attention",
                  label: "Needs attention",
                  sub: "total",
                  hint: "PRs that delivered at least one critical or high suggestion (all-time, current scope).",
                  // Current total, from facets rather than today's digest:
                  // distinct PRs that DELIVERED a critical/high suggestion.
                  value: facets?.needsAttention ?? 0,
                  tone: "text-warning",
                  active: !isAwaiting && needsAttention === "true",
                  onClick: () => {
                      setView(null);
                      setStatusFilter(null);
                      setNeedsAttention(
                          !isAwaiting && needsAttention === "true"
                              ? null
                              : "true",
                      );
                  },
              },
          ]
        : [];

    return (
        <Page.Root className="pb-0">
            <Page.Header className="max-w-full">
                <div className="flex w-full items-center justify-between">
                    <div className="flex items-center gap-4">
                        <Page.Title className="text-balance">
                            Pull Requests
                        </Page.Title>

                        {totalCount > 0 && (
                            <span className="text-text-tertiary text-sm tabular-nums">
                                {totalCount}
                                {isPartialCount ? "+" : ""} pull request
                                {totalCount > 1 ? "s" : ""}
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
                </div>
            </Page.Header>

            <Page.Content className="max-w-full px-6">
                {/* Pulse of the review process — the daily "how are we doing?"
                    that a lead wants before scanning individual PRs. Each card
                    filters the list to its segment. */}
                {pulseCards.length > 0 && (
                    <div className="grid grid-cols-2 gap-3 pt-4 sm:grid-cols-4">
                        {pulseCards.map((card) => (
                            <button
                                key={card.key}
                                type="button"
                                onClick={card.onClick}
                                aria-pressed={card.active}
                                title={card.hint}
                                className={cn(
                                    "flex flex-col items-start gap-1 rounded-xl border px-4 py-3 text-left transition",
                                    card.active
                                        ? "border-primary-light/60 bg-primary/5 ring-primary-light/15 ring-3"
                                        : "border-card-lv3 bg-card-lv2 hover:border-card-lv3 hover:bg-card-lv1/70",
                                )}>
                                <span className="flex w-full items-center justify-between gap-2">
                                    <span className="text-text-tertiary text-xs font-medium">
                                        {card.label}
                                    </span>
                                    {/* Scope tag — the cards mix "today" numbers
                                        (digest) with current totals (facets), so
                                        each one says which it is. */}
                                    <span className="text-text-tertiary/70 bg-card-lv3/40 rounded px-1.5 py-0.5 text-[0.625rem] font-medium tracking-wide uppercase">
                                        {card.sub}
                                    </span>
                                </span>
                                <span
                                    className={cn(
                                        "text-2xl font-semibold tabular-nums",
                                        card.tone,
                                    )}>
                                    {card.value}
                                </span>
                            </button>
                        ))}
                    </div>
                )}

                {/* Filter toolbar — two rows: free-text searches on top,
                    structured filters below, so neither row feels crammed. */}
                <div className="flex flex-col gap-2 py-4">
                    {/* Row 1 — one search box, three scopes: Title / Number /
                        Author. Title & Number drive the `q` query; Author drives
                        the author-name filter — so the user picks WHAT to search
                        instead of juggling two inputs. */}
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="border-card-lv3 bg-card-lv2 focus-within:border-primary-light/50 focus-within:ring-primary-light/15 flex h-9 min-w-[18rem] flex-1 items-center gap-2 rounded-xl border pr-1.5 pl-3 transition focus-within:ring-3">
                            {searchMode === "author" ? (
                                <UserIcon className="text-text-tertiary size-4 shrink-0" />
                            ) : (
                                <SearchIcon className="text-text-tertiary size-4 shrink-0" />
                            )}
                            <input
                                ref={searchRef}
                                className="text-text-primary placeholder:text-text-tertiary/70 h-full min-w-0 flex-1 bg-transparent text-sm outline-none"
                                inputMode={
                                    searchMode === "number" ? "numeric" : "text"
                                }
                                placeholder={
                                    searchMode === "number"
                                        ? "Search by PR number…"
                                        : searchMode === "author"
                                          ? "Search by author…"
                                          : "Search by title…"
                                }
                                value={
                                    searchMode === "author"
                                        ? (authorFilter ?? "")
                                        : searchQuery
                                }
                                onChange={(event) => {
                                    if (searchMode === "author") {
                                        setAuthorFilter(
                                            event.target.value || null,
                                        );
                                        return;
                                    }
                                    setSearchQuery(
                                        searchMode === "number"
                                            ? event.target.value.replace(
                                                  /[^\d]/g,
                                                  "",
                                              )
                                            : event.target.value,
                                    );
                                }}
                            />
                            <div className="bg-card-lv1/80 flex shrink-0 items-center gap-0.5 rounded-lg p-0.5">
                                {(["title", "number", "author"] as const).map(
                                    (mode) => (
                                        <button
                                            key={mode}
                                            type="button"
                                            onClick={() => {
                                                // Switching scope starts a fresh
                                                // search — clear both the text
                                                // query and the author filter.
                                                setSearchMode(mode);
                                                setSearchQuery("");
                                                setAuthorFilter(null);
                                            }}
                                            className={cn(
                                                "rounded-md px-2.5 py-1 text-xs font-medium capitalize transition",
                                                searchMode === mode
                                                    ? "bg-card-lv3 text-text-primary"
                                                    : "text-text-tertiary hover:text-text-secondary",
                                            )}>
                                            {mode}
                                        </button>
                                    ),
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Row 2 — structured filters. */}
                    <div className="flex flex-wrap items-center gap-2">
                        <PullRequestsFilters
                            teamId={teamId}
                            selectedRepository={selectedRepository ?? undefined}
                            onRepositoryChange={(value) =>
                                setSelectedRepository(value ?? null)
                            }
                            suggestionsFilter={suggestionsFilter}
                            onSuggestionsFilterChange={(value) =>
                                setSuggestionsFilter(value)
                            }
                            authorPolicy={authorPolicy}
                            onAuthorPolicyChange={(value) =>
                                setAuthorPolicy(value)
                            }
                            createdAtFrom={createdAtFrom}
                            createdAtTo={createdAtTo}
                            onCreatedAtFromChange={(value) =>
                                setCreatedAtFrom(value || null)
                            }
                            onCreatedAtToChange={(value) =>
                                setCreatedAtTo(value || null)
                            }
                        />

                        <Select
                            value={severityFilter ?? "all"}
                            onValueChange={(value) =>
                                setSeverityFilter(
                                    value === "all"
                                        ? null
                                        : (value as (typeof SEVERITIES)[number]),
                                )
                            }>
                            <SelectTrigger
                                size="sm"
                                className={cn(
                                    "h-9 w-auto gap-1.5 rounded-lg",
                                    severityFilter && "border-primary-light/50",
                                )}>
                                <SelectValue placeholder="Severity" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">
                                    Any severity
                                </SelectItem>
                                {SEVERITIES.map((sev) => (
                                    <SelectItem key={sev} value={sev}>
                                        <span className="flex items-center gap-2">
                                            <span
                                                className={cn(
                                                    "size-2 rounded-full",
                                                    SEVERITY_DOT[sev],
                                                )}
                                            />
                                            {SEVERITY_LABEL[sev]}
                                        </span>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>

                        <Select
                            value={statusFilter ?? "all"}
                            onValueChange={(value) =>
                                setStatusFilter(
                                    value === "all"
                                        ? null
                                        : (value as (typeof STATUSES)[number]),
                                )
                            }>
                            <SelectTrigger
                                size="sm"
                                className={cn(
                                    "h-9 w-auto gap-1.5 rounded-lg",
                                    statusFilter && "border-primary-light/50",
                                )}>
                                <SelectValue placeholder="Status" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">Any status</SelectItem>
                                {STATUSES.map((s) => (
                                    <SelectItem key={s} value={s}>
                                        {STATUS_LABEL[s]}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>

                        <button
                            type="button"
                            onClick={() =>
                                setView(isAwaiting ? null : "awaiting")
                            }
                            className={cn(
                                "ml-auto flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium transition-all",
                                isAwaiting
                                    ? "border-warning/60 bg-warning/10 text-warning"
                                    : "border-card-lv3 text-text-secondary hover:bg-card-lv2/60",
                            )}>
                            <ClockIcon className="size-4" />
                            Awaiting review
                            {facets?.awaiting ? (
                                <span className="tabular-nums opacity-80">
                                    {facets.awaiting}
                                </span>
                            ) : null}
                        </button>
                    </div>
                </div>

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

                {isAwaiting ? (
                    <AwaitingList teamId={teamId} />
                ) : error ? (
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
