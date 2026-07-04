import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';
import axios from 'axios';

import { CacheService } from '@libs/core/cache/cache.service';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const MODELS_DEV_CACHE_KEY = 'token-pricing:modelsdev';
const LITELLM_PRICING_URL =
    'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const LITELLM_CACHE_KEY = 'token-pricing:litellm-normalized';
// cache-manager v7 expects TTL in milliseconds.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/** models.dev prices are US$ per 1M tokens; we store per-token. */
const PER_MILLION = 1_000_000;

/**
 * The token threshold encoded in the LiteLLM catalog's `*_above_200k_tokens`
 * field names and models.dev's `context_over_200k` object. models.dev's
 * `tiers[].tier.size` carries an explicit per-model breakpoint, which takes
 * precedence when present.
 */
const TIER_THRESHOLD_200K = 200_000;

/**
 * models.dev providers that re-sell other vendors' models. When the same bare
 * model id exists under a native provider and an aggregator, the native entry
 * wins the bare-id alias (aggregator pricing can differ from list price).
 */
const AGGREGATOR_PROVIDERS = new Set([
    'openrouter',
    'github-models',
    'github-copilot',
    'azure',
    'huggingface',
    'fastrouter',
    'requesty',
    'vercel',
]);

type ModelsDevCostTier = {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    tier?: { type?: string; size?: number };
};

type ModelsDevCost = {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    reasoning?: number;
    tiers?: ModelsDevCostTier[];
    context_over_200k?: {
        input?: number;
        output?: number;
        cache_read?: number;
        cache_write?: number;
    };
};

type ModelsDevModel = {
    id?: string;
    cost?: ModelsDevCost;
};

type ModelsDevProvider = {
    id?: string;
    models?: Record<string, ModelsDevModel>;
};

type LiteLLMModel = {
    input_cost_per_token?: number;
    input_cost_per_token_above_200k_tokens?: number;
    output_cost_per_token?: number;
    output_cost_per_token_above_200k_tokens?: number;
    cache_read_input_token_cost?: number;
    cache_read_input_token_cost_above_200k_tokens?: number;
    cache_creation_input_token_cost?: number;
    cache_creation_input_token_cost_above_200k_tokens?: number;
    litellm_provider?: string;
    mode?: string;
};

/**
 * Per-token rate with an optional tier breakpoint. When `tier` is set, calls
 * whose input exceeds `tier.threshold` tokens are billed at `tier.rate`; calls
 * at or below the threshold use `default`. The threshold is per-model.
 */
export type TokenPrice = {
    default: number;
    tier?: { threshold: number; rate: number };
};

/**
 * Normalized pricing for a single model. Prices are per-token, NOT per
 * million. Callers that render "$X per 1M" must multiply by 1e6.
 *
 * `prompt`/`completion`/`internal_reasoning` are kept as flat scalars for
 * backward compatibility with existing UI consumers; they mirror the
 * `default` tier of input/output. Cost calculations should prefer the rich
 * input/output/cacheRead/cacheWrite shape.
 */
export type ModelPricingInfo = {
    id: string;
    provider?: string;
    pricing: {
        input: TokenPrice;
        output: TokenPrice;
        cacheRead: TokenPrice;
        cacheWrite: TokenPrice;
        prompt: number;
        completion: number;
        internal_reasoning: number;
    };
};

/**
 * Source-agnostic catalog entry, already converted to per-token rates. Both
 * the models.dev and LiteLLM payloads normalize into this at fetch time (the
 * normalized form is what gets cached), so lookup and pricing logic never
 * touch source-specific field names or units again.
 */
export type CatalogEntry = {
    provider?: string;
    input: TokenPrice;
    output: TokenPrice;
    cacheRead: TokenPrice;
    cacheWrite: TokenPrice;
    /** Per-token reasoning rate when the source prices it separately. */
    reasoning?: number;
};

export type PricingCatalog = Record<string, CatalogEntry>;

@Injectable()
export class TokenPricingUseCase {
    private readonly logger = createLogger(TokenPricingUseCase.name);

    constructor(private readonly cacheService: CacheService) {}

    async execute(model: string, provider?: string): Promise<ModelPricingInfo> {
        try {
            return await this.getModelInfo(model, provider);
        } catch (error) {
            this.logger.error({
                message: 'Error fetching token pricing',
                error,
                context: TokenPricingUseCase.name,
                metadata: { model, provider },
            });
            return this.emptyPricing(model, provider);
        }
    }

