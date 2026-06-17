/**
 * code-review (domain) — adapter from BYOK to the agent-harness ModelResolver
 * port. This is the L0 boundary made concrete: agent-harness stays model-
 * agnostic (depends only on ModelResolver), while the real provider wiring
 * (BYOK + Vercel AI SDK) lives here.
 *
 * The model factory is injected so the resolver is unit-testable without any
 * real provider (the test passes a fake factory). Defaults to the production
 * byokToVercelModel.
 */
import type { LanguageModel } from 'ai';

import type { ModelResolver } from '@libs/agent-harness/domain/contracts/model.contract';
import type { BYOKConfig } from '@kodus/kodus-common/llm';

import {
    byokToVercelModel,
    type ByokModelOptions,
} from '@libs/llm/byok-to-vercel';

type ModelFactory = (
    byokConfig?: BYOKConfig,
    role?: 'main' | 'fallback',
    options?: ByokModelOptions,
    defaultModelOverride?: string,
) => LanguageModel;

export interface ByokModelResolverParams {
    byokConfig?: BYOKConfig;
    role?: 'main' | 'fallback';
    options?: ByokModelOptions;
    /** Injectable for tests; defaults to production byokToVercelModel. */
    factory?: ModelFactory;
}

export class ByokModelResolver implements ModelResolver<LanguageModel> {
    private readonly byokConfig?: BYOKConfig;
    private readonly role: 'main' | 'fallback';
    private readonly options: ByokModelOptions;
    private readonly factory: ModelFactory;

    constructor(params: ByokModelResolverParams = {}) {
        this.byokConfig = params.byokConfig;
        this.role = params.role ?? 'main';
        this.options = params.options ?? {};
        this.factory = params.factory ?? byokToVercelModel;
    }

    /** modelId acts as the default-model override: a spec can request a
     *  specific model (e.g. a cheap model for verify) while the org BYOK
     *  config still governs provider/credentials. */
    resolve(modelId: string): LanguageModel {
        return this.factory(
            this.byokConfig,
            this.role,
            this.options,
            modelId || undefined,
        );
    }
}
