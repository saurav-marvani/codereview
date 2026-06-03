import { Injectable } from '@nestjs/common';

import { ModelSpend } from '@libs/analytics/domain/spend-limit/spend-limit.types';
import {
    ManualPricingOverrides,
    TokenRate,
} from '@libs/analytics/domain/token-usage/types/pricing.types';

import { PricingResolver } from './pricing-resolver';

const UNKNOWN_MODEL = '(unknown)';

/** A usage row carrying token counts and (optionally) the model that produced them. */
export interface CostUsageRow {
    input: number;
    output: number;
    outputReasoning: number;
    /** Input tokens served from cache. Subset of `input`. */
    cacheRead?: number;
    /** Input tokens that created cache entries on this call (Anthropic). */
    cacheWrite?: number;
    model?: string;
}

interface ModelUsageAgg {
    input: number;
    output: number;
    outputReasoning: number;
    cacheRead: number;
    cacheWrite: number;
}

/**
 * Single source of truth for turning token usage into US$. Buckets usage by
 * model and prices each independently (rates vary by ~10x across providers).
 * Pricing comes from the PricingResolver, so manual overrides and catalog
 * rates are applied consistently here, in cost-estimate, and on the config
 * surface — they can never disagree on what a workload costs.
 */
@Injectable()
export class ModelCostCalculator {
    constructor(private readonly pricingResolver: PricingResolver) {}

    /** Per-model billed cost for the given usage rows. */
    async spendByModel(
        rows: CostUsageRow[],
        overrides?: ManualPricingOverrides,
    ): Promise<ModelSpend[]> {
        const perModel = this.bucketByModel(rows);

        const out: ModelSpend[] = [];
        for (const [model, agg] of perModel) {
            out.push({
                model,
                spentUsd: await this.costForModel(model, agg, overrides),
            });
        }
        return out;
    }

    /** Total billed cost across every model in the given usage rows. */
    async totalCost(
        rows: CostUsageRow[],
        overrides?: ManualPricingOverrides,
    ): Promise<number> {
        const byModel = await this.spendByModel(rows, overrides);
        return byModel.reduce((sum, m) => sum + m.spentUsd, 0);
    }

    private bucketByModel(rows: CostUsageRow[]): Map<string, ModelUsageAgg> {
        const perModel = new Map<string, ModelUsageAgg>();
        for (const row of rows) {
            const key = (row.model && row.model.trim()) || UNKNOWN_MODEL;
            const agg = perModel.get(key) ?? {
                input: 0,
                output: 0,
                outputReasoning: 0,
                cacheRead: 0,
                cacheWrite: 0,
            };
            agg.input += row.input;
            agg.output += row.output;
            agg.outputReasoning += row.outputReasoning;
            agg.cacheRead += row.cacheRead ?? 0;
            agg.cacheWrite += row.cacheWrite ?? 0;
            perModel.set(key, agg);
        }
        return perModel;
    }

    private async costForModel(
        model: string,
        agg: ModelUsageAgg,
        overrides?: ManualPricingOverrides,
    ): Promise<number> {
        if (model === UNKNOWN_MODEL) return 0;

        const { rates } = await this.pricingResolver.resolve(model, overrides);

        // Tier selection: when a separate rate above 200K prompt tokens exists
        // (only Gemini Pro in the catalog today; manual pricing is always
        // flat), use it once the aggregate input for this model clears the bar.
        const shouldUseAbove200k = agg.input > 200_000;

        const pick = (rate: TokenRate) =>
            shouldUseAbove200k && typeof rate.above200k === 'number'
                ? rate.above200k
                : rate.default;

        const inputRate = pick(rates.input);
        const outputRate = pick(rates.output);
        const cacheReadRate = pick(rates.cacheRead);
        const cacheWriteRate = pick(rates.cacheWrite);

        // Cache reads are a subset of input tokens — subtract them from the
        // billable-at-full-price pool so we don't charge input AND cache for
        // the same tokens.
        const uncachedInput = Math.max(0, agg.input - agg.cacheRead);

        return (
            uncachedInput * inputRate +
            agg.cacheRead * cacheReadRate +
            agg.cacheWrite * cacheWriteRate +
            agg.output * outputRate
        );
    }
}
