export type TabValue = keyof typeof tabs;

// "Kodus Review" replaced the old "Code health" tab — its two charts
// (suggestions by category/repository) were absorbed as implementation-rate
// versions inside the review tab.
export const tabs = {
    "flow-metrics": "Flow metrics",
    "kodus-review": "Kodus Review",
    "productivity": "Productivity",
} satisfies Record<string, string>;