    /**
     * Batch variant: resolve many models in one call. The catalogs are cached,
     * so this fetches each source at most once regardless of model count —
     * collapsing the screen's per-model N+1 into a single request.
     */
    async executeMany(
        models: string[],
        provider?: string,
    ): Promise<Record<string, ModelPricingInfo>> {
        const unique = Array.from(
            new Set(models.map((m) => m?.trim()).filter(Boolean)),
        );
        const entries = await Promise.all(
            unique.map(
                async (model) =>
                    [model, await this.execute(model, provider)] as const,
            ),
        );
        return Object.fromEntries(entries);
    }

    /**
     * Canonical model names the catalog bills at a higher INPUT tier above a
     * breakpoint, mapped to that input threshold. The Token Usage read derives
     * each call's tier from `attributes.tu.input` vs this map — so it needs to
     * know *which models are tiered* without a per-request DB scan to discover
     * the models present in the window. The catalogs are cached (24h), making
     * this near-free.
     *
     * Keys are canonicalized the same way the write path stores
     * `attributes.tu.model` (strip provider prefix, keep the last id segment),
     * so `vertex_ai/gemini-2.5-pro` and a bare `gemini-2.5-pro` both collapse to
     * the stored name and match in the aggregation's `$switch`.
     */
    async tieredInputThresholds(): Promise<Map<string, number>> {
        const out = new Map<string, number>();
        // Fallback first, primary second — primary wins on key collisions.
        for (const catalog of [
            await this.getLiteLLMCatalog(),
            await this.getModelsDevCatalog(),
        ]) {
            for (const [key, entry] of Object.entries(catalog)) {
                if (!entry.input.tier) continue;
                for (const name of this.canonicalNames(key)) {
                    out.set(name, entry.input.tier.threshold);
                }
            }
        }
        return out;
    }

    /**
     * Every form a catalog key can appear as in `attributes.tu.model`, so the
     * read-time tier `$switch` matches however the id was stored.
     *
     * The write path (deriveTu) stores `gen_ai.response.model.split(':').pop()`
     * — it strips a `provider:` prefix but KEEPS a `provider/` one. So a stored
     * id may be the colon-stripped key (`vertex_ai/gemini-2.5-pro`) OR the fully
     * bare last segment (`gemini-2.5-pro`). Emitting only the bare form (as a
     * previous version did) missed slash-prefixed ids and under-reported their
     * tiered cost — so emit BOTH.
     */
    private canonicalNames(key: string): string[] {
        const colonStripped = key.split(':').pop()!;
        const bare = colonStripped.split('/').pop()!;
        return colonStripped === bare ? [colonStripped] : [colonStripped, bare];
    }

    /**
     * Primary catalog (models.dev), flattened from its provider-nested shape
     * into `provider/model` keys plus bare-id aliases, normalized to per-token
     * rates. Cached post-normalization.
     */
    async getModelsDevCatalog(): Promise<PricingCatalog> {
        const cached =
            await this.cacheService.getFromCache<PricingCatalog>(
                MODELS_DEV_CACHE_KEY,
            );
        if (cached) return cached;

        const raw = await this.fetchJson<Record<string, ModelsDevProvider>>(
            MODELS_DEV_URL,
        );
        const catalog = this.flattenModelsDev(raw);
        await this.cacheService.addToCache(
            MODELS_DEV_CACHE_KEY,
            catalog,
            CACHE_TTL_MS,
        );
        return catalog;
    }

    /** Secondary catalog (LiteLLM), kept as a fallback during the cutover. */
    async getLiteLLMCatalog(): Promise<PricingCatalog> {
        const cached =
            await this.cacheService.getFromCache<PricingCatalog>(
                LITELLM_CACHE_KEY,
            );
        if (cached) return cached;

        const raw =
            await this.fetchJson<Record<string, LiteLLMModel>>(
                LITELLM_PRICING_URL,
            );
        const catalog: PricingCatalog = {};
        for (const [key, entry] of Object.entries(raw)) {
            if (!entry || typeof entry !== 'object') continue;
            catalog[key] = this.fromLiteLLM(entry);
        }
        await this.cacheService.addToCache(
            LITELLM_CACHE_KEY,
            catalog,
            CACHE_TTL_MS,
        );
        return catalog;
    }

    private async fetchJson<T>(url: string): Promise<T> {
        const response = await axios.get<unknown>(url, {
            timeout: FETCH_TIMEOUT_MS,
            responseType: 'json',
        });
        const parsed =
            typeof response.data === 'string'
                ? (JSON.parse(response.data) as T)
                : (response.data as T);
        if (!parsed || typeof parsed !== 'object') {
            throw new Error(`Invalid pricing payload from ${url}`);
        }
        return parsed;
    }

