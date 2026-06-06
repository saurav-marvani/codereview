import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ANALYTICS_DATA_SOURCE } from '@libs/ee/analytics-warehouse';

import {
    computePreviousPeriod,
    computeTrend,
} from '../../application/date-range.util';
import {
    CockpitRangeQuery,
    IgnoredCriticalsHighlight,
    ImplementationRateByCategoryRow,
    KodyRuleUsageRow,
    NegativeFeedbackByCategoryRow,
    NegativeFeedbackWeeklyRow,
    NegativeVoteRateHighlight,
    ImplementationRateBySeverityRow,
    ImplementationRateWeeklyRow,
    RepositoryHealthRow,
    SuggestionsExplorerItem,
    SuggestionsExplorerQuery,
    SuggestionsExplorerResult,
} from '../../domain/types';

/**
 * "Kodus Review" tab of the cockpit revamp — metrics about Kodus itself
 * (is the team acting on what we say?) rather than generic productivity.
 *
 * Conventions shared with `CockpitCodeHealthService`:
 *  - aggregations join `suggestions_mv` → `pull_requests_opt` and scope by
 *    the PR's `parsed_closed_at` window, since implementation status is only
 *    resolved once the PR closes;
 *  - only delivered suggestions count (`suggestionDeliveryStatus = 'sent'`);
 *  - "implemented" means `implemented` or `partially_implemented`;
 *  - rates are 0..1 ratios rounded to 2 decimals.
 *
 * The explorer is the exception: it scopes by `suggestionCreatedAt` so
 * suggestions on still-open PRs are also listed.
 */

const IMPLEMENTED = `IN ('implemented','partially_implemented')`;

/** Minimum sample for a category to qualify as a repo's "weakest". */
const WEAKEST_CATEGORY_MIN_SENT = 5;

const EXPLORER_DEFAULT_PAGE_SIZE = 20;
const EXPLORER_MAX_PAGE_SIZE = 100;
const IGNORED_CRITICALS_MAX_ITEMS = 50;

@Injectable()
export class CockpitReviewAnalyticsService {
    constructor(
        @InjectDataSource(ANALYTICS_DATA_SOURCE)
        private readonly ds: DataSource,
    ) {}

    private round(value: number | string | null | undefined): number {
        return Number(Number(value ?? 0).toFixed(2));
    }

    private rate(sent: number, implemented: number): number {
        return sent === 0 ? 0 : this.round(implemented / sent);
    }

    /**
     * Shared WHERE for closed-PR-scoped aggregations (aliases `s` for the
     * suggestion and `pr` for the PR). Pushes params and returns the SQL
     * fragment with the right placeholders.
     */
    private closedPrWhere(q: CockpitRangeQuery, params: unknown[]): string {
        params.push(q.organizationId, q.startDate, q.endDate);
        const repoFilter = q.repository
            ? (params.push(q.repository),
              `AND pr.repo_full_name = $${params.length}`)
            : '';
        return `pr."organizationId" = $1
                 AND pr."closedAt" IS NOT NULL AND pr."closedAt" <> ''
                 AND pr."status" = 'closed'
                 AND pr."parsed_closed_at" BETWEEN $2::timestamptz AND $3::timestamptz
                 AND s."suggestionDeliveryStatus" = 'sent'
                 ${repoFilter}`;
    }

    /** Shared FROM/WHERE built on top of {@link closedPrWhere}. */
    private closedPrScope(q: CockpitRangeQuery, params: unknown[]): string {
        return `FROM "analytics"."suggestions_mv" s
                JOIN "analytics"."pull_requests_opt" pr ON pr."_id" = s."pullRequestId"
               WHERE ${this.closedPrWhere(q, params)}`;
    }

