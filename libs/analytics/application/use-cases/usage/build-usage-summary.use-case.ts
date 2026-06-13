import { Inject, Injectable } from '@nestjs/common';

import {
    ITokenUsageService,
    TOKEN_USAGE_SERVICE_TOKEN,
} from '@libs/analytics/domain/token-usage/contracts/tokenUsage.service.contract';
import {
    ApiPricingSource,
    BaseUsageContract,
    CostBreakdown,
    EnrichedModelUsage,
    TierUsage,
    TokenUsageQueryContract,
    UsageSummaryReportContract,
} from '@libs/analytics/domain/token-usage/types/tokenUsage.types';
import {
    ManualPricingOverrides,
    PricingSource,
} from '@libs/analytics/domain/token-usage/types/pricing.types';

import { ModelCostCalculator } from './model-cost-calculator';
import { PricingResolver } from './pricing-resolver';

const TO_API_SOURCE: Record<PricingSource, ApiPricingSource> = {
    manual: 'manual',
    catalog: 'catalog',
    none: 'missing',
};

/**
 * Builds the enriched payload the Token Usage page renders: flat totals + per
 * token-type cost + per-model rows annotated with cost-per-tier and pricing
 * source. Centralizing the assembly here keeps the controller thin and the
 * cost math in one place.
 */
@Injectable()
export class BuildUsageSummaryUseCase {
    constructor(
        @Inject(TOKEN_USAGE_SERVICE_TOKEN)
        private readonly tokenUsageService: ITokenUsageService,
        private readonly pricingResolver: PricingResolver,
    ) {}

    async execute(
        query: TokenUsageQueryContract,
        overrides?: ManualPricingOverrides,
    ): Promise<UsageSummaryReportContract> {
        const [totals, byModel] = await Promise.all([
            this.tokenUsageService.getSummary(query),
            this.tokenUsageService.getSummaryByModel(query),
        ]);

        const enrichedRows = await Promise.all(
            byModel.map((row) => this.enrich(row, overrides)),
        );

        const totalCost = enrichedRows.reduce<CostBreakdown>(
            (acc, row) => addCost(acc, row.cost),
            zeroCost(),
        );

        return { totals, totalCost, byModel: enrichedRows };
    }

    private async enrich(
        row: BaseUsageContract,
        overrides?: ManualPricingOverrides,
    ): Promise<EnrichedModelUsage> {
        const resolved = await this.pricingResolver.resolve(row.model, overrides);
        const pricingSource = TO_API_SOURCE[resolved.source];

        if (row.byTier) {
            const leCost = ModelCostCalculator.bucketCost(
                row.byTier.le,
                resolved.rates,
                'default',
            );
            const gtCost = ModelCostCalculator.bucketCost(
                row.byTier.gt,
                resolved.rates,
                'tier',
            );
            return {
                ...row,
                cost: addCost(leCost, gtCost),
                costByTier: { le: leCost, gt: gtCost },
                pricingSource,
            };
        }

        // Flat row — treat as a single `le` bucket.
        const flatBucket: TierUsage = {
            input: row.input,
            output: row.output,
            total: row.total,
            outputReasoning: row.outputReasoning,
            cacheRead: row.cacheRead ?? 0,
            cacheWrite: row.cacheWrite ?? 0,
        };
        return {
            ...row,
            cost: ModelCostCalculator.bucketCost(
                flatBucket,
                resolved.rates,
                'default',
            ),
            pricingSource,
        };
    }
}

function zeroCost(): CostBreakdown {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function addCost(a: CostBreakdown, b: CostBreakdown): CostBreakdown {
    return {
        input: a.input + b.input,
        output: a.output + b.output,
        cacheRead: a.cacheRead + b.cacheRead,
        cacheWrite: a.cacheWrite + b.cacheWrite,
        total: a.total + b.total,
    };
}
