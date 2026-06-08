import Link from "next/link";
import { Card, CardTitle } from "@components/ui/card";

import type {
    IgnoredCriticalsHighlight,
    NegativeVoteRateHighlight,
} from "../../_services/analytics/review/fetch";
import { PercentageDiff } from "../../_components/percentage-diff";

const pct = (value: number) => `${Math.round(value * 100)}%`;

const MetricCard = ({
    title,
    children,
    footer,
}: React.PropsWithChildren & {
    title: string;
    footer?: React.ReactNode;
}) => (
    <Card color="lv1" className="min-h-40 justify-between gap-2 p-5">
        <CardTitle className="text-text-secondary text-xs leading-snug font-semibold">
            {title}
        </CardTitle>
        <div className="text-3xl font-bold">{children}</div>
        {footer && (
            <div className="text-text-tertiary text-xs leading-snug">
                {footer}
            </div>
        )}
    </Card>
);

export const ReviewCards = ({
    sent,
    implemented,
    negativeVoteRate,
    ignoredCriticals,
}: {
    sent: number;
    implemented: number;
    negativeVoteRate: NegativeVoteRateHighlight | undefined;
    ignoredCriticals: IgnoredCriticalsHighlight | undefined;
}) => {
    const rate = sent > 0 ? implemented / sent : 0;
    const current = negativeVoteRate?.currentPeriod;
    const trend = negativeVoteRate?.comparison?.trend;
    const criticalsCount = ignoredCriticals?.count ?? 0;

    // A rate over a handful of reactions is statistical noise — below this
    // we show raw counts instead of a percentage.
    const MIN_REACTIONS_FOR_RATE = 10;
    const totalReactions =
        (current?.thumbsUp ?? 0) + (current?.thumbsDown ?? 0);
    const lowSample = totalReactions < MIN_REACTIONS_FOR_RATE;

    return (
        <div className="grid grid-cols-4 gap-2">
            <MetricCard
                title="Implementation rate"
                footer={`${implemented} of ${sent} suggestions implemented`}>
                {pct(rate)}
            </MetricCard>

            <MetricCard title="Suggestions sent" footer="in this period">
                {sent}
            </MetricCard>

            <MetricCard
                title="Negative vote rate"
                footer={
                    totalReactions === 0
                        ? "no feedback in this period"
                        : lowSample
                          ? `only ${totalReactions} reactions — too few to be a rate`
                          : `${current?.thumbsDown ?? 0} 👎 · ${current?.thumbsUp ?? 0} 👍 in this period`
                }>
                {totalReactions === 0 ? (
                    <span className="text-text-tertiary text-2xl">—</span>
                ) : lowSample ? (
                    // Below the threshold a percentage is noise — show the raw
                    // counts instead so it doesn't read as a real rate.
                    <span className="flex items-baseline gap-2 text-2xl">
                        <span className="text-danger">
                            {current?.thumbsDown ?? 0} 👎
                        </span>
                        <span className="text-text-tertiary text-lg">
                            / {totalReactions}
                        </span>
                    </span>
                ) : (
                    <span className="flex items-baseline gap-3">
                        {pct(current?.negativeRate ?? 0)}
                        {trend && trend !== "unchanged" && (
                            <span className="text-sm font-semibold">
                                <PercentageDiff
                                    mode="lower-is-better"
                                    status={
                                        trend === "improved" ? "good" : "bad"
                                    }>
                                    {Math.abs(
                                        negativeVoteRate?.comparison
                                            ?.percentageChange ?? 0,
                                    )}
                                    %
                                </PercentageDiff>
                            </span>
                        )}
                    </span>
                )}
            </MetricCard>

            <Link
                href="/review-suggestions?severity=critical&implementationStatus=not_implemented"
                className="block">
                <Card
                    color="lv1"
                    className="border-danger/40 hover:border-danger/70 min-h-40 justify-between gap-2 border p-5 transition-colors">
                    <CardTitle className="text-text-secondary text-xs leading-snug font-semibold">
                        ⚠️ Criticals ignored in merged PRs
                    </CardTitle>
                    <div className="text-danger text-3xl font-bold">
                        {criticalsCount}
                    </div>
                    <div className="text-text-tertiary text-xs leading-snug">
                        critical suggestions left unimplemented →
                    </div>
                </Card>
            </Link>
        </div>
    );
};