    async getImplementationRateWeekly(
        q: CockpitRangeQuery,
    ): Promise<ImplementationRateWeeklyRow[]> {
        const params: unknown[] = [];
        const scope = this.closedPrScope(q, params);

        const rows = (await this.ds.query(
            `SELECT
                to_char(date_trunc('week', pr.parsed_closed_at), 'YYYY-MM-DD') AS week_start,
                COALESCE(lower(s."severity"), 'unknown') AS severity,
                COUNT(*)::int AS sent,
                COUNT(*) FILTER (WHERE s."suggestionImplementationStatus" ${IMPLEMENTED})::int AS implemented
             ${scope}
             GROUP BY date_trunc('week', pr.parsed_closed_at), severity
             ORDER BY date_trunc('week', pr.parsed_closed_at) ASC`,
            params,
        )) as Array<{
            week_start: string;
            severity: string;
            sent: number;
            implemented: number;
        }>;

        const weeks = new Map<string, ImplementationRateWeeklyRow>();
        for (const r of rows) {
            let week = weeks.get(r.week_start);
            if (!week) {
                week = {
                    weekStart: r.week_start,
                    sent: 0,
                    implemented: 0,
                    rate: 0,
                    bySeverity: {},
                };
                weeks.set(r.week_start, week);
            }
            const sent = Number(r.sent);
            const implemented = Number(r.implemented);
            week.sent += sent;
            week.implemented += implemented;
            week.bySeverity[r.severity] = {
                sent,
                implemented,
                rate: this.rate(sent, implemented),
            };
        }

        return [...weeks.values()].map((w) => ({
            ...w,
            rate: this.rate(w.sent, w.implemented),
        }));
    }

    async getImplementationRateByCategory(
        q: CockpitRangeQuery,
    ): Promise<ImplementationRateByCategoryRow[]> {
        const params: unknown[] = [];
        const scope = this.closedPrScope(q, params);

        const rows = (await this.ds.query(
            `SELECT
                COALESCE(s."label", 'Unknown') AS category,
                COUNT(*)::int AS sent,
                COUNT(*) FILTER (WHERE s."suggestionImplementationStatus" ${IMPLEMENTED})::int AS implemented
             ${scope}
             GROUP BY category
             ORDER BY sent DESC`,
            params,
        )) as Array<{ category: string; sent: number; implemented: number }>;

        return rows.map((r) => ({
            category: r.category,
            sent: Number(r.sent),
            implemented: Number(r.implemented),
            rate: this.rate(Number(r.sent), Number(r.implemented)),
        }));
    }

    async getImplementationRateBySeverity(
        q: CockpitRangeQuery,
    ): Promise<ImplementationRateBySeverityRow[]> {
        const params: unknown[] = [];
        const scope = this.closedPrScope(q, params);

        const rows = (await this.ds.query(
            `SELECT
                COALESCE(lower(s."severity"), 'unknown') AS severity,
                COUNT(*)::int AS sent,
                COUNT(*) FILTER (WHERE s."suggestionImplementationStatus" ${IMPLEMENTED})::int AS implemented
             ${scope}
             GROUP BY severity
             ORDER BY CASE COALESCE(lower(s."severity"), 'unknown')
                          WHEN 'critical' THEN 0
                          WHEN 'high' THEN 1
                          WHEN 'medium' THEN 2
                          WHEN 'low' THEN 3
                          ELSE 4
                      END`,
            params,
        )) as Array<{ severity: string; sent: number; implemented: number }>;

        return rows.map((r) => ({
            severity: r.severity,
            sent: Number(r.sent),
            implemented: Number(r.implemented),
            rate: this.rate(Number(r.sent), Number(r.implemented)),
        }));
    }

