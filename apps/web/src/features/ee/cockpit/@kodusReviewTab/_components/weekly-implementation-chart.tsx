"use client";

import { useState } from "react";
import useResizeObserver from "@hooks/use-resize-observer";
import {
    VictoryArea,
    VictoryAxis,
    VictoryChart,
    VictoryLegend,
    VictoryLine,
    VictoryTheme,
    VictoryTooltip,
    VictoryVoronoiContainer,
} from "victory";

import { CockpitNoDataPlaceholder } from "../../_components/no-data-placeholder";
import type { ImplementationRateWeeklyRow } from "../../_services/analytics/review/fetch";
import {
    CHART_AXIS_STYLE,
    CHART_AXIS_STYLE_NO_GRID,
    SEVERITY_COLORS,
    SEVERITY_ORDER,
} from "./chart-constants";
import { TogglePills } from "./toggle-pills";

type Mode = "overall" | "severity";

export const WeeklyImplementationChart = ({
    data,
}: {
    data: ImplementationRateWeeklyRow[];
}) => {
    const [mode, setMode] = useState<Mode>("overall");
    const [graphRef, boundingRect] = useResizeObserver();

    if (!data.length) return <CockpitNoDataPlaceholder />;

    const severities = SEVERITY_ORDER.filter((severity) =>
        data.some((w) => w.bySeverity[severity]),
    );

    return (
        <div className="flex flex-col gap-2">
            <div className="flex justify-end">
                <TogglePills<Mode>
                    value={mode}
                    onChange={setMode}
                    options={[
                        { value: "overall", label: "Overall" },
                        { value: "severity", label: "By severity" },
                    ]}
                />
            </div>

            <div ref={graphRef} className="h-72 w-full">
                {boundingRect.width > 0 && (
                    <VictoryChart
                        theme={VictoryTheme.clean}
                        width={boundingRect.width}
                        height={288}
                        padding={{ left: 45, right: 15, top: 10, bottom: 40 }}
                        containerComponent={
                            <VictoryVoronoiContainer
                                labels={({ datum }) =>
                                    `${datum.childName ?? ""} ${Math.round(datum.y)}%`.trim()
                                }
                                labelComponent={
                                    <VictoryTooltip
                                        flyoutStyle={{
                                            fill: "#181825",
                                            stroke: "#30304b",
                                        }}
                                        style={{
                                            fill: "#cdcddf",
                                            fontSize: 11,
                                        }}
                                    />
                                }
                            />
                        }>
                        <VictoryAxis style={CHART_AXIS_STYLE_NO_GRID} />
                        <VictoryAxis
                            dependentAxis
                            domain={[0, 100]}
                            tickFormat={(t: number) => `${t}%`}
                            style={CHART_AXIS_STYLE}
                        />

                        {mode === "overall" ? (
                            <VictoryArea
                                name="impl. rate"
                                interpolation="monotoneX"
                                data={data.map((w) => ({
                                    x: w.weekStart,
                                    y: w.rate * 100,
                                }))}
                                style={{
                                    data: {
                                        stroke: "#f8b76d",
                                        strokeWidth: 2.5,
                                        fill: "#f8b76d",
                                        fillOpacity: 0.15,
                                    },
                                }}
                            />
                        ) : (
                            severities.map((severity) => (
                                <VictoryLine
                                    key={severity}
                                    name={severity}
                                    interpolation="monotoneX"
                                    data={data.map((w) => ({
                                        x: w.weekStart,
                                        y:
                                            (w.bySeverity[severity]?.rate ??
                                                0) * 100,
                                    }))}
                                    style={{
                                        data: {
                                            stroke: SEVERITY_COLORS[severity],
                                            strokeWidth: 2,
                                        },
                                    }}
                                />
                            ))
                        )}

                        {mode === "severity" && (
                            <VictoryLegend
                                orientation="horizontal"
                                gutter={16}
                                x={45}
                                y={0}
                                style={{
                                    labels: { fill: "#cdcddf", fontSize: 11 },
                                }}
                                data={severities.map((severity) => ({
                                    name: severity,
                                    symbol: {
                                        fill: SEVERITY_COLORS[severity],
                                        type: "square",
                                    },
                                }))}
                            />
                        )}
                    </VictoryChart>
                )}
            </div>
        </div>
    );
};
