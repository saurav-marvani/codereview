"use client";

import { useEffect, useMemo, useState } from "react";
import { Card } from "@components/ui/card";
import {
    BaseUsageContract,
    ModelPricingInfo,
    UsageSummaryContract,
} from "@services/usage/types";
import { DateRangePicker } from "src/features/ee/cockpit/_components/date-range-picker";

import { useTokenUsageFilters } from "../_hooks/filter.hook";
import { Chart } from "./chart";
import { CostCards } from "./cost-cards";
import { Filters } from "./filters";
import { ModelBreakdownTable } from "./model-breakdown-table";
import { NoData } from "./no-data";
import { SpendLimitProgress } from "./spend-limit-progress";
import { SummaryCards } from "./summary-cards";

const ZERO_TOTALS = {
    input: 0,
    output: 0,
    total: 0,
    outputReasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
};

export const TokenUsagePageClient = ({
    data,
    summary,
    activeDayCount,
    uniquePrCount,
    cookieValue,
    models,
    pricing,
}: {
    data: BaseUsageContract[];
    summary: UsageSummaryContract | null;
    activeDayCount: number;
    uniquePrCount: number;
    cookieValue: string | undefined;
    models: string[];
    pricing: Record<string, ModelPricingInfo>;
}) => {
    const [isMounted, setIsMounted] = useState(false);

    const filters = useTokenUsageFilters(models);
    const { selectedModels, currentFilter } = filters;

    useEffect(() => {
        setIsMounted(true);
    }, []);

    const filteredData = useMemo(() => {
        if (!data) return [];
        return data.filter((d) => selectedModels.includes(d.model));
    }, [data, selectedModels]);

    /**
     * The summary endpoint already returns totals + per-token-type costs for
     * the WHOLE period, server-side, with correct per-call tier pricing. When
     * the user narrows the model filter we re-aggregate from `summary.byModel`
     * (which carries the same correct breakdown per model) so the cards stay
     * consistent with the detail table.
     */
    const totalUsage = useMemo(() => {
        if (!summary) return ZERO_TOTALS;

        const allModelsSelected = selectedModels.length === models.length;

        if (allModelsSelected) {
            return {
                input: summary.totals.input,
                output: summary.totals.output,
                total: summary.totals.total,
                outputReasoning: summary.totals.outputReasoning,
                cacheRead: summary.totals.cacheRead ?? 0,
                cacheWrite: summary.totals.cacheWrite ?? 0,
                totalCost: summary.totalCost.total,
                inputCost: summary.totalCost.input,
                outputCost: summary.totalCost.output,
                cacheReadCost: summary.totalCost.cacheRead,
                cacheWriteCost: summary.totalCost.cacheWrite,
            };
        }

        // Sum only the selected models' rows.
        return summary.byModel
            .filter((m) => selectedModels.includes(m.model))
            .reduce(
                (acc, row) => ({
                    input: acc.input + row.input,
                    output: acc.output + row.output,
                    total: acc.total + row.total,
                    outputReasoning:
                        acc.outputReasoning + row.outputReasoning,
                    cacheRead: acc.cacheRead + (row.cacheRead ?? 0),
                    cacheWrite: acc.cacheWrite + (row.cacheWrite ?? 0),
                    totalCost: acc.totalCost + row.cost.total,
                    inputCost: acc.inputCost + row.cost.input,
                    outputCost: acc.outputCost + row.cost.output,
                    cacheReadCost: acc.cacheReadCost + row.cost.cacheRead,
                    cacheWriteCost: acc.cacheWriteCost + row.cost.cacheWrite,
                }),
                ZERO_TOTALS,
            );
    }, [summary, selectedModels, models]);

    const breakdownRows = useMemo(() => {
        if (!summary) return [];
        return summary.byModel.filter((m) => selectedModels.includes(m.model));
    }, [summary, selectedModels]);

    const avgPerDay =
        activeDayCount > 0 ? totalUsage.totalCost / activeDayCount : 0;
    const avgPerPR =
        uniquePrCount > 0 ? totalUsage.totalCost / uniquePrCount : 0;

    const filteredPricing = useMemo(() => {
        const result: Record<string, ModelPricingInfo> = {};
        for (const model of selectedModels) {
            if (pricing[model]) {
                result[model] = pricing[model];
            }
        }
        return result;
    }, [pricing, selectedModels]);

    if (!isMounted) {
        return null;
    }

    return (
        <div className="flex flex-col gap-5">
            {/* Filters Row */}
            <div className="flex items-center justify-between gap-4">
                <Filters models={models} filters={filters} />
                <DateRangePicker cookieValue={cookieValue} />
            </div>

            {/* Token Summary */}
            <SummaryCards totalUsage={totalUsage} />

            {/* Cost & Pricing Row */}
            <CostCards
                totalCost={totalUsage.totalCost}
                avgPerDay={avgPerDay}
                avgPerPR={avgPerPR}
            />

            {/* Month-to-date spend vs the configured BYOK limit */}
            <SpendLimitProgress />

            {/* Chart */}
            <Card className="h-[420px] p-5">
                {filteredData && filteredData.length > 0 ? (
                    <Chart data={filteredData} filterType={currentFilter} />
                ) : (
                    <NoData />
                )}
            </Card>

            {/* Per-model breakdown (collapsed by default) */}
            <ModelBreakdownTable rows={breakdownRows} pricing={filteredPricing} />
        </div>
    );
};