    async getIgnoredCriticals(
        q: CockpitRangeQuery,
    ): Promise<IgnoredCriticalsHighlight> {
        const params: unknown[] = [];
        const scope = this.closedPrScope(q, params);

        const rows = (await this.ds.query(
            `SELECT
                s."suggestion_id" AS suggestion_id,
                pr.repo_full_name AS repository,
                s."filePath" AS file_path,
                s."label" AS category,
                s."raw"->>'oneSentenceSummary' AS summary,
                s."pullRequestId" AS pull_request_id,
                pr."pr_number" AS pr_number,
                to_char(pr.parsed_closed_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS pr_closed_at,
                COUNT(*) OVER ()::int AS total
             ${scope}
                 AND lower(s."severity") = 'critical'
                 AND (s."suggestionImplementationStatus" IS NULL
                      OR s."suggestionImplementationStatus" NOT ${IMPLEMENTED})
             ORDER BY pr.parsed_closed_at DESC
             LIMIT ${IGNORED_CRITICALS_MAX_ITEMS}`,
            params,
        )) as Array<{
            suggestion_id: string;
            repository: string | null;
            file_path: string | null;
            category: string | null;
            summary: string | null;
            pull_request_id: string;
            pr_number: number | null;
            pr_closed_at: string | null;
            total: number;
        }>;

        return {
            count: rows.length ? Number(rows[0].total) : 0,
            items: rows.map((r) => ({
                suggestionId: r.suggestion_id,
                repository: r.repository,
                filePath: r.file_path,
                category: r.category,
                summary: r.summary,
                pullRequestId: r.pull_request_id,
                prNumber: r.pr_number === null ? null : Number(r.pr_number),
                prClosedAt: r.pr_closed_at,
            })),
        };
    }

    async getRepositoriesHealth(
        q: CockpitRangeQuery,
    ): Promise<RepositoryHealthRow[]> {
        const params: unknown[] = [];
        const scope = this.closedPrScope(q, params);

        const rows = (await this.ds.query(
            `WITH per_category AS (
                SELECT
                    COALESCE(pr.repo_full_name, 'Unknown') AS repository,
                    COALESCE(s."label", 'Unknown') AS category,
                    COUNT(*)::int AS sent,
                    COUNT(*) FILTER (WHERE s."suggestionImplementationStatus" ${IMPLEMENTED})::int AS implemented
                ${scope}
                GROUP BY repository, category
            ),
            per_repo AS (
                SELECT repository,
                       SUM(sent)::int AS sent,
                       SUM(implemented)::int AS implemented
                  FROM per_category
                 GROUP BY repository
            ),
            -- distinct PRs cannot be derived from per_category; recount.
            repo_prs AS (
                SELECT COALESCE(pr.repo_full_name, 'Unknown') AS repository,
                       COUNT(DISTINCT s."pullRequestId")::int AS prs_reviewed,
                       COALESCE(SUM(f."thumbs_up"), 0)::int AS thumbs_up,
                       COALESCE(SUM(f."thumbs_down"), 0)::int AS thumbs_down
                  FROM "analytics"."suggestions_mv" s
                  JOIN "analytics"."pull_requests_opt" pr ON pr."_id" = s."pullRequestId"
                  LEFT JOIN "analytics"."suggestion_feedback" f
                         ON f."suggestion_id" = s."suggestion_id"
                 WHERE ${this.closedPrWhere(q, [])
                     /* placeholders $1..$N are shared with the other CTEs;
                        re-render with a throwaway array to avoid double-push */
                     .trim()}
                GROUP BY repository
            ),
            weakest AS (
                SELECT DISTINCT ON (repository)
                       repository, category, sent, implemented
                  FROM per_category
                 WHERE sent >= ${WEAKEST_CATEGORY_MIN_SENT}
                 ORDER BY repository,
                          (implemented::numeric / NULLIF(sent, 0)) ASC,
                          sent DESC
            )
            SELECT pr_agg.repository,
                   rp.prs_reviewed,
                   rp.thumbs_up,
                   rp.thumbs_down,
                   pr_agg.sent,
                   pr_agg.implemented,
                   w.category AS weakest_category,
                   w.sent AS weakest_sent,
                   w.implemented AS weakest_implemented
              FROM per_repo pr_agg
              JOIN repo_prs rp ON rp.repository = pr_agg.repository
              LEFT JOIN weakest w ON w.repository = pr_agg.repository
             ORDER BY pr_agg.sent DESC`,
            params,
        )) as Array<{
            repository: string;
            prs_reviewed: number;
            thumbs_up: number;
            thumbs_down: number;
            sent: number;
            implemented: number;
            weakest_category: string | null;
            weakest_sent: number | null;
            weakest_implemented: number | null;
        }>;

        return rows.map((r) => ({
            repository: r.repository,
            prsReviewed: Number(r.prs_reviewed),
            suggestionsSent: Number(r.sent),
            suggestionsImplemented: Number(r.implemented),
            implementationRate: this.rate(
                Number(r.sent),
                Number(r.implemented),
            ),
            thumbsUp: Number(r.thumbs_up),
            thumbsDown: Number(r.thumbs_down),
            weakestCategory: r.weakest_category
                ? {
                      category: r.weakest_category,
                      sent: Number(r.weakest_sent),
                      rate: this.rate(
                          Number(r.weakest_sent),
                          Number(r.weakest_implemented ?? 0),
                      ),
                  }
                : null,
        }));
    }

