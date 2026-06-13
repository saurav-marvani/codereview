import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { ITokenUsageRepository } from '@libs/analytics/domain/token-usage/contracts/tokenUsage.repository.contract';
import {
    BaseUsageContract,
    DailyUsageByPrResultContract,
    DailyUsageResultContract,
    TierUsage,
    TokenUsageQueryContract,
    UsageByPrResultContract,
    UsageSummaryContract,
} from '@libs/analytics/domain/token-usage/types/tokenUsage.types';

import { PricingResolver } from '@libs/analytics/application/use-cases/usage/pricing-resolver';

import { ObservabilityTelemetryModel } from './schemas/observabilityTelemetry.model';
import { LLMAnalysisService } from '@libs/code-review/infrastructure/adapters/services/llmAnalysis.service';

type RawAggRow = {
    model: string;
    tier: 'le' | 'gt';
    input: number;
    output: number;
    total: number;
    outputReasoning: number;
    cacheRead: number;
    cacheWrite: number;
    date?: string;
    prNumber?: number;
};

@Injectable()
export class TokenUsageRepository implements ITokenUsageRepository {
    /**
     * Sum accumulators applied per (model, tier) group. Each pulls a token
     * count from the observability span's dotted-key attributes.
     */
    private readonly GROUP_ACCUMULATORS = {
        input: this._sumAttr('gen_ai.usage.input_tokens'),
        output: this._sumAttr('gen_ai.usage.output_tokens'),
        total: this._sumAttr('gen_ai.usage.total_tokens'),
        outputReasoning: this._sumAttr('gen_ai.usage.reasoning_tokens'),
        cacheRead: this._sumAttr('gen_ai.usage.cache_read_input_tokens'),
        cacheWrite: this._sumAttr('gen_ai.usage.cache_creation_input_tokens'),
    };

    constructor(
        @InjectModel(ObservabilityTelemetryModel.name)
        private readonly observabilityTelemetryModel: Model<ObservabilityTelemetryModel>,
        private readonly pricingResolver: PricingResolver,
    ) {}

    private _sumAttr(field: string) {
        return {
            $sum: {
                $ifNull: [
                    { $getField: { field, input: '$attributes' } },
                    0,
                ],
            },
        };
    }

    /**
     * Pulls the distinct canonical model names that appear inside the query's
     * org + date window. We need this list before running the main aggregation
     * to look up each model's input tier threshold from the PricingResolver.
     */
    private async _distinctCanonicalModels(
        query: TokenUsageQueryContract,
    ): Promise<string[]> {
        const rows = await this.observabilityTelemetryModel
            .aggregate<{ _id: string }>([
                {
                    $match: {
                        'attributes.organizationId': query.organizationId,
                        timestamp: { $gte: query.start, $lte: query.end },
                    },
                },
                {
                    $group: {
                        _id: {
                            $let: {
                                vars: {
                                    raw: {
                                        $ifNull: [
                                            {
                                                $getField: {
                                                    field: 'gen_ai.response.model',
                                                    input: '$attributes',
                                                },
                                            },
                                            '',
                                        ],
                                    },
                                },
                                in: {
                                    $arrayElemAt: [
                                        { $split: ['$$raw', ':'] },
                                        -1,
                                    ],
                                },
                            },
                        },
                    },
                },
            ])
            .exec();
        return rows.map((r) => r._id).filter((m) => typeof m === 'string' && m);
    }

    /**
     * Resolves each canonical model to its input tier threshold (in tokens).
     * Models without a tier breakpoint (most providers — Gemini Pro is the
     * notable exception) are omitted from the map.
     */
    private async _fetchInputThresholds(
        canonicalModels: string[],
    ): Promise<Map<string, number>> {
        if (canonicalModels.length === 0) return new Map();
        const resolved = await this.pricingResolver.resolveMany(canonicalModels);
        const out = new Map<string, number>();
        for (const r of resolved) {
            const threshold = r.rates.input.tier?.threshold;
            if (typeof threshold === 'number' && threshold > 0) {
                out.set(r.model, threshold);
            }
        }
        return out;
    }

