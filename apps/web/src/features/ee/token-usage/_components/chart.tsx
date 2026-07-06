"use client";

import { use, useEffect, useMemo, useState } from "react";
import useResizeObserver from "@hooks/use-resize-observer";
import { BaseUsageContract } from "@services/usage/types";
import {
    Bar,
    BarChart,
    CartesianGrid,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import { ExpandableContext } from "src/core/providers/expandable";
import {
    rechartsAxisProps,
    rechartsGridProps,
    RechartsTooltip,
} from "src/features/ee/cockpit/_components/charts/recharts-shared";

// Input / output / reasoning colours — kept identical to the previous
// (victory) implementation so the palette stays stable across the port to
// recharts. These are semantic (blue = input, green = output, orange =
// reasoning) and don't map onto the cockpit brand palette.
const CHART_COLORS = {
    input: "#3b82f6", // blue
    output: "#22c55e", // green
    reasoning: "#f97316", // orange
};

const legendData = [
    { name: "Input", color: CHART_COLORS.input },
    { name: "Output", color: CHART_COLORS.output },
    { name: "Reasoning", color: CHART_COLORS.reasoning },
];

const formatTicks = (t: number) => {
    if (t === 0) return "0";
    if (t < 1000) return t.toString();
    if (t < 1_000_000) return `${(t / 1000).toFixed(1)}K`;
    return `${(t / 1_000_000).toFixed(1)}M`;
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

    const xAccessor =
        filterType === "by-pr"
            ? "prNumber"
            : filterType === "by-developer"
              ? "developer"
              : "date";

    // Merge rows that share the same x bucket, summing each token series.
    const transformedData = useMemo(() => {
        const merged: Record<
            string,
            {
                label: string;
                rawX: unknown;
                input: number;
                output: number;
                outputReasoning: number;
            }
        > = {};

        data.forEach((d) => {
            const rawX = d[xAccessor as keyof typeof d];
            const key =
                filterType === "by-pr" ? `#${rawX}` : String(rawX);

            if (!merged[key]) {
                merged[key] = {
                    label: key,
                    rawX,
                    input: d.input || 0,
                    output: d.output || 0,
                    outputReasoning: d.outputReasoning || 0,
                };
            } else {
                merged[key].input += d.input || 0;
                merged[key].output += d.output || 0;
                merged[key].outputReasoning += d.outputReasoning || 0;
            }
        });

        return Object.values(merged);
    }, [data, filterType, xAccessor]);

    // Cap the visible y-scale when one bucket dwarfs the rest (max > 3× the
    // 95th percentile). We keep the *real* values in the data and clip the
    // axis with `allowDataOverflow` — so the tooltip still shows true numbers
    // and only the drawn bars are capped.
    const maxDomain = useMemo(() => {
        const totals = transformedData.map(
            (d) => d.input + d.output + d.outputReasoning,
        );
        if (totals.length === 0) return undefined;

        const sorted = [...totals].sort((a, b) => a - b);
        const p95 = sorted[Math.floor(sorted.length * 0.95)];
        const maxValue = sorted[sorted.length - 1];

        return maxValue > p95 * 3 ? p95 * 1.2 : undefined;
    }, [transformedData]);

    const isTiltedDate = transformedData.length > 6 && !isExpanded;

    const minBarWidth = 40;
    const minWidth = transformedData.length * minBarWidth;
    const chartWidth = Math.max(boundingRect.width, minWidth);
    const shouldScroll = chartWidth > boundingRect.width;

    const formatXLabel = (x: string) => {
        if (filterType === "daily" && x) {
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

    const chartHeight = shouldScroll
        ? boundingRect.height - 60
        : boundingRect.height - 40;

    return (
        <div ref={graphRef} className="flex h-full w-full flex-col">
            {/* Custom legend (unchanged from the victory version). */}
            <div className="mb-2 flex items-center justify-center gap-6">
                {legendData.map((item) => (
                    <div key={item.name} className="flex items-center gap-2">
                        <div
                            className="size-3 rounded-sm"
                            style={{ backgroundColor: item.color }}
                        />
                        <span className="text-text-secondary text-xs">
                            {item.name}
                        </span>
                    </div>
                ))}
            </div>

            <div
                className={shouldScroll ? "overflow-x-auto" : ""}
                style={{ maxHeight: boundingRect.height - 40 }}>
                <div style={{ width: chartWidth, height: chartHeight }}>
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                            data={transformedData}
                            margin={{
                                top: 10,
                                right: 20,
                                left: 0,
                                bottom: isTiltedDate ? 16 : 0,
                            }}>
                            <CartesianGrid {...rechartsGridProps} />
                            <XAxis
                                dataKey="label"
                                interval={0}
                                tickMargin={8}
                                tickFormatter={formatXLabel}
                                angle={isTiltedDate ? -35 : 0}
                                textAnchor={isTiltedDate ? "end" : "middle"}
                                height={isTiltedDate ? 50 : 30}
                                {...rechartsAxisProps}
                            />
                            <YAxis
                                width={48}
                                tickFormatter={formatTicks}
                                domain={maxDomain ? [0, maxDomain] : undefined}
                                allowDataOverflow={Boolean(maxDomain)}
                                {...rechartsAxisProps}
                            />
                            <Tooltip
                                cursor={{ fill: "#20203266" }}
                                content={
                                    <RechartsTooltip
                                        hideZero
                                        labelFormatter={(l) => formatXLabel(l)}
                                        valueFormatter={(v) => formatTicks(v)}
                                    />
                                }
                            />
                            <Bar
                                dataKey="input"
                                name="Input"
                                stackId="tokens"
                                fill={CHART_COLORS.input}
                                maxBarSize={24}
                            />
                            <Bar
                                dataKey="output"
                                name="Output"
                                stackId="tokens"
                                fill={CHART_COLORS.output}
                                maxBarSize={24}
                            />
                            <Bar
                                dataKey="outputReasoning"
                                name="Reasoning"
                                stackId="tokens"
                                fill={CHART_COLORS.reasoning}
                                maxBarSize={24}
                                radius={[2, 2, 0, 0]}
                            />
                        </BarChart>
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
