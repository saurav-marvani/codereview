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
    UsageByPrResultContract,
    UsageSummaryContract,
} from '@libs/analytics/domain/token-usage/types/tokenUsage.types';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class TokenUsageService implements ITokenUsageService {
    constructor(
        @Inject(TOKEN_USAGE_REPOSITORY_TOKEN)
        private readonly repository: ITokenUsageRepository,
    ) {}

    async getSummary(
        query: TokenUsageQueryContract,
    ): Promise<UsageSummaryContract> {
        return this.repository.getSummary(query);
    }

    async getSummaryByModel(
        query: TokenUsageQueryContract,
    ): Promise<BaseUsageContract[]> {
        return this.repository.getSummaryByModel(query);
    }

    async getDailyUsage(
        query: TokenUsageQueryContract,
    ): Promise<DailyUsageResultContract[]> {
        return this.repository.getDailyUsage(query);
    }

    async getUsageByPr(
        query: TokenUsageQueryContract,
    ): Promise<UsageByPrResultContract[]> {
        return this.repository.getUsageByPr(query);
    }

    async getDailyUsageByPr(
        query: TokenUsageQueryContract,
    ): Promise<DailyUsageByPrResultContract[]> {
        return this.repository.getDailyUsageByPr(query);
    }
}
