"use client";

import { useEffect, useRef } from "react";
import { Button } from "@components/ui/button";
import { Checkbox } from "@components/ui/checkbox";
import { Input } from "@components/ui/input";
import { Label } from "@components/ui/label";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@components/ui/popover";
import { Filter, SearchIcon } from "lucide-react";
import {
    EMPTY_LIST_FILTERS,
    hasActiveListFilters,
    type ListFilters,
    type SortOption,
} from "src/core/utils/kody-rules/apply-filters";
import type { InferredRuleOrigin } from "src/core/utils/kody-rules/infer-origin";

type Repository = {
    id: string;
    name: string;
};

type KodyRulesToolbarProps = {
    filterQuery: string;
    onFilterQueryChange: (query: string) => void;
    isDisabled: boolean;
    entityLabel?: "rules" | "memories";
    sortOption: SortOption;
    onSortOptionChange: (option: SortOption) => void;
} & FilterPopoverContentProps;

export const KodyRulesToolbar = ({
    filterQuery,
    onFilterQueryChange,
    isDisabled,
    entityLabel = "rules",
    visibleScopes,
    onVisibleScopesChange,
    listFilters,
    onListFiltersChange,
    sortOption,
    onSortOptionChange,
    isRepoView,
    isGlobalView,
}: KodyRulesToolbarProps) => {
    const activeFilterCount =
        listFilters.origins.size +
        listFilters.severities.size +
        (listFilters.withSyncErrors ? 1 : 0);

    // Global "/" shortcut focuses the search input (skips when the user is
    // already typing in another input/textarea/contenteditable).
    const searchRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (e.key !== "/") return;
            const target = e.target as HTMLElement | null;
            if (!target) return;
            const tag = target.tagName;
            if (
                tag === "INPUT" ||
                tag === "TEXTAREA" ||
                target.isContentEditable
            ) {
                return;
            }
            e.preventDefault();
            searchRef.current?.focus();
        }
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);

    return (
        <div className="flex items-center gap-2">
            <Input
                ref={searchRef}
                size="md"
                type="search"
                name="kody-rules-search"
                autoComplete="off"
                spellCheck={false}
                value={filterQuery}
                leftIcon={<SearchIcon aria-hidden />}
                onChange={(e) => onFilterQueryChange(e.target.value)}
                aria-label={
                    entityLabel === "memories"
                        ? "Search memories"
                        : "Search rules"
                }
                placeholder={
                    entityLabel === "memories"
                        ? "Search for titles or instructions… (press /)"
                        : "Search for titles, paths, content… (press /)"
                }
                disabled={isDisabled}
                className="grow"
            />
            {/* Native <select>: avoids the Radix Slot + composeRefs chain
                that was producing a "Maximum update depth" loop on
                mount in our toolbar. Plain DOM select keeps the
                accessibility, keyboard support and form semantics that
                Radix gives, with zero ref composition. */}
            <select
                value={sortOption}
                onChange={(e) =>
                    onSortOptionChange(e.target.value as SortOption)
                }
                aria-label="Sort by"
                className="border-card-lv3 bg-card-lv2 text-text-primary focus-visible:ring-primary h-9 rounded-md border px-3 text-sm focus:outline-none focus-visible:ring-2">
                <option value="recent">Recently updated</option>
                <option value="severity-desc">Severity (high → low)</option>
                <option value="alphabetical">A → Z</option>
            </select>
            <Popover>
                <PopoverTrigger asChild>
                    <Button
                        size="md"
                        variant="secondary"
                        decorative
                        aria-label={
                            activeFilterCount > 0
                                ? "Filters (" +
                                  activeFilterCount +
                                  " active)"
                                : "Filters"
                        }
                        leftIcon={<Filter aria-hidden />}>
                        Filters
                        {activeFilterCount > 0 && (
                            <span
                                aria-hidden
                                className="bg-primary text-primary-foreground ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px]">
                                {activeFilterCount}
                            </span>
                        )}
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80" align="end">
                    <FilterPopoverContent
                        visibleScopes={visibleScopes}
                        onVisibleScopesChange={onVisibleScopesChange}
                        listFilters={listFilters}
                        onListFiltersChange={onListFiltersChange}
                        isRepoView={isRepoView}
                        isGlobalView={isGlobalView}
                        entityLabel={entityLabel}
                    />
                </PopoverContent>
            </Popover>
        </div>
    );
};

export type VisibleScopes = {
    self: boolean;
    dir: boolean;
    repo: boolean;
    global: boolean;
    disabled: boolean;
};

const ORIGIN_OPTIONS: InferredRuleOrigin[] = [
    "Auto-sync",
    "Onboard",
    "Kody-generated",
    "manual",
];

const SEVERITY_OPTIONS: { value: string; label: string }[] = [
    { value: "critical", label: "Critical" },
    { value: "high", label: "High" },
    { value: "medium", label: "Medium" },
    { value: "low", label: "Low" },
];

type FilterPopoverContentProps = {
    visibleScopes: VisibleScopes;
    onVisibleScopesChange: (scopes: VisibleScopes) => void;
    listFilters: ListFilters;
    onListFiltersChange: (filters: ListFilters) => void;
    isRepoView: boolean; // Viewing a repository (not a directory within it)
    isGlobalView: boolean; // Viewing the global config
    entityLabel?: "rules" | "memories";
};

