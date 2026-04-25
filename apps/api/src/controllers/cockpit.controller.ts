import {
    BadRequestException,
    Controller,
    ForbiddenException,
    Get,
    Param,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
    BackfillOrchestratorService,
    PullRequestIngestionService,
} from '@libs/analytics-warehouse';
import {
    CockpitCodeHealthService,
    CockpitDeveloperProductivityService,
    CockpitHealthService,
    CockpitRangeQuery,
    CockpitSourceResolver,
    CockpitValidationService,
} from '@libs/cockpit';
import { CockpitTierGuard } from '@libs/cockpit/infrastructure/guards/cockpit-tier.guard';
import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';

/**
 * Path shape matches the legacy `kodus-service-analytics` Express routes:
 *
 *   /code-health/*     → CockpitCodeHealthController
 *   /productivity/*    → CockpitProductivityController
 *   /cockpit/*         → CockpitController (validate + ops)
 *
 * Response envelope: controllers return bare domain objects. The global
 * `TransformInterceptor` in apps/api wraps them as `{ data, statusCode, type }`
 * — the standard apps/api shape. Clients hitting the `internal` cockpit
 * source read `response.data`; when the feature flag falls back to
 * `legacy-bq`, they go through the old `{ status, data }` path.
 *
 * Auth: the global `JwtAuthGuard` applies here just like the rest of
 * apps/api. The legacy `x-api-key` model is intentionally dropped.
 */

function requireRange(q: CockpitRangeQuery): void {
    if (!q.organizationId || !q.startDate || !q.endDate) {
        throw new BadRequestException(
            'Missing required parameters: organizationId, startDate, endDate',
        );
    }
}

function parseOptionalPositiveInt(
    raw: string | undefined,
    field: string,
): number | undefined {
    if (raw === undefined || raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
        throw new BadRequestException(
            `${field} must be a positive integer (got "${raw}")`,
        );
    }
    return n;
}

function parseOptionalNonNegativeInt(
    raw: string | undefined,
    field: string,
): number | undefined {
    if (raw === undefined || raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
        throw new BadRequestException(
            `${field} must be a non-negative integer (got "${raw}")`,
        );
    }
    return n;
}

// -------------------------------------------------------------------------
// /cockpit/*  — validation + ops
// -------------------------------------------------------------------------

@ApiTags('Cockpit')
@ApiBearerAuth('jwt')
@UseGuards(CockpitTierGuard)
@Controller('cockpit')
export class CockpitController {
    constructor(
        private readonly healthService: CockpitHealthService,
        private readonly sourceResolver: CockpitSourceResolver,
        private readonly validationService: CockpitValidationService,
        private readonly ingestionService: PullRequestIngestionService,
        private readonly backfillOrchestrator: BackfillOrchestratorService,
    ) {}

    // Public so external monitoring (BetterStack, status pages, k8s
    // probes) can poll without provisioning a JWT. Returns no PII —
    // just connection state and aggregate counters.
    @Public()
    @Get('/health')
    @ApiOperation({ summary: 'Cockpit warehouse health' })
    async health() {
        return this.healthService.ping();
    }

    @Public()
    @Get('/health/runs')
    @ApiOperation({
        summary:
            'Last ingestion run + lag since last success + 24h failure / quarantine counters',
    })
    async runsHealth(@Query('source') source?: string) {
        return this.healthService.runsSummary(source || undefined);
    }

    /**
     * Operator/test trigger to force an ingestion pass without waiting
     * for the next cron tick. Gated by `API_ANALYTICS_ALLOW_TRIGGER` so
     * production stays locked down — staging and dev opt in by setting
     * the env var to `true`. Idempotent: a run that scans nothing just
     * heartbeats.
     */
    @Public()
    @Post('/admin/trigger-ingestion')
    @ApiOperation({ summary: 'Force an ingestion run (dev/staging only)' })
    async triggerIngestion(
        @Query('organizationId') organizationId?: string,
        @Query('since') since?: string,
        @Query('until') until?: string,
        @Query('max') max?: string,
    ) {
        if (process.env.API_ANALYTICS_ALLOW_TRIGGER !== 'true') {
            throw new ForbiddenException(
                'analytics trigger disabled — set API_ANALYTICS_ALLOW_TRIGGER=true',
            );
        }
        return this.ingestionService.run({
            organizationId,
            since: since ? new Date(since) : undefined,
            until: until ? new Date(until) : undefined,
            maxRows: max ? Number(max) : undefined,
        });
    }

    /**
     * Synchronous backfill driver. Replaces the standalone CLI for
     * dev/test contexts where bootstrapping a second Nest app trips on
     * mongoose-paginate plugin double-registration. Call with care: the
     * request blocks until the orchestrator finishes all windows.
     * Same env gate as `/admin/trigger-ingestion`.
     */
    @Public()
    @Post('/admin/backfill')
    @ApiOperation({ summary: 'Run chunked backfill (dev/staging only)' })
    async runBackfill(
        @Query('fresh') fresh?: string,
        @Query('from') from?: string,
        @Query('until') until?: string,
        @Query('stepDays') stepDays?: string,
        @Query('pauseMs') pauseMs?: string,
        @Query('batch') batch?: string,
        @Query('organizationId') organizationId?: string,
    ) {
        if (process.env.API_ANALYTICS_ALLOW_TRIGGER !== 'true') {
            throw new ForbiddenException(
                'analytics backfill disabled — set API_ANALYTICS_ALLOW_TRIGGER=true',
            );
        }
        // Validate numeric inputs before handing them to the
        // orchestrator. `stepDays <= 0` would loop forever because the
        // window cursor can't advance; `pauseMs < 0` and `batch <= 0`
        // would break the scanner in subtler ways.
        const stepDaysNum = parseOptionalPositiveInt(stepDays, 'stepDays');
        const pauseMsNum = parseOptionalNonNegativeInt(pauseMs, 'pauseMs');
        const batchNum = parseOptionalPositiveInt(batch, 'batch');
        return this.backfillOrchestrator.run({
            fresh: fresh === 'true',
            from,
            until,
            stepDays: stepDaysNum,
            pauseMs: pauseMsNum,
            batchSize: batchNum,
            organizationId,
        });
    }

