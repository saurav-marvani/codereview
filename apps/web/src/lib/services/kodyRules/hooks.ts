import { useMemo } from "react";
import {
    useFetch,
    useSuspenseFetch,
    useSuspenseFetchMany,
} from "src/core/utils/reactQuery";
import { useSubscriptionStatus } from "src/features/ee/subscription/_hooks/use-subscription-status";

import {
    resolveRepoCount,
    type KodyRuleRepositoryCount,
} from "src/core/utils/kody-rules/repo-count";

import { KODY_RULES_PATHS } from ".";
import {
    type KodyRule,
    type KodyRulesType,
    type KodyRuleWithInheritanceDetails,
    type LibraryRule,
} from "./types";

export const useSuspenseFindLibraryKodyRules = () => {
    const rules = useSuspenseFetch<Record<string, Array<LibraryRule>>>(
        KODY_RULES_PATHS.FIND_LIBRARY_KODY_RULES,
    );

    return Object.values(rules).flat();
};

export const useSuspenseKodyRulesTotalQuantity = () => {
    return useSuspenseFetch<{ total: number }>(
        KODY_RULES_PATHS.GET_KODY_RULES_TOTAL_QUANTITY,
    ).total;
};

export const useKodyRulesLimits = () => {
    const subscription = useSubscriptionStatus();
    const total = useSuspenseKodyRulesTotalQuantity();

    if (!subscription.valid)
        return {
            total,
            canAddMoreRules: false,
            limit: Number.POSITIVE_INFINITY,
        };

    if (subscription.status === "free" || subscription.status === "self-hosted")
        return { canAddMoreRules: total < 10, total, limit: 10 };

    if (subscription.status === "licensed-self-hosted")
        return {
            canAddMoreRules: true,
            total,
            limit: Number.POSITIVE_INFINITY,
        };

    return { canAddMoreRules: true, total, limit: Number.POSITIVE_INFINITY };
};

export const useSuspenseKodyRulesByRepositoryId = (
    repositoryId: string,
    directoryId?: string,
    type?: KodyRulesType,
) => {
    return useSuspenseFetch<Array<KodyRule>>(
        KODY_RULES_PATHS.FIND_BY_ORGANIZATION_ID_AND_FILTER,
        { params: { repositoryId, directoryId, type } },
    );
};

export const useSuspenseAllOrganizationKodyRules = (type?: KodyRulesType) => {
    return useSuspenseFetch<Array<KodyRule>>(
        KODY_RULES_PATHS.FIND_BY_ORGANIZATION_ID_AND_FILTER,
        type !== undefined ? { params: { type } } : undefined,
    );
};

export const useSuspenseGetPendingIDERules = (params: {
    teamId: string;
    repositoryId?: string;
}) => {
    return useSuspenseFetch<Array<KodyRule>>(
        KODY_RULES_PATHS.PENDING_IDE_RULES,
        { params },
        { fallbackData: [] },
    );
};

export const useSuspenseKodyRulesCheckSyncStatus = (params: {
    teamId: string;
    repositoryId: string;
}) => {
    return useSuspenseFetch<{
        ideRulesSyncEnabledFirstTime: boolean;
        kodyRulesGeneratorEnabledFirstTime: boolean;
    }>(KODY_RULES_PATHS.CHECK_SYNC_STATUS, { params });
};

export const useSuspenseGetInheritedKodyRules = (params: {
    teamId: string;
    repositoryId: string;
    directoryId?: string;
}) => {
    return useSuspenseFetch<{
        globalRules: KodyRuleWithInheritanceDetails[];
        repoRules: KodyRuleWithInheritanceDetails[];
        directoryRules: KodyRuleWithInheritanceDetails[];
    }>(KODY_RULES_PATHS.GET_INHERITED_RULES, { params });
};

type InheritedKodyRules = {
    globalRules: KodyRuleWithInheritanceDetails[];
    repoRules: KodyRuleWithInheritanceDetails[];
    directoryRules: KodyRuleWithInheritanceDetails[];
};

/**
 * Loads the two heavy data sets the Kody Rules page needs — the scope's own
 * rules and the inherited rules — IN PARALLEL.
 *
 * Calling `useSuspenseKodyRulesByRepositoryId` and
 * `useSuspenseGetInheritedKodyRules` back-to-back waterfalls: the component
 * suspends on the first, so the inherited request only starts once the scope
 * request resolves. This fires both at once (wall-clock = slowest of the two).
 * The query keys match the single-fetch hooks, so the cache is shared.
 */
export const useSuspenseKodyRulesPageData = (params: {
    teamId: string;
    repositoryId: string;
    directoryId?: string;
}) => {
    const { teamId, repositoryId, directoryId } = params;

    const [scopeRules, inherited] = useSuspenseFetchMany<
        [Array<KodyRule>, InheritedKodyRules]
    >([
        {
            url: KODY_RULES_PATHS.FIND_BY_ORGANIZATION_ID_AND_FILTER,
            params: { params: { repositoryId, directoryId } },
        },
        {
            url: KODY_RULES_PATHS.GET_INHERITED_RULES,
            params: { params: { teamId, repositoryId, directoryId } },
        },
    ]);

    return { scopeRules, inherited };
};

export const useKodyRulesCount = (
    repositoryId: string,
    directoryId?: string,
    enabled = true,
) => {
    // One shared aggregated request for the whole org. The query key carries
    // no per-repo params, so every repository/directory count badge on the
    // settings page de-dupes to a SINGLE request via the React Query cache.
    // Previously each card fetched its repo's full rules array (and ran
    // context-reference enrichment server-side) just to read a length — N
    // heavy requests for N cards. The backend returns ACTIVE+PAUSED counts,
    // matching the pool the user sees in the list.
    const { data } = useFetch<Array<KodyRuleRepositoryCount>>(
        KODY_RULES_PATHS.COUNTS_BY_REPOSITORY,
        undefined,
        enabled,
        { staleTime: 60_000 },
    );

    return useMemo(
        () => resolveRepoCount(data, repositoryId, directoryId),
        [data, repositoryId, directoryId],
    );
};
