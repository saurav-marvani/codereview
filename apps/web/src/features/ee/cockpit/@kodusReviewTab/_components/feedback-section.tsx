"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import useResizeObserver from "@hooks/use-resize-observer";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@components/ui/card";
import {
    VictoryArea,
    VictoryAxis,
    VictoryChart,
    VictoryTheme,
} from "victory";

import { CockpitNoDataPlaceholder } from "../../_components/no-data-placeholder";
import type {
    NegativeFeedbackByCategoryRow,
    NegativeFeedbackWeeklyRow,
} from "../../_services/analytics/review/fetch";
import {
    CHART_AXIS_STYLE,
    CHART_AXIS_STYLE_NO_GRID,
} from "./chart-constants";
import { TogglePills } from "./toggle-pills";

type Mode = "category" | "trend";

const CategoryBars = ({
    data,
}: {
    data: NegativeFeedbackByCategoryRow[];
}) => {
    const router = useRouter();
    const withDownvotes = data.filter((r) => r.thumbsDown > 0);

    if (!withDownvotes.length) {
        return (
            <div className="text-text-tertiary flex h-48 items-center justify-center text-sm">
                No negative feedback in this period 🎉
            </div>
        );
    }

    const max = Math.max(...withDownvotes.map((r) => r.thumbsDown));

    return (
        <div className="flex flex-col gap-1.5">
            {withDownvotes.map((row) => (
                <button
                    key={row.category}
                    type="button"
                    onClick={() =>
                        router.push(
                            `/review-suggestions?category=${encodeURIComponent(row.category)}`,
                        )
                    }
                    className="hover:bg-card-lv2 flex items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors">
                    <span className="text-text-secondary w-36 shrink-0 truncate text-xs">
                        {row.category}
                    </span>
                    <span className="bg-card-lv3/40 relative h-3 flex-1 overflow-hidden rounded-sm">
                        <span
                            className="bg-danger/80 absolute inset-y-0 left-0 rounded-sm"
                            style={{
                                width: `${(row.thumbsDown / max) * 100}%`,
                            }}
                        />
                    </span>
                    <span className="text-text-tertiary w-20 shrink-0 text-right font-mono text-xs">
                        ▼ {row.thumbsDown} · ▲ {row.thumbsUp}
                    </span>
                </button>
            ))}
        </div>
    );
};

const TrendChart = ({ data }: { data: NegativeFeedbackWeeklyRow[] }) => {
    const [graphRef, boundingRect] = useResizeObserver();

    if (!data.length) return <CockpitNoDataPlaceholder />;

    return (
        <div ref={graphRef} className="h-56 w-full">
            {boundingRect.width > 0 && (
                <VictoryChart
                    theme={VictoryTheme.clean}
                    width={boundingRect.width}
                    height={224}
                    padding={{ left: 40, right: 15, top: 10, bottom: 35 }}>
                    <VictoryAxis style={CHART_AXIS_STYLE_NO_GRID} />
                    <VictoryAxis
                        dependentAxis
                        tickFormat={(t: number) =>
                            Number.isInteger(t) ? t : ""
                        }
                        style={CHART_AXIS_STYLE}
                    />
                    <VictoryArea
                        interpolation="monotoneX"
                        data={data.map((w) => ({
                            x: w.weekStart,
                            y: w.thumbsDown,
                        }))}
                        style={{
                            data: {
                                stroke: "#fa5867",
                                strokeWidth: 2.5,
                                fill: "#fa5867",
                                fillOpacity: 0.12,
                            },
                        }}
                    />
                </VictoryChart>
            )}
        </div>
    );
};

export const FeedbackSection = ({
    byCategory,
    weekly,
}: {
    byCategory: NegativeFeedbackByCategoryRow[];
    weekly: NegativeFeedbackWeeklyRow[];
}) => {
    const [mode, setMode] = useState<Mode>("category");

    return (
        <Card color="lv1">
            <CardHeader className="flex-row items-start justify-between">
                <div className="flex flex-col gap-1.5">
                    <CardTitle className="text-sm">
                        Negative feedback (👎)
                    </CardTitle>
                    <CardDescription className="text-xs">
                        where the team disagrees with Kodus · click to drill
                        down
                    </CardDescription>
                </div>
                <TogglePills<Mode>
                    value={mode}
                    onChange={setMode}
                    options={[
                        { value: "category", label: "By category" },
                        { value: "trend", label: "Trend" },
                    ]}
                />
            </CardHeader>
            <CardContent>
                {mode === "category" ? (
                    <CategoryBars data={byCategory} />
                ) : (
                    <TrendChart data={weekly} />
                )}
            </CardContent>
        </Card>
    );
};
