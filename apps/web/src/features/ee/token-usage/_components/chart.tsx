"use client";

import { useEffect, useMemo, useState } from "react";
import { BaseUsageContract } from "@services/usage/types";
import { cn } from "src/core/utils/components";
import {
    Bar,
    CartesianGrid,
    ComposedChart,
    ResponsiveContainer,
    Scatter,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import type { TooltipContentProps } from "recharts";

import {
    CHART_COLORS,
    rechartsAxisProps,
    rechartsGridProps,
} from "../../cockpit/_components/charts/recharts-shared";

const SERIES = [
    { key: "input", label: "Input", color: CHART_COLORS.info },
    { key: "output", label: "Output", color: CHART_COLORS.success },
    { key: "outputReasoning", label: "Reasoning", color: CHART_COLORS.warning },
] as const;

type SeriesKey = (typeof SERIES)[number]["key"];

/**
 * Cockpit charts never scroll horizontally — series are bounded to fit the
 * container. Unbounded dimensions (PR/review/developer) show the top
 * consumers by total tokens.
 */
const TOP_N = 24;

type ChartRow = Record<SeriesKey, number> & {
    label: string;
    isCapped: boolean;
    originalInput: number;
    originalOutput: number;
    originalOutputReasoning: number;
    capMarker?: number;
};

const formatTokens = (t: number) => {
    if (t === 0) return "0";
    if (t < 1000) return t.toString();
    if (t < 1000000) return `${(t / 1000).toFixed(1)}K`;
    return `${(t / 1000000).toFixed(1)}M`;
};

const UsageTooltip = ({
    active,
    payload,
    label,
    formatLabel,
}: Partial<TooltipContentProps<number, string>> & {
    formatLabel?: (label: string) => string;
}) => {
    if (!active || !payload?.length) return null;

    const row = payload[0]?.payload as ChartRow | undefined;
    if (!row) return null;

    // Show the REAL values (pre-cap); the bar heights may be scaled down.
    const originals: Record<SeriesKey, number> = {
        input: row.originalInput,
        output: row.originalOutput,
        outputReasoning: row.originalOutputReasoning,
    };

    return (
        <div className="bg-card-lv1 border-card-lv3 min-w-36 rounded-lg border px-3 py-2 shadow-xl">
            <div className="text-text-primary mb-1.5 text-xs font-semibold">
                {formatLabel ? formatLabel(String(label)) : label}
                {row.isCapped && (
                    <span className="text-warning ml-2 font-normal">
                        exceeds scale
                    </span>
                )}
            </div>
            {SERIES.map((series) => (
                <div
                    key={series.key}
                    className="text-text-secondary flex items-center gap-2 py-0.5 text-xs">
                    <span
                        className="size-2 shrink-0 rounded-xs"
                        style={{ backgroundColor: series.color }}
                    />
                    <span className="flex-1">{series.label}</span>
                    <span className="text-text-primary font-mono font-semibold">
                        {formatTokens(originals[series.key])}
                    </span>
                </div>
            ))}
        </div>
    );
};

export const Chart = ({
    data,
    filterType,
}: {
    data: Array<
        BaseUsageContract & {
            prNumber?: number;
            developer?: string;
            date?: string;
            review?: string;
        }
    >;
    filterType: string;
}) => {
    const [isMounted, setIsMounted] = useState(false);
    const [hidden, setHidden] = useState<Record<string, boolean>>({});

    useEffect(() => {
        setIsMounted(true);
    }, []);

    // Cockpit-style legend toggles — never allow hiding every series.
    const toggle = (key: SeriesKey) => {
        setHidden((prev) => {
            const next = { ...prev, [key]: !prev[key] };
            if (SERIES.every((s) => next[s.key])) return prev;
            return next;
        });
    };

    const xAccessor = useMemo(() => {
        switch (filterType) {
            case "daily":
                return "date" as const;
            case "by-pr":
                return "prNumber" as const;
            case "by-developer":
                return "developer" as const;
            case "by-review":
                return "review" as const;
            default:
                return "date" as const;
        }
    }, [filterType]);

    // Rows arrive one-per-model — merge them per x value.
    const transformedData = useMemo(() => {
        const merged: Record<string, ChartRow> = {};
        data.forEach((d) => {
            const key =
                filterType === "by-pr"
                    ? `#${d[xAccessor]}`
                    : String(d[xAccessor]);

            if (!merged[key]) {
                merged[key] = {
                    label: key,
                    input: d.input || 0,
                    output: d.output || 0,
                    outputReasoning: d.outputReasoning || 0,
                    isCapped: false,
                    originalInput: d.input || 0,
                    originalOutput: d.output || 0,
                    originalOutputReasoning: d.outputReasoning || 0,
                };
            } else {
                merged[key].input += d.input || 0;
                merged[key].output += d.output || 0;
                merged[key].outputReasoning += d.outputReasoning || 0;
                merged[key].originalInput = merged[key].input;
                merged[key].originalOutput = merged[key].output;
                merged[key].originalOutputReasoning =
                    merged[key].outputReasoning;
            }
        });

        return Object.values(merged);
    }, [data, filterType, xAccessor]);

    // Cockpit charts never scroll — they bound the series to the container.
    // Daily is bounded by the date range; the categorical dimensions
    // (PR/review/developer) are unbounded, so show the TOP consumers by
    // total tokens, which is the question this screen answers.
    const isTopN = filterType !== "daily";
    const { boundedData, droppedCount } = useMemo(() => {
        if (!isTopN || transformedData.length <= TOP_N) {
            return { boundedData: transformedData, droppedCount: 0 };
        }
        const sorted = [...transformedData].sort(
            (a, b) =>
                b.input + b.output + b.outputReasoning -
                (a.input + a.output + a.outputReasoning),
        );
        return {
            boundedData: sorted.slice(0, TOP_N),
            droppedCount: transformedData.length - TOP_N,
        };
    }, [transformedData, isTopN]);

    // Outlier cap: when the max bar dwarfs the p95, scale outliers down to
    // 1.2×p95 so the rest of the chart stays readable; capped bars keep their
    // real values for the tooltip and get a marker dot at the top.
    const { maxDomain, chartData } = useMemo(() => {
        const totals = boundedData.map(
            (d) => d.input + d.output + d.outputReasoning,
        );

        if (totals.length === 0) {
            return { maxDomain: undefined, chartData: boundedData };
        }

        const sortedTotals = [...totals].sort((a, b) => a - b);
        const percentile95Index = Math.floor(sortedTotals.length * 0.95);
        const percentile95 = sortedTotals[percentile95Index];
        const maxValue = sortedTotals[sortedTotals.length - 1];

        if (maxValue <= percentile95 * 3) {
            return { maxDomain: undefined, chartData: boundedData };
        }

        const capLimit = percentile95 * 1.2;
        const cappedData = boundedData.map((d) => {
            const total = d.input + d.output + d.outputReasoning;
            if (total <= capLimit) return d;

            const ratio = capLimit / total;
            return {
                ...d,
                isCapped: true,
                input: d.input * ratio,
                output: d.output * ratio,
                outputReasoning: d.outputReasoning * ratio,
                capMarker: capLimit * 0.98,
            };
        });

        return { maxDomain: capLimit, chartData: cappedData };
    }, [boundedData]);

    // Tooltip shows the full label; the axis truncates long ones
    // (by-review's "#PR · shortId").
    const formatLabel = (x: string) => {
        if (filterType === "daily") {
            return new Date(x).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
            });
        }
        return x;
    };
    const formatXTick = (x: string) => {
        const label = formatLabel(x);
        return label.length > 12 ? `${label.slice(0, 11)}…` : label;
    };

    if (!isMounted) {
        return <div className="h-full w-full" />;
    }

    return (
        <div className="flex h-full w-full flex-col gap-4">
            {droppedCount > 0 && (
                <p className="text-text-tertiary text-xs">
                    Showing the top {TOP_N} of {TOP_N + droppedCount} by total
                    tokens. Narrow the date range or filters to see the rest.
                </p>
            )}
            <div className="min-h-0 flex-1">
                <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart
                            data={chartData}
                            margin={{ top: 10, right: 12, left: -8, bottom: 0 }}>
                            <CartesianGrid {...rechartsGridProps} />
                            {/* Auto tick skipping (cockpit convention):
                                dense dimensions show a readable subset of
                                labels; every bar stays hoverable and the
                                tooltip carries the full identity. */}
                            <XAxis
                                dataKey="label"
                                tickMargin={8}
                                minTickGap={24}
                                tickFormatter={(value) =>
                                    formatXTick(String(value))
                                }
                                {...rechartsAxisProps}
                            />
                            <YAxis
                                domain={maxDomain ? [0, maxDomain] : [0, "auto"]}
                                allowDataOverflow={Boolean(maxDomain)}
                                tickFormatter={(value) =>
                                    formatTokens(Number(value))
                                }
                                {...rechartsAxisProps}
                            />
                            <Tooltip
                                cursor={{ fill: "#20203266" }}
                                content={
                                    <UsageTooltip
                                        formatLabel={formatLabel}
                                    />
                                }
                            />
                            <Bar
                                dataKey="input"
                                name="Input"
                                stackId="tokens"
                                hide={hidden.input}
                                fill={CHART_COLORS.info}
                                maxBarSize={28}
                                radius={[0, 0, 5, 5]}
                            />
                            <Bar
                                dataKey="output"
                                name="Output"
                                stackId="tokens"
                                hide={hidden.output}
                                fill={CHART_COLORS.success}
                                maxBarSize={28}
                            />
                            <Bar
                                dataKey="outputReasoning"
                                name="Reasoning"
                                stackId="tokens"
                                hide={hidden.outputReasoning}
                                fill={CHART_COLORS.warning}
                                maxBarSize={28}
                                radius={[5, 5, 0, 0]}
                            />
                            {maxDomain && (
                                <Scatter
                                    dataKey="capMarker"
                                    name="Exceeds scale"
                                    fill={CHART_COLORS.primary}
                                    shape={(props: any) =>
                                        typeof props.cy === "number" ? (
                                            <circle
                                                cx={props.cx}
                                                cy={props.cy}
                                                r={4}
                                                fill={CHART_COLORS.primary}
                                                stroke="#1f2937"
                                                strokeWidth={2}
                                            />
                                        ) : (
                                            <g />
                                        )
                                    }
                                />
                            )}
                    </ComposedChart>
                </ResponsiveContainer>
            </div>

            <div className="flex items-center gap-5">
                {SERIES.map((series) => (
                    <button
                        key={series.key}
                        type="button"
                        onClick={() => toggle(series.key)}
                        className="flex cursor-pointer items-center gap-2 text-xs">
                        <span
                            style={{ backgroundColor: series.color }}
                            className={cn(
                                "size-3 rounded-full",
                                hidden[series.key] && "bg-text-tertiary!",
                            )}
                        />
                        {series.label}
                    </button>
                ))}
                {maxDomain && (
                    <span className="text-warning ml-auto flex items-center gap-2 text-xs">
                        <span className="bg-warning size-2 rounded-full" />
                        Some values exceed the scale — hover for actual values.
                    </span>
                )}
            </div>
        </div>
    );
};
