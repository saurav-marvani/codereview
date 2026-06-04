import { useSuspenseGetConnections } from "@services/setup/hooks";
import { useCodeReviewRouteParams } from "src/app/(app)/settings/_hooks";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";
import { PlatformType } from "src/core/types";
import { safeArray } from "src/core/utils/safe-array";

/**
 * Returns the platform type(s) of the active CODE_MANAGEMENT connections
 * for the current team. Returns a Set for O(1) lookups.
 */
function useCodeManagementPlatforms(): Set<string> {
    const { teamId } = useSelectedTeamId();
    const connections = useSuspenseGetConnections(teamId);

    return new Set(
        safeArray(connections)
            .filter(
                (c) => c.category === "CODE_MANAGEMENT" && c.hasConnection,
            )
            .map((c) => c.platformName),
    );
}

/**
 * Returns true when the "Request Changes" review-status toggle should be
 * hidden.  GitLab does not support this feature; global settings are
 * always shown (they apply to all platforms).
 */
export function useShouldHideRequestChanges(): boolean {
    const { repositoryId } = useCodeReviewRouteParams();
    if (repositoryId === "global") return false;
    return useCodeManagementPlatforms().has(PlatformType.GITLAB);
}

/**
 * Returns true when the "Post as hidden comment" toggle should be hidden.
 * Only GitHub supports hidden/minimized comments; global settings are
 * always shown.
 */
export function useShouldHideHiddenComments(): boolean {
    const { repositoryId } = useCodeReviewRouteParams();
    if (repositoryId === "global") return false;
    return !useCodeManagementPlatforms().has(PlatformType.GITHUB);
}

/**
 * Returns true when the "Enable LLM Prompt" toggle should be hidden.
 * Bitbucket does not support this feature; global settings are always
 * shown.
 */
export function useShouldHideLLMPrompt(): boolean {
    const { repositoryId } = useCodeReviewRouteParams();
    if (repositoryId === "global") return false;
    return useCodeManagementPlatforms().has(PlatformType.BITBUCKET);
}
