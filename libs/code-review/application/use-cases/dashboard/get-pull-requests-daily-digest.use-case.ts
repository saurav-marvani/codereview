import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
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
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';

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

// Upper bound on today's executions scanned for the digest. A single org is very
// unlikely to exceed this in a day; if it does, the counts undercount (logged).
const MAX_TODAY_EXECUTIONS = 2000;

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

            const repositoryIds = assignedRepositoryIds ?? undefined;
            const organizationAndTeamData: OrganizationAndTeamData = {
                organizationId,
                teamId: query.teamId,
            };

            // 1. Today's executions → distinct reviewed PRs + errored PRs.
            const { data: executions } =
                await this.automationExecutionService.findPullRequestExecutionsByOrganizationAndTeam(
                    {
                        organizationAndTeamData,
                        repositoryIds,
                        createdAtFrom: date,
                        take: MAX_TODAY_EXECUTIONS,
                        order: 'DESC',
                        includeTotal: false,
                    },
                );

            if (executions.length >= MAX_TODAY_EXECUTIONS) {
                this.logger.warn({
                    message:
                        'Daily digest hit the today-executions scan cap; counts may undercount',
                    context: GetPullRequestsDailyDigestUseCase.name,
                    metadata: { organizationId, cap: MAX_TODAY_EXECUTIONS },
                });
            }

            const reviewedKeys = new Set<string>();
            const erroredKeys = new Set<string>();
            const reviewedCriteria: Array<{
                number: number;
                repositoryId: string;
            }> = [];

            for (const execution of executions) {
                if (
                    execution.pullRequestNumber == null ||
                    execution.repositoryId == null
                ) {
                    continue;
                }

                const key = `${execution.repositoryId}_${execution.pullRequestNumber}`;
                if (!reviewedKeys.has(key)) {
                    reviewedKeys.add(key);
                    reviewedCriteria.push({
                        number: execution.pullRequestNumber,
                        repositoryId: execution.repositoryId,
                    });
                }

                if (
                    execution.status === AutomationStatus.ERROR ||
                    execution.status === AutomationStatus.PARTIAL_ERROR
                ) {
                    erroredKeys.add(key);
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
                erroredToday: erroredKeys.size,
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
