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

import { ObservabilityTelemetryModel } from './schemas/observabilityTelemetry.model';

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
    constructor(
        @InjectModel(ObservabilityTelemetryModel.name)
        private readonly observabilityTelemetryModel: Model<ObservabilityTelemetryModel>,
    ) {}

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

    /**
     * Reads the pre-derived, indexable `attributes.tu.*` sub-doc via the
     * covering index instead of $getField over the fat dotted-key attributes.
     * The aggregation is index-covered (docsExamined=0) → ~2s vs ~90s.
     *
     * Both Token Usage views are reproduced EXACTLY via the baked flags (see
     * token-usage-tu.ts):
     *   - byok=true  → attributes.tu.isByok === true  (spans with type='byok')
     *   - byok=false → attributes.tu.sys === false     (all usage spans except
     *     the internal system-analysis run-names — the cost-simulation view)
     * `tu` exists only on spans that had LLM usage, so matching either flag also
     * implies "has token data" (the old matchHasTokenData guard).
     */
    /**
     * Shared `$match` for the covered path: org + timestamp + the view flag
     * (isByok/sys), plus optional prNumber and model filters. `prOnly` restricts
     * to spans that carry a prNumber (for the by-PR aggregations).
     */
    private _tuMatch(
        query: TokenUsageQueryContract,
        prOnly = false,
    ): Record<string, any> {
        const match: Record<string, any> = {
            'attributes.organizationId': query.organizationId,
            timestamp: { $gte: query.start, $lte: query.end },
            ...(query.byok
                ? { 'attributes.tu.isByok': true }
                : { 'attributes.tu.sys': false }),
        };
        if (query.prNumber) match['attributes.prNumber'] = query.prNumber;
        else if (prOnly)
            // `{$type:'number'}` — NOT `{$exists:true,$ne:null}`: $exists in the
            // match forces a FETCH of every candidate doc (docsExamined=1.27M,
            // ~13s), while a value predicate is read from the covering index
            // (docsExamined=0, ~3s). Equivalent — prNumber is always numeric
            // when present.
            match['attributes.prNumber'] = { $type: 'number' };
        if (query.models)
            match['attributes.tu.model'] = { $in: query.models.split(',') };
        return match;
    }

    private async _tuRows(
        query: TokenUsageQueryContract,
        groupById: Record<string, any> = {},
        projectExtras: Record<string, any> = {},
        prOnly = false,
    ): Promise<RawAggRow[]> {
        const pipeline = [
            { $match: this._tuMatch(query, prOnly) },
            {
                $group: {
                    _id: {
                        model: '$attributes.tu.model',
                        tier: '$attributes.tu.tier',
                        ...groupById,
                    },
                    input: { $sum: '$attributes.tu.input' },
                    output: { $sum: '$attributes.tu.output' },
                    total: { $sum: '$attributes.tu.total' },
                    outputReasoning: { $sum: '$attributes.tu.reasoning' },
                    cacheRead: { $sum: '$attributes.tu.cacheRead' },
                    cacheWrite: { $sum: '$attributes.tu.cacheWrite' },
                },
            },
            {
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
            },
        ];
        return this.observabilityTelemetryModel
            .aggregate<RawAggRow>(pipeline)
            .exec();
    }

    /** A model is tier-aware in this window if it produced any 'gt' rows. */
    private _thresholdsFromRows(rows: RawAggRow[]): Map<string, number> {
        return new Map(
            rows.filter((r) => r.tier === 'gt').map((r) => [r.model, 1]),
        );
    }

    async getSummary(
        query: TokenUsageQueryContract,
    ): Promise<UsageSummaryContract> {
        const rows = await this._tuRows(query);

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
        const rows = await this._tuRows(query);
        return this._mergeTierRows(
            rows,
            this._thresholdsFromRows(rows),
            (r) => r.model,
            (base) => base,
        );
    }

    async getDailyUsage(
        query: TokenUsageQueryContract,
    ): Promise<DailyUsageResultContract[]> {
        const rows = await this._tuRows(
            query,
            {
                date: {
                    $dateToString: {
                        format: '%Y-%m-%d',
                        date: '$timestamp',
                        timezone: query.timezone || 'UTC',
                    },
                },
            },
            { date: '$_id.date' },
        );

        const merged = this._mergeTierRows<DailyUsageResultContract>(
            rows,
            this._thresholdsFromRows(rows),
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
        const rows = await this._tuRows(
            query,
            { pr: '$attributes.prNumber' },
            { prNumber: '$_id.pr' },
            true,
        );

        const merged = this._mergeTierRows<UsageByPrResultContract>(
            rows,
            this._thresholdsFromRows(rows),
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
        const rows = await this._tuRows(
            query,
            {
                prNumber: '$attributes.prNumber',
                date: {
                    $dateToString: {
                        format: '%Y-%m-%d',
                        date: '$timestamp',
                        timezone: query.timezone || 'UTC',
                    },
                },
            },
            { prNumber: '$_id.prNumber', date: '$_id.date' },
            true,
        );

        const merged = this._mergeTierRows<DailyUsageByPrResultContract>(
            rows,
            this._thresholdsFromRows(rows),
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

    /**
     * Single-pass overview: summary + byModel + daily + byPr + dailyByPr in ONE
     * covered aggregation via `$facet`. The org+timestamp+flag scan happens once
     * instead of ~4 separate covered scans (the screen fires summary=2 + daily +
     * by-pr in parallel) — which both cuts wall time and removes the concurrent
     * scan load that caused the prod OOM.
     *
     * A `$project` of ONLY index-covered fields sits before `$facet`: `$facet`
     * is a blocking stage, so without it the `$match` would FETCH full docs to
     * feed the sub-pipelines, defeating the covering. Projecting the tu fields
     * (all in `tu_cover_*`) keeps the scan index-only (docsExamined=0).
     *
     * Numbers are identical to the standalone endpoints — same group math, same
     * baked tier — proven by the golden test.
     */
    async getUsageOverview(query: TokenUsageQueryContract): Promise<{
        summary: UsageSummaryContract;
        byModel: BaseUsageContract[];
        daily: DailyUsageResultContract[];
        byPr: UsageByPrResultContract[];
    }> {
        // Project only index fields → $facet works on a lean covered stream.
        const projectTu = {
            $project: {
                _id: 0,
                model: '$attributes.tu.model',
                tier: '$attributes.tu.tier',
                pr: '$attributes.prNumber',
                date: {
                    $dateToString: {
                        format: '%Y-%m-%d',
                        date: '$timestamp',
                        timezone: query.timezone || 'UTC',
                    },
                },
                input: '$attributes.tu.input',
                output: '$attributes.tu.output',
                total: '$attributes.tu.total',
                reasoning: '$attributes.tu.reasoning',
                cacheRead: '$attributes.tu.cacheRead',
                cacheWrite: '$attributes.tu.cacheWrite',
            },
        };
        const acc = {
            input: { $sum: '$input' },
            output: { $sum: '$output' },
            total: { $sum: '$total' },
            outputReasoning: { $sum: '$reasoning' },
            cacheRead: { $sum: '$cacheRead' },
            cacheWrite: { $sum: '$cacheWrite' },
        };
        const groupProject = (
            groupById: Record<string, any>,
            projectExtras: Record<string, any>,
        ) => [
            {
                $group: {
                    _id: { model: '$model', tier: '$tier', ...groupById },
                    ...acc,
                },
            },
            {
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
            },
        ];
        // PR facets drop projected rows without a prNumber (matches the
        // standalone getUsageByPr/getDailyUsageByPr prOnly filter).
        const prPresent = { $match: { pr: { $exists: true, $ne: null } } };

        const pipeline = [
            { $match: this._tuMatch(query) },
            projectTu,
            {
                $facet: {
                    byModel: groupProject({}, {}),
                    daily: groupProject({ date: '$date' }, { date: '$_id.date' }),
                    byPr: [
                        prPresent,
                        ...groupProject({ pr: '$pr' }, { prNumber: '$_id.pr' }),
                    ],
                },
            },
        ];

        const [facet] = await this.observabilityTelemetryModel
            .aggregate<{
                byModel: RawAggRow[];
                daily: RawAggRow[];
                byPr: RawAggRow[];
            }>(pipeline)
            .exec();

        const rows = facet ?? {
            byModel: [],
            daily: [],
            byPr: [],
        };
        // Tier-awareness derived from the baked tier rows (same as _tuRows).
        const thresholds = this._thresholdsFromRows(rows.byModel);

        const byModel = this._mergeTierRows(
            rows.byModel,
            thresholds,
            (r) => r.model,
            (base) => base,
        );

        const summary: UsageSummaryContract = {
            model: '',
            input: 0,
            output: 0,
            total: 0,
            outputReasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
        };
        for (const r of rows.byModel) {
            summary.input += r.input;
            summary.output += r.output;
            summary.total += r.total;
            summary.outputReasoning += r.outputReasoning;
            summary.cacheRead = (summary.cacheRead ?? 0) + r.cacheRead;
            summary.cacheWrite = (summary.cacheWrite ?? 0) + r.cacheWrite;
        }

        const daily = this._mergeTierRows<DailyUsageResultContract>(
            rows.daily,
            thresholds,
            (r) => `${r.date}|${r.model}`,
            (base, row) => ({ ...base, date: row.date! }),
        ).sort((a, b) =>
            a.date === b.date
                ? a.model.localeCompare(b.model)
                : a.date.localeCompare(b.date),
        );

        const byPr = this._mergeTierRows<UsageByPrResultContract>(
            rows.byPr,
            thresholds,
            (r) => `${r.prNumber}|${r.model}`,
            (base, row) => ({ ...base, prNumber: row.prNumber! }),
        ).sort((a, b) =>
            a.prNumber === b.prNumber
                ? a.model.localeCompare(b.model)
                : a.prNumber - b.prNumber,
        );

        return { summary, byModel, daily, byPr };
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