    /**
     * Shared WHERE for feedback-window queries (alias `f`). Unlike the
     * closed-PR scope, feedback aggregations bucket by when the reaction
     * was recorded — a 👎 this week on last month's suggestion belongs to
     * this week's chart.
     */
    private feedbackWhere(q: CockpitRangeQuery, params: unknown[]): string {
        params.push(q.organizationId, q.startDate, q.endDate);
        const repoFilter = q.repository
            ? (params.push(q.repository),
              `AND f.repo_full_name = $${params.length}`)
            : '';
        return `f."organizationId" = $1
                 AND f."feedback_created_at" BETWEEN $2::timestamptz AND $3::timestamptz
                 ${repoFilter}`;
    }

    async getNegativeFeedbackByCategory(
        q: CockpitRangeQuery,
    ): Promise<NegativeFeedbackByCategoryRow[]> {
        const params: unknown[] = [];
        const where = this.feedbackWhere(q, params);

        const rows = (await this.ds.query(
            `SELECT
                COALESCE(s."label", 'Unknown') AS category,
                SUM(f."thumbs_up")::int AS thumbs_up,
                SUM(f."thumbs_down")::int AS thumbs_down
             FROM "analytics"."suggestion_feedback" f
             LEFT JOIN "analytics"."suggestions_mv" s
                    ON s."suggestion_id" = f."suggestion_id"
            WHERE ${where}
            GROUP BY category
            ORDER BY thumbs_down DESC`,
            params,
        )) as Array<{
            category: string;
            thumbs_up: number;
            thumbs_down: number;
        }>;

        return rows.map((r) => ({
            category: r.category,
            thumbsUp: Number(r.thumbs_up),
            thumbsDown: Number(r.thumbs_down),
        }));
    }

    async getNegativeFeedbackWeekly(
        q: CockpitRangeQuery,
    ): Promise<NegativeFeedbackWeeklyRow[]> {
        const params: unknown[] = [];
        const where = this.feedbackWhere(q, params);

        const rows = (await this.ds.query(
            `SELECT
                to_char(date_trunc('week', f."feedback_created_at"), 'YYYY-MM-DD') AS week_start,
                SUM(f."thumbs_up")::int AS thumbs_up,
                SUM(f."thumbs_down")::int AS thumbs_down
             FROM "analytics"."suggestion_feedback" f
            WHERE ${where}
            GROUP BY date_trunc('week', f."feedback_created_at")
            ORDER BY date_trunc('week', f."feedback_created_at") ASC`,
            params,
        )) as Array<{
            week_start: string;
            thumbs_up: number;
            thumbs_down: number;
        }>;

        return rows.map((r) => ({
            weekStart: r.week_start,
            thumbsUp: Number(r.thumbs_up),
            thumbsDown: Number(r.thumbs_down),
        }));
    }