    /**
     * Builds the per-model $switch expression that resolves each call's tier
     * threshold. Models without a tier collapse to the `default` branch (which
     * returns 0, so every call is treated as "le tier" — equivalent to flat
     * pricing in the cost calculator).
     */
    private _thresholdSwitch(thresholds: Map<string, number>) {
        const branches: Array<{ case: any; then: number }> = [];
        for (const [model, threshold] of thresholds) {
            branches.push({
                case: { $eq: ['$_canonicalModel', model] },
                then: threshold,
            });
        }
        if (branches.length === 0) return 0;
        return { $switch: { branches, default: 0 } };
    }

    private _createUsageAggregationPipeline(params: {
        query: TokenUsageQueryContract;
        thresholds: Map<string, number>;
        matchStage?: Record<string, any>;
        groupById?: any;
        projectExtras?: Record<string, any>;
    }): any[] {
        const {
            query,
            thresholds,
            matchStage = {},
            groupById = {},
            projectExtras = {},
        } = params;

        const matchOrgAndDate = {
            $match: {
                'attributes.organizationId': query.organizationId,
                timestamp: { $gte: query.start, $lte: query.end },
                ...matchStage,
            },
        };

        // Exclude spans without token data (wrapper/parent spans that have no LLM usage)
        const matchHasTokenData = {
            $match: {
                $expr: {
                    $gt: [
                        {
                            $ifNull: [
                                {
                                    $getField: {
                                        field: 'gen_ai.usage.total_tokens',
                                        input: '$attributes',
                                    },
                                },
                                0,
                            ],
                        },
                        0,
                    ],
                },
            },
        };

        const matchBYOK = {
            $match: query.byok
                ? { 'attributes.type': 'byok' }
                : {
                      // would-be BYOK runs (for free-trial cost simulation)
                      $expr: {
                          $not: {
                              $in: [
                                  {
                                      $getField: {
                                          field: 'gen_ai.run.name',
                                          input: '$attributes',
                                      },
                                  },
                                  [
                                      LLMAnalysisService.prototype
                                          .selectReviewMode.name,
                                      LLMAnalysisService.prototype
                                          .validateImplementedSuggestions.name,
                                      LLMAnalysisService.prototype
                                          .generateCodeSuggestions.name,
                                      'analyzeASTWithAI',
                                  ],
                              ],
                          },
                      },
                  },
        };

        const matchPRNumber = {
            $match: query.prNumber
                ? { 'attributes.prNumber': query.prNumber }
                : {},
        };

        const matchModels = {
            $match: query.models
                ? {
                      $expr: {
                          $in: [
                              {
                                  $getField: {
                                      field: 'gen_ai.response.model',
                                      input: '$attributes',
                                  },
                              },
                              query.models.split(','),
                          ],
                      },
                  }
                : {},
        };

        // Normalize the model name and the raw input count, then derive the
        // per-call tier from the pre-fetched threshold map. Canonical name
        // collapses `google_gemini:gemini-2.5-pro` → `gemini-2.5-pro` so both
        // BYOK-prefixed and bare grafias roll into one row.
        const addDerivedFields = {
            $addFields: {
                _rawModel: {
                    $ifNull: [
                        {
                            $getField: {
                                field: 'gen_ai.response.model',
                                input: '$attributes',
                            },
                        },
                        '',
                    ],
                },
                _input: {
                    $ifNull: [
                        {
                            $getField: {
                                field: 'gen_ai.usage.input_tokens',
                                input: '$attributes',
                            },
                        },
                        0,
                    ],
                },
            },
        };

        const addCanonicalModel = {
            $addFields: {
                _canonicalModel: {
                    $arrayElemAt: [{ $split: ['$_rawModel', ':'] }, -1],
                },
            },
        };

        const addTier = {
            $addFields: {
                _threshold: this._thresholdSwitch(thresholds),
            },
        };

        const addTierBucket = {
            $addFields: {
                _tier: {
                    $cond: [
                        {
                            $and: [
                                { $gt: ['$_threshold', 0] },
                                { $gt: ['$_input', '$_threshold'] },
                            ],
                        },
                        'gt',
                        'le',
                    ],
                },
            },
        };

        const groupStage = {
            $group: {
                _id: {
                    model: '$_canonicalModel',
                    tier: '$_tier',
                    ...groupById,
                },
                ...this.GROUP_ACCUMULATORS,
            },
        };

        const projectStageFinal = {
            $project: {
                ...projectExtras,
                _id: 0,
                model: '$_id.model',
                tier: '$_id.tier',
                input: 1,
                output: 1,
                total: 1,
                outputReasoning: 1,
                cacheRead: 1,
                cacheWrite: 1,
            },
        };

        return [
            matchOrgAndDate,
            matchHasTokenData,
            matchBYOK,
            matchPRNumber,
            matchModels,
            addDerivedFields,
            addCanonicalModel,
            addTier,
            addTierBucket,
            groupStage,
            projectStageFinal,
        ];
    }

