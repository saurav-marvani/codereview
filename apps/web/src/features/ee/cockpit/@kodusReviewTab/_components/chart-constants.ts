export const SEVERITY_COLORS: Record<string, string> = {
    critical: "#fa5867",
    high: "#ff8b40",
    medium: "#f2c631",
    low: "#5190ff",
    unknown: "#cdcddf",
};

export const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

export const CHART_AXIS_STYLE = {
    axis: { stroke: "transparent" },
    grid: { stroke: "#30304b66", strokeDasharray: "3 3" },
    tickLabels: {
        fill: "#cdcddf",
        fontSize: 11,
        fontFamily: "inherit",
    },
} as const;

export const CHART_AXIS_STYLE_NO_GRID = {
    ...CHART_AXIS_STYLE,
    grid: { stroke: "transparent" },
} as const;