export const FilterPopoverContent = ({
    visibleScopes,
    onVisibleScopesChange,
    listFilters,
    onListFiltersChange,
    isRepoView,
    isGlobalView,
    entityLabel = "rules",
}: FilterPopoverContentProps) => {
    const handleScopeChange = (
        scope: keyof VisibleScopes,
        checked: boolean,
    ) => {
        onVisibleScopesChange({ ...visibleScopes, [scope]: checked });
    };

    const toggleOrigin = (origin: InferredRuleOrigin, checked: boolean) => {
        const next = new Set(listFilters.origins);
        if (checked) next.add(origin);
        else next.delete(origin);
        onListFiltersChange({ ...listFilters, origins: next });
    };

    const toggleSeverity = (severity: string, checked: boolean) => {
        const next = new Set(listFilters.severities);
        if (checked) next.add(severity);
        else next.delete(severity);
        onListFiltersChange({ ...listFilters, severities: next });
    };

    const clearAll = () => {
        onListFiltersChange(EMPTY_LIST_FILTERS);
    };

    const isDirectoryView = !isRepoView && !isGlobalView;
    const showScopeSection = !isGlobalView;
    const showOriginSection = entityLabel === "rules";

    return (
        <div className="grid gap-4 p-1">
            {showScopeSection && (
                <section className="grid gap-2">
                    <h4 className="text-sm leading-none font-medium">View</h4>
                    <p className="text-text-secondary text-sm">
                        Show or hide {entityLabel} from different scopes.
                    </p>
                    <div className="grid gap-2">
                        <div className="flex items-center space-x-2">
                            <Checkbox
                                id="scope-self"
                                checked={visibleScopes.self}
                                onCheckedChange={(checked) =>
                                    handleScopeChange("self", Boolean(checked))
                                }
                            />
                            <Label htmlFor="scope-self">
                                {isRepoView
                                    ? "Repository Rules"
                                    : "Directory Rules"}
                            </Label>
                        </div>

                        {isDirectoryView && (
                            <div className="flex items-center space-x-2">
                                <Checkbox
                                    id="scope-dir"
                                    checked={visibleScopes.dir}
                                    onCheckedChange={(checked) =>
                                        handleScopeChange(
                                            "dir",
                                            Boolean(checked),
                                        )
                                    }
                                />
                                <Label htmlFor="scope-dir">
                                    Inherited from other Directories
                                </Label>
                            </div>
                        )}

                        {isDirectoryView && (
                            <div className="flex items-center space-x-2">
                                <Checkbox
                                    id="scope-repo"
                                    checked={visibleScopes.repo}
                                    onCheckedChange={(checked) =>
                                        handleScopeChange(
                                            "repo",
                                            Boolean(checked),
                                        )
                                    }
                                />
                                <Label htmlFor="scope-repo">
                                    Inherited from Repository
                                </Label>
                            </div>
                        )}

                        <div className="flex items-center space-x-2">
                            <Checkbox
                                id="scope-global"
                                checked={visibleScopes.global}
                                onCheckedChange={(checked) =>
                                    handleScopeChange(
                                        "global",
                                        Boolean(checked),
                                    )
                                }
                            />
                            <Label htmlFor="scope-global">
                                Inherited from Global
                            </Label>
                        </div>

                        <div className="flex items-center space-x-2">
                            <Checkbox
                                id="scope-disabled"
                                checked={visibleScopes.disabled}
                                onCheckedChange={(checked) =>
                                    handleScopeChange(
                                        "disabled",
                                        Boolean(checked),
                                    )
                                }
                            />
                            <Label htmlFor="scope-disabled">
                                Disabled Rules
                            </Label>
                        </div>
                    </div>
                </section>
            )}

            {showOriginSection && (
                <section className="grid gap-2">
                    <h4 className="text-sm leading-none font-medium">Origin</h4>
                    <div className="grid gap-2">
                        {ORIGIN_OPTIONS.map((origin) => {
                            const fieldId = "origin-" + origin;
                            const labelText =
                                origin === "manual" ? "Manual" : origin;
                            return (
                                <div
                                    key={origin}
                                    className="flex items-center space-x-2">
                                    <Checkbox
                                        id={fieldId}
                                        checked={listFilters.origins.has(
                                            origin,
                                        )}
                                        onCheckedChange={(checked) =>
                                            toggleOrigin(
                                                origin,
                                                Boolean(checked),
                                            )
                                        }
                                    />
                                    <Label htmlFor={fieldId}>{labelText}</Label>
                                </div>
                            );
                        })}
                    </div>
                </section>
            )}

            <section className="grid gap-2">
                <h4 className="text-sm leading-none font-medium">Severity</h4>
                <div className="grid gap-2">
                    {SEVERITY_OPTIONS.map(({ value, label }) => {
                        const fieldId = "severity-" + value;
                        return (
                            <div
                                key={value}
                                className="flex items-center space-x-2">
                                <Checkbox
                                    id={fieldId}
                                    checked={listFilters.severities.has(value)}
                                    onCheckedChange={(checked) =>
                                        toggleSeverity(value, Boolean(checked))
                                    }
                                />
                                <Label htmlFor={fieldId}>{label}</Label>
                            </div>
                        );
                    })}
                </div>
            </section>

            <section className="grid gap-2">
                <h4 className="text-sm leading-none font-medium">Status</h4>
                <div className="flex items-center space-x-2">
                    <Checkbox
                        id="filter-sync-errors"
                        checked={listFilters.withSyncErrors}
                        onCheckedChange={(checked) =>
                            onListFiltersChange({
                                ...listFilters,
                                withSyncErrors: Boolean(checked),
                            })
                        }
                    />
                    <Label htmlFor="filter-sync-errors">
                        Has sync errors
                    </Label>
                </div>
            </section>

            {hasActiveListFilters(listFilters) && (
                <Button
                    size="xs"
                    variant="cancel"
                    onClick={clearAll}
                    className="w-fit">
                    Clear all filters
                </Button>
            )}
        </div>
    );
};
