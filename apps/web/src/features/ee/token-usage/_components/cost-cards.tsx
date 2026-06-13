import { Card } from "@components/ui/card";
import { BadgeDollarSignIcon, CalendarIcon, GitPullRequestIcon } from "lucide-react";

function formatCurrency(amount: number): string {
    if (amount >= 1000) {
        // Truncate instead of round to avoid overstating values
        const truncated = Math.floor((amount / 1000) * 100) / 100;
        return `$${truncated.toFixed(2)}K`;
    }
    return `$${amount.toFixed(2)}`;
}

export const CostCards = ({
    totalCost,
    avgPerDay,
    avgPerPR,
}: {
    totalCost: number;
    avgPerDay: number;
    avgPerPR: number;
}) => {
    const cards = [
        {
            label: "Total Cost",
            value: totalCost,
            icon: BadgeDollarSignIcon,
            iconBg: "bg-success/10",
            iconColor: "text-success",
        },
        {
            label: "Avg. per Day",
            value: avgPerDay,
            icon: CalendarIcon,
            iconBg: "bg-secondary-dark",
            iconColor: "text-secondary-light",
        },
        {
            label: "Avg. per PR",
            value: avgPerPR,
            icon: GitPullRequestIcon,
            iconBg: "bg-tertiary-dark",
            iconColor: "text-tertiary-light",
        },
    ];

    return (
        <Card className="overflow-hidden">
            <div className="grid grid-cols-3 divide-x divide-[var(--color-card-lv1)]">
                {cards.map((card) => {
                    const Icon = card.icon;
                    return (
                        <div
                            key={card.label}
                            className="flex items-center gap-4 p-4">
                            <div
                                className={`${card.iconBg} flex size-12 shrink-0 items-center justify-center rounded-xl`}>
                                <Icon className={`${card.iconColor} size-6`} />
                            </div>
                            <div className="space-y-0.5">
                                <p className="text-text-secondary text-sm">
                                    {card.label}
                                </p>
                                <p className="text-text-primary text-2xl font-semibold tabular-nums">
                                    {formatCurrency(card.value)}
                                </p>
                            </div>
                        </div>
                    );
                })}
            </div>
        </Card>
    );
};
