/**
 * Per-token rate with an optional tier breakpoint. When `tier` is set, calls
 * whose input exceeds `tier.threshold` tokens are billed at `tier.rate`; calls
 * at or below the threshold use `default`. The threshold is per-model (Gemini
 * Pro uses 200K today; others may differ). Prices are per-token (NOT per
 * million) to match the cost math, which multiplies raw counts by these rates.
 */
export interface TokenRate {
    default: number;
    tier?: { threshold: number; rate: number };
}

export interface ModelTokenRates {
    input: TokenRate;
    output: TokenRate;
    cacheRead: TokenRate;
    cacheWrite: TokenRate;
}

/**
 * Org-entered pricing for a model the catalog can't price (or that the org
 * wants to correct). Flat per-token US$, one rate per token type — no tiers.
 * The config UI collects "$ / 1M tokens" and divides by 1e6 before storing.
 */
export interface ManualModelPricing {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

/** Map of model name → org-entered pricing. Keys match the configured model id. */
export type ManualPricingOverrides = Record<string, ManualModelPricing>;

export type PricingSource = 'manual' | 'catalog' | 'none';

/**
 * Resolved pricing for one model. `source: 'none'` (priced=false) means we
 * could neither find a catalog price nor an override — the model is
 * unpriceable, which surfaces as a warning and blocks enabling a limit.
 */
export interface ResolvedModelPricing {
    model: string;
    source: PricingSource;
    priced: boolean;
    rates: ModelTokenRates;
    /**
     * The catalog's rates for this model, independent of any active manual
     * override — present only when the catalog can price it. Lets the config
     * UI offer "revert to catalog" and show the catalog values. Populated by
     * GetSpendLimitConfigUseCase, not the resolver.
     */
    catalogRates?: ModelTokenRates;
}