    private flattenModelsDev(
        raw: Record<string, ModelsDevProvider>,
    ): PricingCatalog {
        const catalog: PricingCatalog = {};
        const bareOwner = new Map<string, string>();

        for (const [providerKey, provider] of Object.entries(raw)) {
            const providerId = (provider?.id ?? providerKey).toLowerCase();
            const models = provider?.models;
            if (!models || typeof models !== 'object') continue;

            for (const [modelKey, model] of Object.entries(models)) {
                const modelId = (model?.id ?? modelKey).toLowerCase();
                const entry = this.fromModelsDev(model?.cost, providerId);
                catalog[`${providerId}/${modelId}`] = entry;

                if (this.claimBareAlias(catalog, bareOwner, modelId, entry)) {
                    bareOwner.set(modelId, providerId);
                }
            }
        }
        return catalog;
    }

    /**
     * Whether `entry` should own the bare-id alias for `modelId`. First writer
     * wins, except that a priced entry beats an unpriced one and a native
     * provider beats an aggregator — so `kimi-k2.6` resolves to Moonshot's
     * list price, not whatever reseller happens to enumerate first.
     */
    private claimBareAlias(
        catalog: PricingCatalog,
        bareOwner: Map<string, string>,
        modelId: string,
        entry: CatalogEntry,
    ): boolean {
        const existing = bareOwner.has(modelId)
            ? catalog[modelId]
            : undefined;
        if (!existing) {
            catalog[modelId] = entry;
            return true;
        }

        const priced = (e: CatalogEntry) =>
            e.input.default > 0 || e.output.default > 0;
        const nativeOwner = !AGGREGATOR_PROVIDERS.has(
            bareOwner.get(modelId)!,
        );
        const nativeNew = !AGGREGATOR_PROVIDERS.has(entry.provider ?? '');

        const wins =
            (priced(entry) && !priced(existing)) ||
            (nativeNew && !nativeOwner && priced(entry) === priced(existing));
        if (wins) {
            catalog[modelId] = entry;
            return true;
        }
        return false;
    }

    private fromModelsDev(
        cost: ModelsDevCost | undefined,
        provider: string,
    ): CatalogEntry {
        // Prefer the explicit tier list (carries its own breakpoint); fall
        // back to the legacy fixed-200k object.
        const contextTier = cost?.tiers?.find(
            (t) =>
                (t?.tier?.type ?? 'context') === 'context' &&
                typeof t?.tier?.size === 'number',
        );
        const threshold = contextTier
            ? contextTier.tier!.size!
            : TIER_THRESHOLD_200K;
        const over = contextTier ?? cost?.context_over_200k;

        const perToken = (perMillion?: number): number | undefined =>
            typeof perMillion === 'number'
                ? perMillion / PER_MILLION
                : undefined;

        return {
            provider,
            input: this.toTokenPrice(
                perToken(cost?.input),
                perToken(over?.input),
                threshold,
            ),
            output: this.toTokenPrice(
                perToken(cost?.output),
                perToken(over?.output),
                threshold,
            ),
            cacheRead: this.toTokenPrice(
                perToken(cost?.cache_read),
                perToken(over?.cache_read),
                threshold,
            ),
            cacheWrite: this.toTokenPrice(
                perToken(cost?.cache_write),
                perToken(over?.cache_write),
                threshold,
            ),
            ...(typeof cost?.reasoning === 'number'
                ? { reasoning: cost.reasoning / PER_MILLION }
                : {}),
        };
    }

    private fromLiteLLM(entry: LiteLLMModel): CatalogEntry {
        return {
            provider: entry.litellm_provider,
            input: this.toTokenPrice(
                entry.input_cost_per_token,
                entry.input_cost_per_token_above_200k_tokens,
                TIER_THRESHOLD_200K,
            ),
            output: this.toTokenPrice(
                entry.output_cost_per_token,
                entry.output_cost_per_token_above_200k_tokens,
                TIER_THRESHOLD_200K,
            ),
            cacheRead: this.toTokenPrice(
                entry.cache_read_input_token_cost,
                entry.cache_read_input_token_cost_above_200k_tokens,
                TIER_THRESHOLD_200K,
            ),
            cacheWrite: this.toTokenPrice(
                entry.cache_creation_input_token_cost,
                entry.cache_creation_input_token_cost_above_200k_tokens,
                TIER_THRESHOLD_200K,
            ),
        };
    }

    private async getModelInfo(
        model: string,
        provider?: string,
    ): Promise<ModelPricingInfo> {
        // models.dev is the source of truth; LiteLLM stays as a fallback so
        // nothing it priced regresses during the cutover. Each source failing
        // to fetch is non-fatal as long as the other resolves the model.
        const match =
            (await this.lookupIn(
                () => this.getModelsDevCatalog(),
                'models.dev',
                model,
                provider,
            )) ??
            (await this.lookupIn(
                () => this.getLiteLLMCatalog(),
                'litellm',
                model,
                provider,
            ));

        if (!match) {
            this.logger.warn({
                message: 'Model not found in pricing catalogs',
                context: TokenPricingUseCase.name,
                metadata: { model, provider },
            });
            return this.emptyPricing(model, provider);
        }

        return this.toPricingInfo(match.id, match.data, provider);
    }

