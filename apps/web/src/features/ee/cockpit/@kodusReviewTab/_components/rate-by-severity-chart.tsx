"use client";

import useResizeObserver from "@hooks/use-resize-observer";
import {
    VictoryAxis,
    VictoryBar,
    VictoryChart,
    VictoryLabel,
    VictoryTheme,
} from "victory";

import { CockpitNoDataPlaceholder } from "../../_components/no-data-placeholder";
import type { ImplementationRateBySeverityRow } from "../../_services/analytics/review/fetch";
import {
    CHART_AXIS_STYLE,
    CHART_AXIS_STYLE_NO_GRID,
    SEVERITY_COLORS,
} from "./chart-constants";

export const RateBySeverityChart = ({
    data,
}: {
    data: ImplementationRateBySeverityRow[];
}) => {
    const [graphRef, boundingRect] = useResizeObserver();

    if (!data.length) return <CockpitNoDataPlaceholder />;

    return (
        <div ref={graphRef} className="h-64 w-full">
            {boundingRect.width > 0 && (
                <VictoryChart
                    theme={VictoryTheme.clean}
                    width={boundingRect.width}
                    height={256}
                    domainPadding={{ x: 50 }}
                    padding={{ left: 45, right: 15, top: 25, bottom: 35 }}>
                    <VictoryAxis style={CHART_AXIS_STYLE_NO_GRID} />
                    <VictoryAxis
                        dependentAxis
                        domain={[0, 100]}
                        tickFormat={(t: number) => `${t}%`}
                        style={CHART_AXIS_STYLE}
                    />
                    <VictoryBar
                        barWidth={40}
                        cornerRadius={{ top: 4 }}
                        labels={({ datum }) => `${Math.round(datum.y)}%`}
                        labelComponent={
                            <VictoryLabel
                                style={{
                                    fill: "#cdcddf",
                                    fontSize: 11,
                                    fontWeight: 600,
                                }}
                            />
                        }
                        data={data.map((row) => ({
                            x: row.severity,
                            y: row.rate * 100,
                            fill:
                                SEVERITY_COLORS[row.severity] ??
                                SEVERITY_COLORS.unknown,
                        }))}
                        style={{
                            data: {
                                fill: ({ datum }) => datum.fill,
                                fillOpacity: 0.85,
                            },
                        }}
                    />
                </VictoryChart>
            )}
        </div>
    );
};
