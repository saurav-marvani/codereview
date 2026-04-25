"use client";

import { Alert, AlertDescription, AlertTitle } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import { AlertTriangle } from "lucide-react";

type OrphanRulesBannerProps = {
    count: number;
    isFilteringOrphans: boolean;
    onReviewClick: () => void;
    onDismissClick: () => void;
};

export const OrphanRulesBanner = ({
    count,
    isFilteringOrphans,
    onReviewClick,
    onDismissClick,
}: OrphanRulesBannerProps) => {
    if (count === 0) return null;

    const pluralized = count === 1 ? "rule is" : "rules are";

    return (
        <Alert variant="warning">
            <AlertTriangle aria-hidden />
            <AlertTitle>
                {count} auto-imported {pluralized} still active
            </AlertTitle>
            <AlertDescription>
                Auto-sync is disabled for this repository, but these rules were
                added while it was enabled and may now be stale. Review them
                and remove any you no longer need.
                <div className="mt-3 flex items-center gap-2">
                    {isFilteringOrphans ? (
                        <Button
                            size="xs"
                            variant="secondary"
                            onClick={onDismissClick}>
                            Show all rules
                        </Button>
                    ) : (
                        <Button
                            size="xs"
                            variant="primary"
                            onClick={onReviewClick}>
                            Review orphan rules
                        </Button>
                    )}
                </div>
            </AlertDescription>
        </Alert>
    );
};