    async getNegativeVoteRateHighlight(
        q: CockpitRangeQuery,
    ): Promise<NegativeVoteRateHighlight> {
        const prev = computePreviousPeriod(q.startDate, q.endDate);

        const run = async (startDate: string, endDate: string) => {
            const params: unknown[] = [];
            const where = this.feedbackWhere(
                { ...q, startDate, endDate },
                params,
            );
            const rows = (await this.ds.query(
                `SELECT
                    COALESCE(SUM(f."thumbs_up"), 0)::int AS thumbs_up,
                    COALESCE(SUM(f."thumbs_down"), 0)::int AS thumbs_down
                 FROM "analytics"."suggestion_feedback" f
                WHERE ${where}`,
                params,
            )) as Array<{ thumbs_up: number; thumbs_down: number }>;
            const r = rows[0] ?? { thumbs_up: 0, thumbs_down: 0 };
            const up = Number(r.thumbs_up);
            const down = Number(r.thumbs_down);
            return {
                thumbsUp: up,
                thumbsDown: down,
                negativeRate: this.rate(up + down, down),
            };
        };

        const [current, previous] = await Promise.all([
            run(q.startDate, q.endDate),
            run(prev.startDate, prev.endDate),
        ]);

        const { percentageChange, trend } = computeTrend(
            current.negativeRate,
            previous.negativeRate,
            'down',
        );

        return {
            currentPeriod: current,
            previousPeriod: previous,
            comparison: { percentageChange, trend },
        };
    }

    /**
     * Per-rule usage from `suggestions_mv.brokenKodyRulesIds` (one
     * suggestion may enforce several rules — it counts once per rule).
     * Rule metadata (title, status, zero-trigger rules) lives in Mongo;
     * `GetKodyRulesHealthUseCase` does the merge.
     */
    async getKodyRulesUsage(
        q: CockpitRangeQuery,
    ): Promise<KodyRuleUsageRow[]> {
        const params: unknown[] = [];
        const scope = this.closedPrScope(q, params);

        const rows = (await this.ds.query(
            `WITH scoped AS (
                SELECT s."suggestion_id",
                       s."suggestionImplementationStatus",
                       s."suggestionCreatedAt",
                       s."brokenKodyRulesIds"
                ${scope}
                    AND s."brokenKodyRulesIds" IS NOT NULL
            )
            SELECT
                rule_id,
                COUNT(*)::int AS triggers,
                COUNT(*) FILTER (WHERE sc."suggestionImplementationStatus" ${IMPLEMENTED})::int AS implemented,
                COALESCE(SUM(f."thumbs_up"), 0)::int AS thumbs_up,
                COALESCE(SUM(f."thumbs_down"), 0)::int AS thumbs_down,
                to_char(MAX(sc."suggestionCreatedAt"), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_triggered_at
              FROM scoped sc
              LEFT JOIN "analytics"."suggestion_feedback" f
                     ON f."suggestion_id" = sc."suggestion_id"
             CROSS JOIN LATERAL unnest(sc."brokenKodyRulesIds") AS rule_id
             GROUP BY rule_id
             ORDER BY triggers DESC`,
            params,
        )) as Array<{
            rule_id: string;
            triggers: number;
            implemented: number;
            thumbs_up: number;
            thumbs_down: number;
            last_triggered_at: string | null;
        }>;

        return rows.map((r) => ({
            ruleId: r.rule_id,
            triggers: Number(r.triggers),
            implemented: Number(r.implemented),
            rate: this.rate(Number(r.triggers), Number(r.implemented)),
            thumbsUp: Number(r.thumbs_up),
            thumbsDown: Number(r.thumbs_down),
            lastTriggeredAt: r.last_triggered_at,
        }));
    }