    @Get('/source/:organizationId')
    @ApiOperation({ summary: 'Resolve cockpit data source per org' })
    async source(@Param('organizationId') organizationId: string) {
        const source = await this.sourceResolver.resolve(organizationId);
        return { organizationId, source };
    }

    @Get('/validate')
    @ApiOperation({ summary: 'Cockpit data validation (PR presence)' })
    async validate(@Query('organizationId') organizationId: string) {
        if (!organizationId) {
            throw new BadRequestException(
                'Missing required parameter: organizationId',
            );
        }
        return this.validationService.validate(organizationId);
    }
}

// -------------------------------------------------------------------------
// /code-health/*
// -------------------------------------------------------------------------

@ApiTags('Cockpit · Code Health')
@ApiBearerAuth('jwt')
@UseGuards(CockpitTierGuard)
@Controller('code-health')
export class CockpitCodeHealthController {
    constructor(private readonly codeHealth: CockpitCodeHealthService) {}

    @Get('/charts/suggestions-by-category')
    @ApiOperation({ summary: 'Suggestions grouped by category' })
    suggestionsByCategory(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.codeHealth.getSuggestionsByCategory(q);
    }

    @Get('/charts/suggestions-by-repository')
    @ApiOperation({ summary: 'Suggestions grouped by repository + category' })
    suggestionsByRepository(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.codeHealth.getSuggestionsByRepository(q);
    }

    @Get('/charts/bug-ratio')
    @ApiOperation({ summary: 'Weekly bug-fix ratio chart' })
    bugRatioChart(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.codeHealth.getBugRatioChart(q);
    }

    @Get('/highlights/bug-ratio')
    @ApiOperation({ summary: 'Bug ratio current vs previous period' })
    bugRatioHighlight(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.codeHealth.getBugRatioHighlight(q);
    }

    @Get('/highlights/suggestions-implementation-rate')
    @ApiOperation({ summary: 'Implementation rate for the last 2 weeks' })
    implementationRate(
        @Query('organizationId') organizationId: string,
        @Query('repository') repository?: string,
    ) {
        if (!organizationId) {
            throw new BadRequestException('Missing required parameters');
        }
        return this.codeHealth.getImplementationRate({
            organizationId,
            repository,
        });
    }
}

// -------------------------------------------------------------------------
// /productivity/*
// -------------------------------------------------------------------------

@ApiTags('Cockpit · Productivity')
@ApiBearerAuth('jwt')
@UseGuards(CockpitTierGuard)
@Controller('productivity')
export class CockpitProductivityController {
    constructor(
        private readonly productivity: CockpitDeveloperProductivityService,
    ) {}

    @Get('/charts/deploy-frequency')
    @ApiOperation({ summary: 'Weekly deploy frequency (closed PRs per week)' })
    deployFrequencyChart(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.productivity.getDeployFrequencyChart(q);
    }

    @Get('/highlights/deploy-frequency')
    @ApiOperation({ summary: 'Deploy frequency current vs previous period' })
    deployFrequencyHighlight(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.productivity.getDeployFrequencyHighlight(q);
    }

    @Get('/highlights/lead-time-for-change')
    @ApiOperation({ summary: 'Lead time p75 current vs previous period' })
    leadTimeHighlight(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.productivity.getLeadTimeHighlight(q);
    }

    @Get('/charts/lead-time-for-change')
    @ApiOperation({ summary: 'Weekly lead time p75 chart' })
    leadTimeChart(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.productivity.getLeadTimeChart(q);
    }

    @Get('/highlights/pr-size')
    @ApiOperation({ summary: 'PR size current vs previous period' })
    prSizeHighlight(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.productivity.getPullRequestSizeHighlight(q);
    }

    @Get('/charts/pr-size')
    @ApiOperation({ summary: 'Weekly average PR size chart' })
    prSizeChart(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.productivity.getPullRequestSizeChart(q);
    }

    @Get('/charts/pull-requests-by-developer')
    @ApiOperation({ summary: 'Pull requests per developer per week' })
    pullRequestsByDeveloper(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.productivity.getPullRequestsByDev(q);
    }

    @Get('/charts/pull-requests-opened-vs-closed')
    @ApiOperation({ summary: 'Opened vs closed PRs per week' })
    pullRequestsOpenedVsClosed(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.productivity.getPullRequestsOpenedVsClosed(q);
    }

    @Get('/charts/lead-time-breakdown')
    @ApiOperation({ summary: 'Lead time broken down into coding/pickup/review' })
    leadTimeBreakdown(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.productivity.getLeadTimeBreakdown(q);
    }

    @Get('/charts/developer-activity')
    @ApiOperation({ summary: 'Per-developer, per-day PR activity' })
    developerActivity(@Query() q: CockpitRangeQuery) {
        requireRange(q);
        return this.productivity.getDeveloperActivity(q);
    }

    @Get('/dashboard/company')
    @ApiOperation({
        summary: 'Company dashboard (use ?complete=true for derived highlights)',
    })
    companyDashboard(
        @Query() q: CockpitRangeQuery,
        @Query('complete') complete?: string,
    ) {
        requireRange(q);
        return complete === 'true'
            ? this.productivity.getCompanyDashboardInsights(q)
            : this.productivity.getCompanyDashboard(q);
    }
}
