import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * Thin client over the existing Kodus API (same origin, Auth.js cookie).
 * TODO(migration): point at the real endpoints used by apps/web
 * (parameters/code-review config). Stubbed with realistic shapes so the
 * vertical is fully navigable before wiring.
 */
export type CodeReviewGeneralConfig = {
    automatedReview: boolean;
    reviewCadence: "automatic" | "every_push" | "manual";
    runOnDraft: boolean;
    approveOnClean: boolean;
    requestChangesOnCritical: boolean;
};

export type RepositoryScope = { id: string; name: string };

const STUB_CONFIG: CodeReviewGeneralConfig = {
    automatedReview: true,
    reviewCadence: "automatic",
    runOnDraft: true,
    approveOnClean: false,
    requestChangesOnCritical: false,
};

const STUB_REPOSITORIES: RepositoryScope[] = [
    { id: "kodus-ai", name: "kodus-ai" },
    { id: "kodus-installer", name: "kodus-installer" },
];

export function useCodeReviewRepositories() {
    return useQuery<RepositoryScope[]>({
        queryKey: ["code-review", "repositories"],
        queryFn: async () => STUB_REPOSITORIES,
    });
}

export function useCodeReviewGeneralConfig(scope: string) {
    return useQuery<CodeReviewGeneralConfig>({
        queryKey: ["code-review", "config", scope],
        queryFn: async () => STUB_CONFIG,
    });
}

export function useSaveCodeReviewGeneralConfig(scope: string) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (config: CodeReviewGeneralConfig) => {
            // TODO(migration): PATCH the parameters endpoint.
            await new Promise((resolve) => setTimeout(resolve, 600));
            return config;
        },
        onSuccess: (config) => {
            queryClient.setQueryData(
                ["code-review", "config", scope],
                config,
            );
        },
    });
}
