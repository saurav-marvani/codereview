import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, resolveTeamId } from "@/lib/api";

/**
 * Real parameters endpoints (same ones apps/web uses):
 * - GET  /parameters/find-by-key?teamId&key=CODE_REVIEW_CONFIG
 * - POST /parameters/create-or-update-code-review
 * The CODE_REVIEW_CONFIG value is { configs, repositories } — this page
 * only edits the "general" subset; saves merge over the full config so
 * untouched fields survive.
 */
export type ReviewCadence = {
    type: "automatic" | "manual" | "auto_pause";
    timeWindow?: number;
    pushesToTrigger?: number;
};

export type CodeReviewConfig = {
    automatedReviewActive?: boolean;
    reviewCadence?: ReviewCadence;
    runOnDraft?: boolean;
    pullRequestApprovalActive?: boolean;
    isRequestChangesActive?: boolean;
    showStatusFeedback?: boolean;
    [key: string]: unknown;
};

export type RepositoryScope = {
    id: string;
    name: string;
    isSelected: boolean;
    configs?: CodeReviewConfig;
};

export type CodeReviewParameter = {
    uuid: string;
    configKey: string;
    configValue: {
        configs: CodeReviewConfig;
        repositories: RepositoryScope[];
    };
};

export function useTeamId() {
    return useQuery({
        queryKey: ["team-id"],
        queryFn: resolveTeamId,
        staleTime: Infinity,
    });
}

export function useCodeReviewParameter() {
    const { data: teamId } = useTeamId();

    return useQuery({
        queryKey: ["code-review-parameter", teamId],
        enabled: !!teamId,
        queryFn: () =>
            api.get<CodeReviewParameter>("/parameters/find-by-key", {
                teamId: teamId!,
                key: "CODE_REVIEW_CONFIG",
            }),
    });
}

/** Repos that opted into code review — the sidebar scope tree. */
export function useCodeReviewRepositories() {
    const parameter = useCodeReviewParameter();

    return {
        ...parameter,
        data: parameter.data?.configValue.repositories.filter(
            (repository) => repository.isSelected,
        ),
    };
}

/** Scope-aware view of the config: global or a repository override. */
export function useCodeReviewConfig(scope: string) {
    const parameter = useCodeReviewParameter();

    const config =
        scope === "global"
            ? parameter.data?.configValue.configs
            : (parameter.data?.configValue.repositories.find(
                  (repository) => repository.id === scope,
              )?.configs ?? parameter.data?.configValue.configs);

    return { ...parameter, config };
}

export type GeneralSettings = {
    automatedReviewActive: boolean;
    reviewCadenceType: ReviewCadence["type"];
    runOnDraft: boolean;
    pullRequestApprovalActive: boolean;
    isRequestChangesActive: boolean;
};

export function toGeneralSettings(
    config: CodeReviewConfig | undefined,
): GeneralSettings | undefined {
    if (!config) return undefined;

    return {
        automatedReviewActive: config.automatedReviewActive ?? false,
        reviewCadenceType: config.reviewCadence?.type ?? "automatic",
        runOnDraft: config.runOnDraft ?? false,
        pullRequestApprovalActive:
            config.pullRequestApprovalActive ?? false,
        isRequestChangesActive: config.isRequestChangesActive ?? false,
    };
}

export function useSaveGeneralSettings(scope: string) {
    const queryClient = useQueryClient();
    const { data: teamId } = useTeamId();
    const { config } = useCodeReviewConfig(scope);

    return useMutation({
        mutationFn: async (settings: GeneralSettings) => {
            const configValue: CodeReviewConfig = {
                ...config,
                automatedReviewActive: settings.automatedReviewActive,
                reviewCadence: {
                    ...config?.reviewCadence,
                    type: settings.reviewCadenceType,
                },
                runOnDraft: settings.runOnDraft,
                pullRequestApprovalActive:
                    settings.pullRequestApprovalActive,
                isRequestChangesActive: settings.isRequestChangesActive,
            };

            return api.post("/parameters/create-or-update-code-review", {
                configValue,
                organizationAndTeamData: { teamId },
                repositoryId: scope === "global" ? undefined : scope,
            });
        },
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: ["code-review-parameter"],
            });
        },
    });
}