    /**
     * Returns one BaseUsageContract per logical bucket (per model + per
     * groupKey), folding the raw tier rows into `byTier`. `byTier` is kept
     * only for models declared as tier-aware in `thresholds` — flat-priced
     * models get a clean flat contract.
     */
    private _mergeTierRows<T extends BaseUsageContract>(
        rows: RawAggRow[],
        thresholds: Map<string, number>,
        keyOf: (r: RawAggRow) => string,
        finalize: (base: BaseUsageContract, row: RawAggRow) => T,
    ): T[] {
        const grouped = new Map<string, T>();
        for (const row of rows) {
            const key = keyOf(row);
            const existing = grouped.get(key);
            const tierBucket: TierUsage = {
                input: row.input,
                output: row.output,
                total: row.total,
                outputReasoning: row.outputReasoning,
                cacheRead: row.cacheRead,
                cacheWrite: row.cacheWrite,
            };
            if (!existing) {
                const tierAware = thresholds.has(row.model);
                const base: BaseUsageContract = {
                    model: row.model,
                    input: row.input,
                    output: row.output,
                    total: row.total,
                    outputReasoning: row.outputReasoning,
                    cacheRead: row.cacheRead,
                    cacheWrite: row.cacheWrite,
                    ...(tierAware
                        ? { byTier: { le: emptyTier(), gt: emptyTier() } }
                        : {}),
                };
                if (base.byTier) base.byTier[row.tier] = tierBucket;
                grouped.set(key, finalize(base, row));
            } else {
                existing.input += row.input;
                existing.output += row.output;
                existing.total += row.total;
                existing.outputReasoning += row.outputReasoning;
                existing.cacheRead = (existing.cacheRead ?? 0) + row.cacheRead;
                existing.cacheWrite =
                    (existing.cacheWrite ?? 0) + row.cacheWrite;
                if (existing.byTier) existing.byTier[row.tier] = tierBucket;
            }
        }
        return Array.from(grouped.values());
    }

    async getSummary(
        query: TokenUsageQueryContract,
    ): Promise<UsageSummaryContract> {
        const canonicalModels = await this._distinctCanonicalModels(query);
        const thresholds = await this._fetchInputThresholds(canonicalModels);
        const pipeline = this._createUsageAggregationPipeline({
            query,
            thresholds,
        });

        const rows = await this.observabilityTelemetryModel
            .aggregate<RawAggRow>(pipeline)
            .exec();

        // Cross-model rollup: one row total.
        const summary: UsageSummaryContract = {
            model: '',
            input: 0,
            output: 0,
            total: 0,
            outputReasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
        };
        for (const r of rows) {
            summary.input += r.input;
            summary.output += r.output;
            summary.total += r.total;
            summary.outputReasoning += r.outputReasoning;
            summary.cacheRead = (summary.cacheRead ?? 0) + r.cacheRead;
            summary.cacheWrite = (summary.cacheWrite ?? 0) + r.cacheWrite;
        }
        return summary;
    }

