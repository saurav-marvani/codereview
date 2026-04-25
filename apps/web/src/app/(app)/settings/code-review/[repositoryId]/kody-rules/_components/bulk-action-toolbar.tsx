"use client";

import { Button } from "@components/ui/button";
import { Trash2, X } from "lucide-react";

type BulkActionToolbarProps = {
    selectedCount: number;
    eligibleCount: number;
    isDeleting: boolean;
    onSelectAll: () => void;
    onClear: () => void;
    onDelete: () => void;
};

// Sticky toolbar that appears below the filters when at least one rule is
// selected. Lets the user expand the selection to every visible-eligible
// rule, clear it, or trigger a bulk delete.
export const BulkActionToolbar = ({
    selectedCount,
    eligibleCount,
    isDeleting,
    onSelectAll,
    onClear,
    onDelete,
}: BulkActionToolbarProps) => {
    if (selectedCount === 0) return null;

    const allSelected = selectedCount >= eligibleCount && eligibleCount > 0;

    return (
        <div
            className="bg-card-lv2 border-card-lv3 sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 shadow-sm"
            role="toolbar"
            aria-label="Bulk actions">
            <span className="text-text-primary text-sm tabular-nums">
                <strong>{selectedCount}</strong> of {eligibleCount} selected
            </span>

            {!allSelected && (
                <Button size="xs" variant="secondary" onClick={onSelectAll}>
                    Select all visible
                </Button>
            )}

            <Button
                size="xs"
                variant="cancel"
                leftIcon={<X aria-hidden />}
                onClick={onClear}
                aria-label="Clear selection">
                Clear
            </Button>

            <div className="flex-1" />

            <Button
                size="xs"
                variant="primary"
                loading={isDeleting}
                disabled={isDeleting}
                onClick={onDelete}
                leftIcon={<Trash2 aria-hidden />}
                className="[--button-foreground:var(--color-danger)]">
                Delete {selectedCount}
            </Button>
        </div>
    );
};
