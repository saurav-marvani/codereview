import {
    ITokenUsageRepository,
    TOKEN_USAGE_REPOSITORY_TOKEN,
} from '@libs/analytics/domain/token-usage/contracts/tokenUsage.repository.contract';
import { ITokenUsageService } from '@libs/analytics/domain/token-usage/contracts/tokenUsage.service.contract';
import {
    BaseUsageContract,
    DailyUsageByPrResultContract,
    DailyUsageResultContract,
    TokenUsageQueryContract,
    UsageByAreaResultContract,
    UsageByPrResultContract,
    UsageByReviewResultContract,
    UsageSummaryContract,
} from '@libs/analytics/domain/token-usage/types/tokenUsage.types';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class TokenUsageService implements ITokenUsageService {
    constructor(
        @Inject(TOKEN_USAGE_REPOSITORY_TOKEN)
        private readonly repository: ITokenUsageRepository,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,
    ) {}

    /**
     * Usage spans carry no repository id, so a repository filter resolves to
     * the repo's PR numbers here (single choke point for every read path)
     * and the Mongo match scopes `attributes.prNumber` with them. A repo
     * with no PRs yields an empty list, which matches nothing — correct.
     */
    private async withRepositoryScope(
        query: TokenUsageQueryContract,
    ): Promise<TokenUsageQueryContract> {
        if (!query.repositoryId || query.prNumbers) return query;
        const prNumbers =
            await this.pullRequestsService.findNumbersByRepositoryId(
                query.organizationId,
                query.repositoryId,
                query.end,
            );
        return { ...query, prNumbers };
    }

    async getSummary(
        query: TokenUsageQueryContract,
    ): Promise<UsageSummaryContract> {
        return this.repository.getSummary(await this.withRepositoryScope(query));
    }

    async getSummaryByModel(
        query: TokenUsageQueryContract,
    ): Promise<BaseUsageContract[]> {
        return this.repository.getSummaryByModel(await this.withRepositoryScope(query));
    }

    async getDailyUsage(
        query: TokenUsageQueryContract,
    ): Promise<DailyUsageResultContract[]> {
        return this.repository.getDailyUsage(await this.withRepositoryScope(query));
    }

    async getUsageByPr(
        query: TokenUsageQueryContract,
    ): Promise<UsageByPrResultContract[]> {
        return this.repository.getUsageByPr(await this.withRepositoryScope(query));
    }

    async getDailyUsageByPr(
        query: TokenUsageQueryContract,
    ): Promise<DailyUsageByPrResultContract[]> {
        return this.repository.getDailyUsageByPr(await this.withRepositoryScope(query));
    }

    async getUsageByReview(
        query: TokenUsageQueryContract,
    ): Promise<UsageByReviewResultContract[]> {
        return this.repository.getUsageByReview(await this.withRepositoryScope(query));
    }

    async getUsageByArea(
        query: TokenUsageQueryContract,
    ): Promise<UsageByAreaResultContract[]> {
        return this.repository.getUsageByArea(await this.withRepositoryScope(query));
    }

    async getUsageOverview(query: TokenUsageQueryContract) {
        return this.repository.getUsageOverview(
            await this.withRepositoryScope(query),
        );
    }
}
