import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import { Repository } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { PullRequestsEntity } from '../entities/pullRequests.entity';
import { DeliveryStatus } from '../enums/deliveryStatus.enum';
import {
    IPullRequests,
    IFile,
    ISuggestion,
    IPullRequestWithDeliveredSuggestions,
    IPullRequestUserMapping,
} from '../interfaces/pullRequests.interface';

export const PULL_REQUESTS_REPOSITORY_TOKEN = Symbol.for(
    'PullRequestsRepository',
);

export interface IPeriodFilter {
    startDate: Date;
    endDate: Date;
    dateType: 'created' | 'updated';
}

export interface IPullRequestsRepository {
    getNativeCollection(): any;

    create(
        suggestion: Omit<IPullRequests, 'uuid'>,
    ): Promise<PullRequestsEntity>;

    findById(uuid: string): Promise<PullRequestsEntity | null>;
    findOne(
        filter?: Partial<IPullRequests>,
    ): Promise<PullRequestsEntity | null>;
    find(filter?: Partial<IPullRequests>): Promise<PullRequestsEntity[]>;
    findPRNumbersByTitleAndOrganization(
        title: string,
        organizationId: string,
        repositoryIds?: string[],
    ): Promise<Array<{ number: number; repositoryId: string }>>;
    findByNumberAndRepositoryName(
        prNumber: number,
        repositoryName: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null>;
    findByNumberAndRepositoryId(
        prNumber: number,
        repositoryId: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null>;
    findByNumberAndRepositoryIdOptimized(
        prNumber: number,
        repositoryId: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null>;
    findManyByNumbersAndRepositoryIds(
        criteria: Array<{
            number: number;
            repositoryId: string;
        }>,
        organizationId: string,
    ): Promise<PullRequestsEntity[]>;

    /**
     * PERF: Batch fetch PRs by organization and PR numbers only.
     * Used for token usage by developer queries where repositoryId is not available.
     * Returns only fields needed for developer mapping (number, user, organizationId).
     */
    findManyByNumbers(
        prNumbers: number[],
        organizationId: string,
    ): Promise<IPullRequestUserMapping[]>;

    /**
     * PERF: Aggregation query that returns only suggestion counts.
     * Reduces data transfer from ~180k objects to just counts per PR.
     *
     * @returns Map keyed by `${repositoryId}_${prNumber}` with counts
     */
    findSuggestionCountsByNumbersAndRepositoryIds(
        criteria: Array<{
            number: number;
            repositoryId: string;
        }>,
        organizationId: string,
    ): Promise<Map<string, { sent: number; filtered: number }>>;
    findFileWithSuggestions(
        prnumber: number,
        repositoryName: string,
        filePath: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IFile | null>;
    findSuggestionsByPRAndFilename(
        prNumber: number,
        repoFullName: string,
        filename: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<ISuggestion[]>;
    findSuggestionsByPR(
        organizationId: string,
        prNumber: number,
        deliveryStatus: DeliveryStatus,
    ): Promise<ISuggestion[]>;
    findSuggestionsByRuleId(
        ruleId: string,
        organizationId: string,
    ): Promise<ISuggestion[]>;
    findPullRequestsWithDeliveredSuggestions(
        organizationId: string,
        prNumbers: number[],
        status: string | string[],
    ): Promise<IPullRequestWithDeliveredSuggestions[]>;
    findByOrganizationAndRepositoryWithStatusAndSyncedFlag(
        organizationId: string,
        repository: Pick<Repository, 'id' | 'fullName'>,
        status?: PullRequestState,
        syncedEmbeddedSuggestions?: boolean,
    ): Promise<IPullRequests[]>;
    findByOrganizationAndRepositoryWithStatusAndSyncedWithIssuesFlag(
        organizationId: string,
        repository: Pick<Repository, 'id' | 'fullName'>,
        status?: PullRequestState,
        syncedEmbeddedSuggestions?: boolean,
    ): Promise<IPullRequests[]>;

    addFileToPullRequest(
        pullRequestNumber: number,
        repositoryName: string,
        newFile: Omit<IFile, 'id'>,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null>;
    addSuggestionToFile(
        fileId: string,
        newSuggestion: Omit<ISuggestion, 'id'>,
        pullRequestNumber: number,
        repositoryName: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null>;
    findRecentByRepositoryId(
        organizationId: string,
        repositoryId: string,
        limit?: number,
    ): Promise<PullRequestsEntity[]>;

    update(
        pullRequest: PullRequestsEntity,
        updateData: Partial<IPullRequests>,
    ): Promise<PullRequestsEntity | null>;
    updateFile(
        fileId: string,
        updateData: Partial<IFile>,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null>;
    updateSuggestion(
        suggestionId: string,
        updateData: Partial<ISuggestion>,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<PullRequestsEntity | null>;
    updateSyncedSuggestionsFlag(
        pullRequestNumbers: number[],
        repositoryId: string,
        organizationId: string,
        synced: boolean,
    ): Promise<void>;
    updateSyncedWithIssuesFlag(
        prNumber: number,
        repositoryId: string,
        organizationId: string,
        synced: boolean,
    ): Promise<void>;
}
