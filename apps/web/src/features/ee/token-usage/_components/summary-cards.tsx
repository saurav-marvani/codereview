import { Button } from "@components/ui/button";
import { Card, CardTitle } from "@components/ui/card";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import { HelpCircleIcon } from "lucide-react";

function formatNumber(num: number): string {
    if (num >= 1_000_000) {
        return `${(num / 1_000_000).toFixed(2)}M`;
    }
    if (num >= 1_000) {
        return `${(num / 1_000).toFixed(1)}K`;
    }
    return num.toLocaleString();
}

function formatCurrency(amount: number): string {
    if (amount >= 1000) {
        // Truncate instead of round to avoid overstating values
        const truncated = Math.floor((amount / 1000) * 100) / 100;
        return `$${truncated.toFixed(2)}K`;
    }
    return `$${amount.toFixed(2)}`;
}

interface TotalUsageShape {
    input: number; // uncached input shown to user
    output: number;
    total: number;
    outputReasoning: number;
    cacheRead: number;
    cacheWrite: number;
    totalCost: number;
    inputCost: number;
    outputCost: number;
    cacheReadCost: number;
    cacheWriteCost: number;
}

interface CardSpec {
    label: string;
    value: string;
    footer?: string;
    tooltip?: string;
}

/**
 * KPI row in the cockpit MetricCard vocabulary (see
 * cockpit/@kodusReviewTab/_components/review-cards.tsx): label on top,
 * one bold value, quiet footer. Cost is the lead metric; the token cards
 * carry their own billed cost in the footer, so nothing repeats.
 */
export const SummaryCards = ({
    totalUsage,
    avgPerDay,
    avgPerPR,
}: {
    totalUsage: TotalUsageShape;
    avgPerDay: number;
    avgPerPR: number;
}) => {
    // Backend's `totals.input` already excludes cache reads — name the local
    // alias explicitly so the rendering is unambiguous.
    const uncachedInput = Math.max(0, totalUsage.input - totalUsage.cacheRead);

    const cards: CardSpec[] = [
        {
            label: "Total cost",
            value: formatCurrency(totalUsage.totalCost),
            footer: `≈ ${formatCurrency(avgPerDay)}/day · ${formatCurrency(avgPerPR)}/PR`,
        },
        {
            label: "Total tokens",
            value: formatNumber(totalUsage.total),
            footer:
                totalUsage.outputReasoning > 0
                    ? `incl. ${formatNumber(totalUsage.outputReasoning)} reasoning`
                    : undefined,
        },
        {
            label: "Uncached input",
            value: formatNumber(uncachedInput),
            footer: formatCurrency(totalUsage.inputCost),
        },
        {
            label: "Cache read",
            value: formatNumber(totalUsage.cacheRead),
            footer: formatCurrency(totalUsage.cacheReadCost),
            tooltip:
                "Input tokens served from the provider's prompt cache. Already counted inside input tokens; shown separately because they're billed at a discounted rate.",
        },
        {
            label: "Output",
            value: formatNumber(totalUsage.output),
            footer: formatCurrency(totalUsage.outputCost),
            tooltip:
                totalUsage.outputReasoning > 0
                    ? `Includes ${formatNumber(totalUsage.outputReasoning)} reasoning tokens (billed at the output rate).`
                    : undefined,
        },
    ];

    if (totalUsage.cacheWrite > 0) {
        cards.push({
            label: "Cache write",
            value: formatNumber(totalUsage.cacheWrite),
            footer: formatCurrency(totalUsage.cacheWriteCost),
            tooltip:
                "Input tokens that populated a cache entry on this call (Anthropic). Other providers don't charge a write premium.",
        });
    }

    return (
        <div
            className="grid gap-2"
            style={{
                gridTemplateColumns: `repeat(${cards.length}, minmax(0, 1fr))`,
            }}>
            {cards.map((card) => (
                <Card
                    key={card.label}
                    color="lv1"
                    className="justify-between gap-2 p-5">
                    <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-text-secondary text-xs leading-snug font-semibold">
                            {card.label}
                        </CardTitle>
                        {card.tooltip && (
                            <Tooltip>
                                <TooltipContent className="text-text-primary max-w-64 text-pretty">
                                    {card.tooltip}
                                </TooltipContent>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="cancel"
                                        size="icon-xs"
                                        className="-my-1">
                                        <HelpCircleIcon className="size-3.5" />
                                    </Button>
                                </TooltipTrigger>
                            </Tooltip>
                        )}
                    </div>
                    <div className="text-3xl font-bold tabular-nums">
                        {card.value}
                    </div>
                    <div className="text-text-tertiary min-h-4 text-xs leading-snug tabular-nums">
                        {card.footer}
                    </div>
                </Card>
            ))}
        </div>
    );
};