    private async lookupIn(
        getCatalog: () => Promise<PricingCatalog>,
        source: string,
        model: string,
        provider?: string,
    ): Promise<{ id: string; data: CatalogEntry } | null> {
        let catalog: PricingCatalog;
        try {
            catalog = await getCatalog();
        } catch (error) {
            this.logger.warn({
                message: 'Pricing catalog fetch failed',
                error,
                context: TokenPricingUseCase.name,
                metadata: { source, model },
            });
            return null;
        }
        return this.lookupModel(catalog, model, provider);
    }

    /**
     * Catalog keys are either the bare model id (`kimi-k2.6`) or
     * provider-prefixed (`moonshotai/kimi-k2.6`, `vertex_ai/gemini-...`). We
     * try exact match, then the unprefixed variant, then provider-prefixed
     * variants, then a best-effort prefix search (on the full key AND its last
     * segment) so versioned or provider-nested ids still resolve.
     */
    private lookupModel(
        catalog: PricingCatalog,
        model: string,
        provider?: string,
    ): { id: string; data: CatalogEntry } | null {
        if (!model) return null;

        const normalized = model.trim();
        const lowered = normalized.toLowerCase();
        // Provider separator may be ':' (Kodus internal BYOK format —
        // resolveModelName in observability.service.ts) or '/' (LiteLLM /
        // OpenRouter). Only normalize ':' when it precedes any '/', so
        // suffixes like OpenRouter's ':free' stay intact.
        const colonNormalized = /^[^:/]+:/.test(lowered)
            ? lowered.replace(':', '/')
            : lowered;
        const withoutPrefix = colonNormalized.includes('/')
            ? colonNormalized.split('/').slice(1).join('/')
            : colonNormalized;

        const direct = [normalized, lowered, colonNormalized, withoutPrefix];
        for (const key of direct) {
            if (catalog[key]) return { id: key, data: catalog[key] };
        }

        if (provider) {
            const providerLower = provider.toLowerCase();
            const providerVariants = [
                providerLower,
                // LiteLLM uses `vertex_ai`, models.dev `google-vertex`; our
                // BYOK enum uses `google-vertex`.
                providerLower.replace('google-vertex', 'vertex_ai'),
                providerLower.replace('google-gemini', 'gemini'),
                providerLower.replace('google-gemini', 'google'),
            ];
            for (const prov of providerVariants) {
                for (const key of direct) {
                    const candidate = `${prov}/${key}`;
                    if (catalog[candidate]) {
                        return { id: candidate, data: catalog[candidate] };
                    }
                }
            }
        }

        // Prefix fallback — e.g. a passed model "gemini-3.1-pro-preview"
        // should resolve against "gemini-3.1-pro-preview-customtools" if
        // that's the only variant present. Matching the key's last segment
        // too lets a bare id land on a provider-prefixed key.
        for (const key of Object.keys(catalog)) {
            const keyLower = key.toLowerCase();
            if (
                keyLower.startsWith(withoutPrefix) ||
                keyLower.split('/').pop()!.startsWith(withoutPrefix)
            ) {
                return { id: key, data: catalog[key] };
            }
        }

        return null;
    }

    private toPricingInfo(
        id: string,
        entry: CatalogEntry,
        provider?: string,
    ): ModelPricingInfo {
        return {
            id,
            provider: provider ?? entry.provider,
            pricing: {
                input: entry.input,
                output: entry.output,
                cacheRead: entry.cacheRead,
                cacheWrite: entry.cacheWrite,
                prompt: entry.input.default,
                completion: entry.output.default,
                internal_reasoning: entry.reasoning ?? entry.output.default,
            },
        };
    }

    private toTokenPrice(
        base?: number,
        tieredRate?: number,
        threshold: number = TIER_THRESHOLD_200K,
    ): TokenPrice {
        return {
            default: typeof base === 'number' ? base : 0,
            ...(typeof tieredRate === 'number'
                ? { tier: { threshold, rate: tieredRate } }
                : {}),
        };
    }

    private emptyPricing(id: string, provider?: string): ModelPricingInfo {
        const zero: TokenPrice = { default: 0 };
        return {
            id,
            provider,
            pricing: {
                input: zero,
                output: zero,
                cacheRead: zero,
                cacheWrite: zero,
                prompt: 0,
                completion: 0,
                internal_reasoning: 0,
            },
        };
    }
}