    /**
     * Per-model summary across the date range with tier breakdown. Powers the
     * detail table on the Token Usage page — one block per model, each with
     * its byTier counts.
     */
    async getSummaryByModel(
        query: TokenUsageQueryContract,
    ): Promise<BaseUsageContract[]> {
        const canonicalModels = await this._distinctCanonicalModels(query);
        const thresholds = await this._fetchInputThresholds(canonicalModels);
        const pipeline = this._createUsageAggregationPipeline({
            query,
            thresholds,
        });

        const rows = await this.observabilityTelemetryModel
            .aggregate<RawAggRow>(pipeline)
            .exec();

        return this._mergeTierRows(
            rows,
            thresholds,
            (r) => r.model,
            (base) => base,
        );
    }

    async getDailyUsage(
        query: TokenUsageQueryContract,
    ): Promise<DailyUsageResultContract[]> {
        const canonicalModels = await this._distinctCanonicalModels(query);
        const thresholds = await this._fetchInputThresholds(canonicalModels);
        const pipeline = this._createUsageAggregationPipeline({
            query,
            thresholds,
            groupById: {
                date: {
                    $dateToString: {
                        format: '%Y-%m-%d',
                        date: '$timestamp',
                        timezone: query.timezone || 'UTC',
                    },
                },
            },
            projectExtras: {
                date: '$_id.date',
            },
        });

        const rows = await this.observabilityTelemetryModel
            .aggregate<RawAggRow>(pipeline)
            .exec();

        const merged = this._mergeTierRows<DailyUsageResultContract>(
            rows,
            thresholds,
            (r) => `${r.date}|${r.model}`,
            (base, row) => ({ ...base, date: row.date! }),
        );
        merged.sort((a, b) =>
            a.date === b.date
                ? a.model.localeCompare(b.model)
                : a.date.localeCompare(b.date),
        );
        return merged;
    }

    async getUsageByPr(
        query: TokenUsageQueryContract,
    ): Promise<UsageByPrResultContract[]> {
        const canonicalModels = await this._distinctCanonicalModels(query);
        const thresholds = await this._fetchInputThresholds(canonicalModels);
        const pipeline = this._createUsageAggregationPipeline({
            query,
            thresholds,
            matchStage: { 'attributes.prNumber': { $exists: true, $ne: null } },
            groupById: {
                pr: '$attributes.prNumber',
            },
            projectExtras: {
                prNumber: '$_id.pr',
            },
        });

        const rows = await this.observabilityTelemetryModel
            .aggregate<RawAggRow>(pipeline)
            .exec();

        const merged = this._mergeTierRows<UsageByPrResultContract>(
            rows,
            thresholds,
            (r) => `${r.prNumber}|${r.model}`,
            (base, row) => ({ ...base, prNumber: row.prNumber! }),
        );
        merged.sort((a, b) =>
            a.prNumber === b.prNumber
                ? a.model.localeCompare(b.model)
                : a.prNumber - b.prNumber,
        );
        return merged;
    }

    async getDailyUsageByPr(
        query: TokenUsageQueryContract,
    ): Promise<DailyUsageByPrResultContract[]> {
        const canonicalModels = await this._distinctCanonicalModels(query);
        const thresholds = await this._fetchInputThresholds(canonicalModels);
        const pipeline = this._createUsageAggregationPipeline({
            query,
            thresholds,
            matchStage: { 'attributes.prNumber': { $exists: true, $ne: null } },
            groupById: {
                prNumber: '$attributes.prNumber',
                date: {
                    $dateToString: {
                        format: '%Y-%m-%d',
                        date: '$timestamp',
                        timezone: query.timezone || 'UTC',
                    },
                },
            },
            projectExtras: {
                prNumber: '$_id.prNumber',
                date: '$_id.date',
            },
        });

        const rows = await this.observabilityTelemetryModel
            .aggregate<RawAggRow>(pipeline)
            .exec();

        const merged = this._mergeTierRows<DailyUsageByPrResultContract>(
            rows,
            thresholds,
            (r) => `${r.prNumber}|${r.date}|${r.model}`,
            (base, row) => ({
                ...base,
                prNumber: row.prNumber!,
                date: row.date!,
            }),
        );
        merged.sort((a, b) => {
            if (a.prNumber !== b.prNumber) return a.prNumber - b.prNumber;
            if (a.date !== b.date) return a.date.localeCompare(b.date);
            return a.model.localeCompare(b.model);
        });
        return merged;
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
