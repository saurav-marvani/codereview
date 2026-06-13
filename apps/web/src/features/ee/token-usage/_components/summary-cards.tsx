import { Button } from "@components/ui/button";
import { Card } from "@components/ui/card";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@components/ui/tooltip";
import {
    ArrowDownIcon,
    ArrowUpIcon,
    DatabaseIcon,
    HelpCircleIcon,
    LayersIcon,
    UploadIcon,
} from "lucide-react";

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
        const truncated = Math.floor((amount / 1000) * 100) / 100;
        return `$${truncated.toFixed(2)}K`;
    }
    return `$${amount.toFixed(2)}`;
}

const colorStyles = {
    primary: {
        bgDark: "bg-primary-dark",
        text: "text-primary-light",
    },
    secondary: {
        bgDark: "bg-secondary-dark",
        text: "text-secondary-light",
    },
    tertiary: {
        bgDark: "bg-tertiary-dark",
        text: "text-tertiary-light",
    },
    success: {
        bgDark: "bg-success/10",
        text: "text-success",
    },
} as const;

type CardColor = keyof typeof colorStyles;

interface TotalUsageShape {
    input: number;          // uncached input shown to user
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
    tokens: number;
    cost: number;
    icon: typeof ArrowDownIcon;
    color: CardColor;
    tooltip?: string;
}

export const SummaryCards = ({ totalUsage }: { totalUsage: TotalUsageShape }) => {
    // Backend's `totals.input` already excludes cache reads — name the local
    // alias explicitly so the rendering is unambiguous.
    const uncachedInput = Math.max(0, totalUsage.input - totalUsage.cacheRead);

    const cards: CardSpec[] = [
        {
            label: "Uncached Input",
            tokens: uncachedInput,
            cost: totalUsage.inputCost,
            icon: ArrowDownIcon,
            color: "primary",
        },
        {
            label: "Cache Read",
            tokens: totalUsage.cacheRead,
            cost: totalUsage.cacheReadCost,
            icon: DatabaseIcon,
            color: "tertiary",
            tooltip:
                "Input tokens served from the provider's prompt cache. Already counted inside Input Tokens — shown separately because they're billed at a discounted rate.",
        },
        {
            label: "Output",
            tokens: totalUsage.output,
            cost: totalUsage.outputCost,
            icon: ArrowUpIcon,
            color: "secondary",
            tooltip:
                totalUsage.outputReasoning > 0
                    ? `Includes ${formatNumber(totalUsage.outputReasoning)} reasoning tokens (billed at the output rate).`
                    : undefined,
        },
    ];

    if (totalUsage.cacheWrite > 0) {
        cards.push({
            label: "Cache Write",
            tokens: totalUsage.cacheWrite,
            cost: totalUsage.cacheWriteCost,
            icon: UploadIcon,
            color: "tertiary",
            tooltip:
                "Input tokens that populated a cache entry on this call (Anthropic). Other providers don't charge a write premium.",
        });
    }

    cards.push({
        label: "Total",
        tokens: totalUsage.total,
        cost: totalUsage.totalCost,
        icon: LayersIcon,
        color: "success",
    });

    return (
        <div
            className="grid gap-3"
            style={{ gridTemplateColumns: `repeat(${cards.length}, minmax(0, 1fr))` }}>
            {cards.map((card) => {
                const Icon = card.icon;
                const styles = colorStyles[card.color];
                return (
                    <Card
                        key={card.label}
                        className="group relative overflow-hidden p-4">
                        <div className="relative space-y-2">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <div
                                        className={`flex size-7 items-center justify-center rounded-md ${styles.bgDark}`}>
                                        <Icon
                                            className={`size-4 ${styles.text}`}
                                        />
                                    </div>
                                    <span className="text-text-secondary text-sm">
                                        {card.label}
                                    </span>
                                </div>
                                {card.tooltip && (
                                    <Tooltip>
                                        <TooltipContent className="text-text-primary max-w-64 text-pretty">
                                            {card.tooltip}
                                        </TooltipContent>
                                        <TooltipTrigger asChild>
                                            <Button
                                                variant="cancel"
                                                size="icon-xs">
                                                <HelpCircleIcon className="size-3.5" />
                                            </Button>
                                        </TooltipTrigger>
                                    </Tooltip>
                                )}
                            </div>
                            <p className="text-text-primary text-2xl font-semibold tabular-nums">
                                {formatNumber(card.tokens)}
                            </p>
                            <p className="text-text-tertiary text-sm tabular-nums">
                                {formatCurrency(card.cost)}
                            </p>
                        </div>
                    </Card>
                );
            })}
        </div>
    );
};
