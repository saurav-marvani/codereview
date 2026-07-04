"use client";

import { use, useEffect, useMemo, useState } from "react";
import useResizeObserver from "@hooks/use-resize-observer";
import { BaseUsageContract } from "@services/usage/types";
import { ExpandableContext } from "src/core/providers/expandable";
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
}: TooltipContentProps<number, string> & {
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
    const [graphRef, boundingRect] = useResizeObserver();
    const { isExpanded } = use(ExpandableContext);
    const [isMounted, setIsMounted] = useState(false);

    useEffect(() => {
        setIsMounted(true);
    }, []);

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

    // Outlier cap: when the max bar dwarfs the p95, scale outliers down to
    // 1.2×p95 so the rest of the chart stays readable; capped bars keep their
    // real values for the tooltip and get a marker dot at the top.
    const { maxDomain, chartData } = useMemo(() => {
        const totals = transformedData.map(
            (d) => d.input + d.output + d.outputReasoning,
        );

        if (totals.length === 0) {
            return { maxDomain: undefined, chartData: transformedData };
        }

        const sortedTotals = [...totals].sort((a, b) => a - b);
        const percentile95Index = Math.floor(sortedTotals.length * 0.95);
        const percentile95 = sortedTotals[percentile95Index];
        const maxValue = sortedTotals[sortedTotals.length - 1];

        if (maxValue <= percentile95 * 3) {
            return { maxDomain: undefined, chartData: transformedData };
        }

        const capLimit = percentile95 * 1.2;
        const cappedData = transformedData.map((d) => {
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
    }, [transformedData]);

    const isTiltedDate = chartData.length > 6 && !isExpanded;

    const minBarWidth = 40;
    const minWidth = chartData.length * minBarWidth;
    const chartWidth = Math.max(boundingRect.width, minWidth);
    const shouldScroll = chartWidth > boundingRect.width;

    const formatXTick = (x: string) => {
        if (filterType === "daily") {
            return new Date(x).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
            });
        }
        return x;
    };

    if (!isMounted) {
        return <div ref={graphRef} className="h-full w-full" />;
    }

    return (
        <div ref={graphRef} className="flex h-full w-full flex-col">
            {/* Custom Legend */}
            <div className="mb-2 flex items-center justify-center gap-6">
                {SERIES.map((series) => (
                    <div
                        key={series.key}
                        className="flex items-center gap-2">
                        <div
                            className="size-2 rounded-xs"
                            style={{ backgroundColor: series.color }}
                        />
                        <span className="text-text-secondary text-xs">
                            {series.label}
                        </span>
                    </div>
                ))}
            </div>

            <div className={shouldScroll ? "min-h-0 flex-1 overflow-x-auto" : "min-h-0 flex-1"}>
                <div
                    style={{
                        width: shouldScroll ? chartWidth : "100%",
                        height: "100%",
                    }}>
                    <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart
                            data={chartData}
                            margin={{
                                top: 8,
                                right: 12,
                                left: 0,
                                bottom: isTiltedDate ? 24 : 0,
                            }}>
                            <CartesianGrid {...rechartsGridProps} />
                            <XAxis
                                dataKey="label"
                                tickMargin={10}
                                interval={0}
                                angle={isTiltedDate ? -35 : 0}
                                textAnchor={isTiltedDate ? "end" : "middle"}
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
                                cursor={{ fill: "#30304b22" }}
                                content={
                                    <UsageTooltip
                                        formatLabel={formatXTick}
                                    />
                                }
                            />
                            <Bar
                                dataKey="input"
                                name="Input"
                                stackId="tokens"
                                fill={CHART_COLORS.info}
                                maxBarSize={24}
                                radius={[0, 0, 5, 5]}
                            />
                            <Bar
                                dataKey="output"
                                name="Output"
                                stackId="tokens"
                                fill={CHART_COLORS.success}
                                maxBarSize={24}
                            />
                            <Bar
                                dataKey="outputReasoning"
                                name="Reasoning"
                                stackId="tokens"
                                fill={CHART_COLORS.warning}
                                maxBarSize={24}
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
            </div>

            {maxDomain && (
                <div className="text-warning mt-2 flex items-center gap-2 px-2 text-xs">
                    <div className="bg-warning size-2 rounded-full" />
                    <span>
                        Some values exceed the scale. Hover over bars to see
                        actual values.
                    </span>
                </div>
            )}
        </div>
    );
};
