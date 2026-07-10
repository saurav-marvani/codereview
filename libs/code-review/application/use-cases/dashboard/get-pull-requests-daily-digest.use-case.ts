import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    intersectAssignedAndTeamScope,
    resolveTeamRepositoryIds,
} from './utils/team-repository-scope.util';

export interface PullRequestsDailyDigest {
    // ISO start-of-day (UTC) the digest is scoped to.
    date: string;
    // Distinct PRs that had a Kody review today.
    reviewedToday: number;
    // Of today's reviewed PRs, how many delivered at least one critical/high.
    needsAttention: number;
    // Distinct PRs whose review errored (error / partial_error) today.
    erroredToday: number;
    // PRs opened today, still open, with no Kody review yet.
    awaitingReview: number;
}

@Injectable()
export class GetPullRequestsDailyDigestUseCase implements IUseCase {
    private readonly logger = createLogger(
        GetPullRequestsDailyDigestUseCase.name,
    );

    constructor(
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(REQUEST)
        private readonly request: UserRequest,
        private readonly authorizationService: AuthorizationService,
    ) {}

    async execute(query: {
        teamId?: string;
    }): Promise<PullRequestsDailyDigest> {
        const organizationId = this.request.user?.organization?.uuid;
        if (!organizationId) {
            throw new Error('No organization found in request');
        }

        const { date, empty } = this.buildScope();

        try {
            const assignedRepositoryIds =
                await this.authorizationService.getRepositoryScope({
                    user: this.request.user,
                    action: Action.Read,
                    resource: ResourceType.PullRequests,
                });

            // No repositories in scope → nothing to report.
            if (
                assignedRepositoryIds !== null &&
                assignedRepositoryIds.length === 0
            ) {
                return empty;
            }

            const organizationAndTeamData: OrganizationAndTeamData = {
                organizationId,
                teamId: query.teamId,
            };

            // Team-scope every count the same way (see the facets use-case):
            // resolve the team's repositories and intersect with the caller's
            // assigned scope so reviewed/errored (Postgres) and awaiting (Mongo)
            // all count the same set of PRs.
            const teamRepositoryIds = await resolveTeamRepositoryIds(
                this.integrationConfigService,
                organizationAndTeamData,
                (error) =>
                    this.logger.warn({
                        message:
                            'Failed to resolve team repository scope for daily digest',
                        context: GetPullRequestsDailyDigestUseCase.name,
                        error: error as Error,
                        metadata: { organizationId, teamId: query.teamId },
                    }),
            );
            const repositoryIds = intersectAssignedAndTeamScope(
                assignedRepositoryIds,
                teamRepositoryIds,
            );

            // Empty (not undefined) → team repos and assigned scope don't
            // overlap → the caller sees none of this team's PRs. Guard here
            // because the Mongo helpers treat an empty array as "no filter".
            if (Array.isArray(repositoryIds) && repositoryIds.length === 0) {
                return empty;
            }

            // 1. Today's distinct reviewed PRs + which of them errored, counted
            //    DB-side (DISTINCT PR + bool_or on error status) scoped to
            //    today. Replaces the old "scan up to N executions and dedup in
            //    memory" approach — no cap, no unbounded in-memory load.
            const reviewedKeyRows =
                await this.automationExecutionService.getDistinctReviewedPullRequestKeys(
                    {
                        organizationAndTeamData,
                        repositoryIds,
                        createdAtFrom: date,
                    },
                );

            const reviewedKeys = new Set<string>();
            const reviewedCriteria: Array<{
                number: number;
                repositoryId: string;
            }> = [];
            let erroredToday = 0;

            for (const row of reviewedKeyRows) {
                reviewedKeys.add(
                    `${row.repositoryId}_${row.pullRequestNumber}`,
                );
                reviewedCriteria.push({
                    number: row.pullRequestNumber,
                    repositoryId: row.repositoryId,
                });
                if (row.hasError) {
                    erroredToday++;
                }
            }

            // 2. Needs attention: today's reviewed PRs with a delivered
            //    critical/high suggestion.
            let needsAttention = 0;
            if (reviewedCriteria.length) {
                const counts =
                    await this.pullRequestsService.findSuggestionCountsByNumbersAndRepositoryIds(
                        reviewedCriteria,
                        organizationId,
                    );

                for (const value of counts.values()) {
                    const bySeverity = value.bySeverity;
                    if (
                        bySeverity &&
                        bySeverity.critical + bySeverity.high > 0
                    ) {
                        needsAttention++;
                    }
                }
            }

            // 3. Awaiting review: PRs opened today, still open, not yet reviewed.
            const openedKeys =
                await this.pullRequestsService.findOpenPullRequestKeysOpenedSince(
                    date,
                    organizationId,
                    repositoryIds,
                );

            let awaitingReview = 0;
            for (const key of openedKeys) {
                if (!reviewedKeys.has(`${key.repositoryId}_${key.number}`)) {
                    awaitingReview++;
                }
            }

            return {
                date,
                reviewedToday: reviewedKeys.size,
                needsAttention,
                erroredToday,
                awaitingReview,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error building pull requests daily digest',
                context: GetPullRequestsDailyDigestUseCase.name,
                error,
                metadata: { organizationId },
            });
            throw error;
        }
    }

    private buildScope(): { date: string; empty: PullRequestsDailyDigest } {
        const now = new Date();
        const todayStart = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
        );
        const date = todayStart.toISOString();

        return {
            date,
            empty: {
                date,
                reviewedToday: 0,
                needsAttention: 0,
                erroredToday: 0,
                awaitingReview: 0,
            },
        };
    }
}
