import Link from "next/link";
import {
    Card,
    CardContent,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@components/ui/card";

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
    <Card color="lv1" className="h-36">
        <CardHeader className="pb-0">
            <CardTitle className="text-text-secondary text-xs font-semibold">
                {title}
            </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-1 items-center text-3xl font-bold">
            {children}
        </CardContent>
        {footer && (
            <CardFooter className="text-text-tertiary pt-0 text-xs">
                {footer}
            </CardFooter>
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
                    current
                        ? `${current.thumbsDown} 👎 · ${current.thumbsUp} 👍 in this period`
                        : "no feedback in this period"
                }>
                <span className="flex items-baseline gap-3">
                    {pct(current?.negativeRate ?? 0)}
                    {trend && trend !== "unchanged" && (
                        <span className="text-sm font-semibold">
                            <PercentageDiff
                                mode="lower-is-better"
                                status={trend === "improved" ? "good" : "bad"}>
                                {Math.abs(
                                    negativeVoteRate?.comparison
                                        ?.percentageChange ?? 0,
                                )}
                                %
                            </PercentageDiff>
                        </span>
                    )}
                </span>
            </MetricCard>

            <Link
                href="/review-suggestions?severity=critical&implementationStatus=not_implemented"
                className="block">
                <Card
                    color="lv1"
                    className="border-danger/40 hover:border-danger/70 h-36 border transition-colors">
                    <CardHeader className="pb-0">
                        <CardTitle className="text-text-secondary text-xs font-semibold">
                            ⚠️ Criticals ignored in merged PRs
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="text-danger flex flex-1 items-center text-3xl font-bold">
                        {criticalsCount}
                    </CardContent>
                    <CardFooter className="text-text-tertiary pt-0 text-xs">
                        critical suggestions left unimplemented →
                    </CardFooter>
                </Card>
            </Link>
        </div>
    );
};