    async searchSuggestions(
        q: SuggestionsExplorerQuery,
    ): Promise<SuggestionsExplorerResult> {
        const page = Math.max(1, Math.floor(q.page ?? 1));
        const pageSize = Math.min(
            EXPLORER_MAX_PAGE_SIZE,
            Math.max(1, Math.floor(q.pageSize ?? EXPLORER_DEFAULT_PAGE_SIZE)),
        );

        const params: unknown[] = [q.organizationId, q.startDate, q.endDate];
        const filters: string[] = [];

        if (q.repository) {
            params.push(q.repository);
            filters.push(`AND pr.repo_full_name = $${params.length}`);
        }
        if (q.category) {
            params.push(q.category);
            filters.push(`AND s."label" = $${params.length}`);
        }
        if (q.severity) {
            params.push(q.severity.toLowerCase());
            filters.push(`AND lower(s."severity") = $${params.length}`);
        }
        if (q.implementationStatus) {
            if (q.implementationStatus === 'not_implemented') {
                // Suggestions never evaluated land here too — for the user
                // both read as "the team did not act on this".
                filters.push(
                    `AND (s."suggestionImplementationStatus" IS NULL
                          OR s."suggestionImplementationStatus" NOT ${IMPLEMENTED})`,
                );
            } else {
                params.push(q.implementationStatus);
                filters.push(
                    `AND s."suggestionImplementationStatus" = $${params.length}`,
                );
            }
        }
        if (q.search) {
            params.push(`%${q.search.replace(/[%_\\]/g, '\\$&')}%`);
            filters.push(
                `AND (s."raw"->>'oneSentenceSummary' ILIKE $${params.length}
                      OR s."filePath" ILIKE $${params.length})`,
            );
        }

        params.push(pageSize, (page - 1) * pageSize);
        const limitIdx = params.length - 1;
        const offsetIdx = params.length;

        const rows = (await this.ds.query(
            `SELECT
                s."suggestion_id" AS suggestion_id,
                pr.repo_full_name AS repository,
                s."filePath" AS file_path,
                s."label" AS category,
                lower(s."severity") AS severity,
                s."suggestionImplementationStatus" AS implementation_status,
                s."raw"->>'oneSentenceSummary' AS summary,
                s."raw"->>'existingCode' AS existing_code,
                s."raw"->>'improvedCode' AS improved_code,
                s."raw"->>'language' AS language,
                s."pullRequestId" AS pull_request_id,
                pr."pr_number" AS pr_number,
                (s."raw"->'comment'->>'id')::bigint AS comment_id,
                to_char(s."suggestionCreatedAt", 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
                COUNT(*) OVER ()::int AS total
             FROM "analytics"."suggestions_mv" s
             JOIN "analytics"."pull_requests_opt" pr ON pr."_id" = s."pullRequestId"
             WHERE pr."organizationId" = $1
               AND s."suggestionDeliveryStatus" = 'sent'
               AND s."suggestionCreatedAt" BETWEEN $2::timestamptz AND $3::timestamptz
               ${filters.join('\n               ')}
             ORDER BY s."suggestionCreatedAt" DESC NULLS LAST, s."suggestion_id"
             LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
            params,
        )) as Array<{
            suggestion_id: string;
            repository: string | null;
            file_path: string | null;
            category: string | null;
            severity: string | null;
            implementation_status: string | null;
            summary: string | null;
            existing_code: string | null;
            improved_code: string | null;
            language: string | null;
            pull_request_id: string;
            pr_number: number | null;
            comment_id: string | number | null;
            created_at: string | null;
            total: number;
        }>;

        const items: SuggestionsExplorerItem[] = rows.map((r) => ({
            suggestionId: r.suggestion_id,
            repository: r.repository,
            filePath: r.file_path,
            category: r.category,
            severity: r.severity,
            implementationStatus: r.implementation_status,
            summary: r.summary,
            existingCode: r.existing_code,
            improvedCode: r.improved_code,
            language: r.language,
            pullRequestId: r.pull_request_id,
            prNumber: r.pr_number === null ? null : Number(r.pr_number),
            commentId: r.comment_id === null ? null : Number(r.comment_id),
            createdAt: r.created_at,
        }));

        return {
            total: rows.length ? Number(rows[0].total) : 0,
            page,
            pageSize,
            items,
        };
    }
}
