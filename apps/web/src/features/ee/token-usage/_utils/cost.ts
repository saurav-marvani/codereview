import type {
    BaseUsageContract,
    ModelPricingInfo,
    TokenPrice,
    TierUsage,
} from "@services/usage/types";

export interface RowCost {
    input: number;
    output: number;
    reasoning: number;
    total: number;
}

const rate = (price: TokenPrice | undefined, tier: "default" | "gt") =>
    tier === "gt" && price?.tier ? price.tier.rate : (price?.default ?? 0);

/**
 * USD cost of one usage row, per chart series, mirroring the backend's
 * bucketCost formula (model-cost-calculator.ts): cache reads are billed at
 * the cache rate and subtracted from the full-price input pool; reasoning
 * bills at the output rate; tier-aware rows price each byTier bucket at its
 * own rate. Rows without pricing info cost 0 (the per-model table already
 * flags unpriced models).
 */
export function rowCost(
    row: BaseUsageContract,
    info: ModelPricingInfo | undefined,
): RowCost {
    const pricing = info?.pricing;
    if (!pricing) return { input: 0, output: 0, reasoning: 0, total: 0 };

    const bucketCost = (bucket: TierUsage, tier: "default" | "gt") => {
        const uncached = Math.max(0, bucket.input - bucket.cacheRead);
        const input =
            uncached * rate(pricing.input, tier) +
            bucket.cacheRead * rate(pricing.cacheRead, tier) +
            bucket.cacheWrite * rate(pricing.cacheWrite, tier);
        const output =
            Math.max(0, bucket.output - bucket.outputReasoning) *
            rate(pricing.output, tier);
        const reasoning = bucket.outputReasoning * rate(pricing.output, tier);
        return { input, output, reasoning };
    };

    const buckets = row.byTier
        ? [
              bucketCost(row.byTier.le, "default"),
              bucketCost(row.byTier.gt, "gt"),
          ]
        : [
              bucketCost(
                  {
                      input: row.input,
                      output: row.output,
                      total: row.total,
                      outputReasoning: row.outputReasoning,
                      cacheRead: row.cacheRead ?? 0,
                      cacheWrite: row.cacheWrite ?? 0,
                  },
                  "default",
              ),
          ];

    const summed = buckets.reduce(
        (acc, b) => ({
            input: acc.input + b.input,
            output: acc.output + b.output,
            reasoning: acc.reasoning + b.reasoning,
        }),
        { input: 0, output: 0, reasoning: 0 },
    );
    return { ...summed, total: summed.input + summed.output + summed.reasoning };
}

/**
 * What prompt caching saved vs paying the full input rate for those tokens.
 * Σ over models of cacheRead × (input rate − cache-read rate). Flat-rate
 * approximation (ignores the >200k tier); close enough for the callout.
 */
export function cacheSavings(
    byModel: Array<BaseUsageContract & { model: string }>,
    pricing: Record<string, ModelPricingInfo>,
): number {
    let saved = 0;
    for (const row of byModel) {
        const p = pricing[row.model]?.pricing;
        if (!p) continue;
        const diff = (p.input?.default ?? 0) - (p.cacheRead?.default ?? 0);
        if (diff > 0) saved += (row.cacheRead ?? 0) * diff;
    }
    return saved;
}
