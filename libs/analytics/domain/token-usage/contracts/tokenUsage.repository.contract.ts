import {
    BaseUsageContract,
    TokenUsageQueryContract,
    DailyUsageResultContract,
    UsageSummaryContract,
    DailyUsageByPrResultContract,
    UsageByPrResultContract,
} from '../types/tokenUsage.types';

export const TOKEN_USAGE_REPOSITORY_TOKEN = Symbol.for('TokenUsageRepository');

export interface ITokenUsageRepository {
    getSummary(query: TokenUsageQueryContract): Promise<UsageSummaryContract>;

    getSummaryByModel(
        query: TokenUsageQueryContract,
    ): Promise<BaseUsageContract[]>;

    getDailyUsage(
        query: TokenUsageQueryContract,
    ): Promise<DailyUsageResultContract[]>;

    getUsageByPr(
        query: TokenUsageQueryContract,
    ): Promise<UsageByPrResultContract[]>;

    getDailyUsageByPr(
        query: TokenUsageQueryContract,
    ): Promise<DailyUsageByPrResultContract[]>;
}
