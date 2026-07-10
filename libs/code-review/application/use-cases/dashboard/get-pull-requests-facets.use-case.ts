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
import {
    intersectAssignedAndTeamScope,
    resolveTeamRepositoryIds,
} from './utils/team-repository-scope.util';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
    IAutomationExecutionService,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';

export interface PullRequestsFacets {
    // Distinct reviewed PRs (org/team + repo scope), all-time.
    all: number;
    // Open PRs that still carry an unaddressed delivered suggestion
    // (implementationStatus ≠ implemented).
    needsAttention: number;
    // Reviewed PRs whose review errored.
    errored: number;
    // Open PRs with no Kody review yet.
    awaiting: number;
    // Reviewed PRs authored by the current user (0 if identity can't be matched).
    mine: number;
}

@Injectable()
export class GetPullRequestsFacetsUseCase implements IUseCase {
    private readonly logger = createLogger(GetPullRequestsFacetsUseCase.name);

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

    async execute(query: { teamId?: string }): Promise<PullRequestsFacets> {
        const empty: PullRequestsFacets = {
            all: 0,
            needsAttention: 0,
            errored: 0,
            awaiting: 0,
            mine: 0,
        };

        const organizationId = this.request.user?.organization?.uuid;
        if (!organizationId) {
            return empty;
        }

        try {
            const assignedRepositoryIds =
                await this.authorizationService.getRepositoryScope({
                    user: this.request.user,
                    action: Action.Read,
                    resource: ResourceType.PullRequests,
                });

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

            // `all`/`errored` (getDistinctReviewedPullRequestKeys) are already
            // team-scoped by the `team.uuid = :teamId` join. The Mongo-backed
            // facets (needsAttention/mine/awaiting) only knew about org +
            // assigned repos, so on a multi-team org they counted PRs from
            // other teams — inconsistent with `all`. Resolve the selected
            // team's repositories and intersect with the caller's assigned
            // scope so every facet counts the same set of PRs.
            const teamRepositoryIds = await resolveTeamRepositoryIds(
                this.integrationConfigService,
                organizationAndTeamData,
                (error) =>
                    this.logger.warn({
                        message:
                            'Failed to resolve team repository scope for facets',
                        context: GetPullRequestsFacetsUseCase.name,
                        error: error as Error,
                        metadata: { organizationId, teamId: query.teamId },
                    }),
            );
            const repositoryIds = intersectAssignedAndTeamScope(
                assignedRepositoryIds,
                teamRepositoryIds,
            );

            // Empty (not undefined) → the team's repos and the assigned scope
            // don't overlap, so the caller can see none of this team's PRs.
            // Guard here because the Mongo helpers treat an empty array as
            // "no repository filter" (which would leak org-wide counts).
            if (Array.isArray(repositoryIds) && repositoryIds.length === 0) {
                return empty;
            }

            const email = this.request.user?.email;

            const [reviewedKeys, needsAttention, mine, openKeys] =
                await Promise.all([
                    this.automationExecutionService.getDistinctReviewedPullRequestKeys(
                        { organizationAndTeamData, repositoryIds },
                    ),
                    // Needs attention = open PRs that still carry an unaddressed
                    // delivered suggestion (any severity, implementationStatus ≠
                    // implemented). Actionable "someone needs to look at this",
                    // not "ever delivered a crit/high" (which counted merged/
                    // resolved PRs too).
                    this.pullRequestsService.countDeliveredPullRequests(
                        organizationId,
                        repositoryIds,
                        { unresolvedOnly: true, openOnly: true },
                    ),
                    email
                        ? this.pullRequestsService.countDeliveredPullRequests(
                              organizationId,
                              repositoryIds,
                              { authorEmail: email },
                          )
                        : Promise.resolve(0),
                    // Epoch cutoff → all open PRs (not just today).
                    this.pullRequestsService.findOpenPullRequestKeysOpenedSince(
                        '1970-01-01T00:00:00.000Z',
                        organizationId,
                        repositoryIds,
                    ),
                ]);

            const reviewedSet = new Set(
                reviewedKeys.map(
                    (k) => `${k.repositoryId}_${k.pullRequestNumber}`,
                ),
            );
            const errored = reviewedKeys.filter((k) => k.hasError).length;
            const awaiting = openKeys.filter(
                (k) => !reviewedSet.has(`${k.repositoryId}_${k.number}`),
            ).length;

            return {
                all: reviewedKeys.length,
                needsAttention,
                errored,
                awaiting,
                mine,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error building pull requests facets',
                context: GetPullRequestsFacetsUseCase.name,
                error,
                metadata: { organizationId },
            });
            return empty;
        }
    }
}
