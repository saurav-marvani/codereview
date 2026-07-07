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
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';

export interface AwaitingPullRequest {
    prId: string;
    prNumber: number;
    title: string;
    url: string;
    repositoryName: string;
    repositoryId: string;
    author: { username: string; name?: string };
    openedAt: string;
}

// Cap on the awaiting list — this is a "needs attention" nudge, not an archive.
const MAX_AWAITING = 100;

@Injectable()
export class GetAwaitingPullRequestsUseCase implements IUseCase {
    private readonly logger = createLogger(GetAwaitingPullRequestsUseCase.name);

    constructor(
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,

        @Inject(REQUEST)
        private readonly request: UserRequest,
        private readonly authorizationService: AuthorizationService,
    ) {}

    async execute(query: { teamId?: string }): Promise<AwaitingPullRequest[]> {
        const organizationId = this.request.user?.organization?.uuid;
        if (!organizationId) {
            return [];
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
                return [];
            }

            const repositoryIds = assignedRepositoryIds ?? undefined;
            const organizationAndTeamData: OrganizationAndTeamData = {
                organizationId,
                teamId: query.teamId,
            };

            const [openKeys, reviewedKeys] = await Promise.all([
                this.pullRequestsService.findOpenPullRequestKeysOpenedSince(
                    '1970-01-01T00:00:00.000Z',
                    organizationId,
                    repositoryIds,
                ),
                this.automationExecutionService.getDistinctReviewedPullRequestKeys(
                    { organizationAndTeamData, repositoryIds },
                ),
            ]);

            const reviewedSet = new Set(
                reviewedKeys.map(
                    (k) => `${k.repositoryId}_${k.pullRequestNumber}`,
                ),
            );
            const awaitingCriteria = openKeys
                .filter(
                    (k) => !reviewedSet.has(`${k.repositoryId}_${k.number}`),
                )
                .slice(0, MAX_AWAITING)
                .map((k) => ({
                    number: k.number,
                    repositoryId: k.repositoryId,
                }));

            if (!awaitingCriteria.length) {
                return [];
            }

            const prs =
                (await this.pullRequestsService.findManyByNumbersAndRepositoryIds(
                    awaitingCriteria,
                    organizationId,
                )) ?? [];

            return prs
                .filter((pr) => pr?.number != null && pr?.repository?.id)
                .map((pr) => ({
                    prId: pr.uuid!,
                    prNumber: pr.number,
                    title: pr.title,
                    url: pr.url,
                    repositoryName: pr.repository.name,
                    repositoryId: pr.repository.id,
                    author: {
                        username: pr.user?.username ?? '',
                        name: pr.user?.name,
                    },
                    openedAt: pr.openedAt,
                }))
                .sort((a, b) => (a.openedAt < b.openedAt ? 1 : -1));
        } catch (error) {
            this.logger.error({
                message: 'Error listing awaiting pull requests',
                context: GetAwaitingPullRequestsUseCase.name,
                error,
                metadata: { organizationId },
            });
            return [];
        }
    }
}
