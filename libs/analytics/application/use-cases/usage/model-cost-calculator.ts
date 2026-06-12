import { Injectable } from '@nestjs/common';

import { ModelSpend } from '@libs/analytics/domain/spend-limit/spend-limit.types';
import {
    ManualPricingOverrides,
    ModelTokenRates,
    TokenRate,
} from '@libs/analytics/domain/token-usage/types/pricing.types';
import {
    CostBreakdown,
    TierUsage,
} from '@libs/analytics/domain/token-usage/types/tokenUsage.types';

import { PricingResolver } from './pricing-resolver';

const UNKNOWN_MODEL = '(unknown)';

/**
 * A usage row carrying token counts and (optionally) the model that produced
 * them. When `byTier` is set, the row's totals are already split between calls
 * at or below the model's tier threshold (`le`) and calls above it (`gt`) — the
 * calculator prices each bucket at its own rate. Rows without `byTier` are
 * treated as flat (everything billed at `default`), which is correct for
 * non-tiered models.
 */
export interface CostUsageRow {
    input: number;
    output: number;
    outputReasoning: number;
    /** Input tokens served from cache. Subset of `input`. */
    cacheRead?: number;
    /** Input tokens that created cache entries on this call (Anthropic). */
    cacheWrite?: number;
    model?: string;
    byTier?: {
        le: TierUsage;
        gt: TierUsage;
    };
}

interface ModelUsageAgg {
    le: TierUsage;
    gt: TierUsage;
}

/**
 * Single source of truth for turning token usage into US$. Buckets usage by
 * model and prices each independently (rates vary by ~10x across providers).
 * Pricing comes from the PricingResolver, so manual overrides and catalog
 * rates are applied consistently here, in cost-estimate, and on the config
 * surface — they can never disagree on what a workload costs.
 *
 * Tier handling: a row's `byTier.gt` bucket is priced at the model's `tier`
 * rate when present (Gemini Pro's >200K tariff today); `byTier.le` and any
 * flat row are priced at `default`. Selection is per-call, not per aggregate,
 * because the LLM provider applies the tier per request.
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
                le: emptyTier(),
                gt: emptyTier(),
            };
            if (row.byTier) {
                addTier(agg.le, row.byTier.le);
                addTier(agg.gt, row.byTier.gt);
            } else {
                // Flat row (model without tier). All of it goes to `le`, which
                // gets the `default` rate — equivalent to the old behavior.
                addTier(agg.le, {
                    input: row.input,
                    output: row.output,
                    total: row.input + row.output,
                    outputReasoning: row.outputReasoning,
                    cacheRead: row.cacheRead ?? 0,
                    cacheWrite: row.cacheWrite ?? 0,
                });
            }
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

        const leCost = ModelCostCalculator.bucketCost(agg.le, rates, 'default');
        const gtCost = ModelCostCalculator.bucketCost(agg.gt, rates, 'tier');
        return leCost.total + gtCost.total;
    }

    /**
     * Cost of a single tier bucket, broken down per token type. Static so
     * downstream layers that need the per-component costs (e.g. the API
     * summary use-case) can share the exact formula with no risk of drift.
     */
    static bucketCost(
        bucket: TierUsage,
        rates: ModelTokenRates,
        tier: 'default' | 'tier',
    ): CostBreakdown {
        const pick = (rate: TokenRate) =>
            tier === 'tier' && rate.tier ? rate.tier.rate : rate.default;

        const inputRate = pick(rates.input);
        const outputRate = pick(rates.output);
        const cacheReadRate = pick(rates.cacheRead);
        const cacheWriteRate = pick(rates.cacheWrite);

        // Cache reads are a subset of input tokens — subtract them from the
        // billable-at-full-price pool so we don't charge input AND cache for
        // the same tokens.
        const uncachedInput = Math.max(0, bucket.input - bucket.cacheRead);

        const input = uncachedInput * inputRate;
        const output = bucket.output * outputRate;
        const cacheRead = bucket.cacheRead * cacheReadRate;
        const cacheWrite = bucket.cacheWrite * cacheWriteRate;

        return {
            input,
            output,
            cacheRead,
            cacheWrite,
            total: input + output + cacheRead + cacheWrite,
        };
    }
}

function emptyTier(): TierUsage {
    return {
        input: 0,
        output: 0,
        total: 0,
        outputReasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
    };
}

function addTier(target: TierUsage, src: TierUsage): void {
    target.input += src.input;
    target.output += src.output;
    target.total += src.total;
    target.outputReasoning += src.outputReasoning;
    target.cacheRead += src.cacheRead;
    target.cacheWrite += src.cacheWrite;
}
