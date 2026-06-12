export type TokenUsageQueryContract = {
    organizationId: string;
    start: Date;
    end: Date;
    models?: string;
    prNumber?: number;
    timezone?: string; // for day bucketing
    developer?: string;
    byok: boolean;
};

/** Token counts for a single tier bucket of calls. */
export interface TierUsage {
    input: number;
    output: number;
    total: number;
    outputReasoning: number;
    cacheRead: number;
    cacheWrite: number;
}

export interface BaseUsageContract {
    model: string;
    /** Flat totals across both tiers — sum of byTier.le + byTier.gt. */
    input: number;
    output: number;
    total: number;
    outputReasoning: number;
    /** Input tokens served from provider prompt cache. Subset of `input`. */
    cacheRead?: number;
    /** Input tokens that created cache entries on this call (Anthropic). */
    cacheWrite?: number;
    /**
     * Per-tier breakdown. `le` = calls at or below the model's threshold;
     * `gt` = calls above it. Present only when the model has a tier breakpoint
     * in its pricing; flat-priced models omit this (all usage is on `default`).
     */
    byTier?: {
        le: TierUsage;
        gt: TierUsage;
    };
}

export type UsageSummaryContract = BaseUsageContract;

export interface DailyUsageResultContract extends BaseUsageContract {
    date: string; // YYYY-MM-DD
}

export interface UsageByPrResultContract extends BaseUsageContract {
    prNumber: number;
}

export interface DailyUsageByPrResultContract extends UsageByPrResultContract {
    date: string; // YYYY-MM-DD
}

export interface UsageByDeveloperResultContract extends BaseUsageContract {
    developer: string;
}

export interface DailyUsageByDeveloperResultContract
    extends UsageByDeveloperResultContract {
    date: string; // YYYY-MM-DD
}

/**
 * USD-denominated cost broken down by token type. `total = input + output +
 * cacheRead + cacheWrite`. Provided alongside token counts so the UI never has
 * to know rates or formulas — it just renders.
 */
export interface CostBreakdown {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
}

/**
 * `'missing'` is the API-facing label for `PricingSource = 'none'` returned by
 * the resolver. Keeping a single enum at the wire boundary makes the
 * frontend's missing-price warning trivial.
 */
export type ApiPricingSource = 'manual' | 'catalog' | 'missing';

/**
 * A per-model usage row enriched with the cost we computed for it, the cost
 * broken down per tier (when the model is tier-aware), and where the price
 * came from. This is the shape the detail table on the Token Usage page
 * consumes for each model row.
 */
export interface EnrichedModelUsage extends BaseUsageContract {
    cost: CostBreakdown;
    costByTier?: {
        le: CostBreakdown;
        gt: CostBreakdown;
    };
    pricingSource: ApiPricingSource;
}

/**
 * Rich payload for the `/usage/tokens/summary` endpoint: flat totals across
 * everything (powers the top cards), the total cost split by token type
 * (powers the cost cards), and a per-model breakdown (powers the detail
 * table). One round-trip serves both surfaces.
 */
export interface UsageSummaryReportContract {
    totals: BaseUsageContract;
    totalCost: CostBreakdown;
    byModel: EnrichedModelUsage[];
}

export interface TokenUsageBreakdown {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}

export interface CostEstimateContract {
    estimatedMonthlyCost: number;
    costPerDeveloper: number;
    developerCount: number;
    tokenUsage: TokenUsageBreakdown;
    periodDays: number;
    projectionDays: number;
}
