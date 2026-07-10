import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { IIntegrationConfigService } from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';

// Repository ids configured for the selected team (via the REPOSITORIES
// integration config, which is team-scoped). Returns `undefined` — never an
// empty array — when there is no teamId or the config can't be resolved, so
// callers cleanly fall back to the assigned scope instead of misreading
// "unresolved" as "team has zero repos". A config-fetch failure degrades to
// `undefined` (fall back) rather than breaking the whole dashboard segment.
export async function resolveTeamRepositoryIds(
    integrationConfigService: IIntegrationConfigService,
    organizationAndTeamData: OrganizationAndTeamData,
    onError?: (error: unknown) => void,
): Promise<string[] | undefined> {
    if (!organizationAndTeamData.teamId) {
        return undefined;
    }

    try {
        const repositories =
            await integrationConfigService.findIntegrationConfigFormatted<
                Repositories[]
            >(IntegrationConfigKey.REPOSITORIES, organizationAndTeamData);

        if (!repositories?.length) {
            return undefined;
        }

        const ids = Array.from(
            new Set(
                repositories
                    .map((repo) =>
                        repo?.id != null ? String(repo.id) : undefined,
                    )
                    .filter((id): id is string => Boolean(id)),
            ),
        );

        return ids.length ? ids : undefined;
    } catch (error) {
        onError?.(error);
        return undefined;
    }
}

// Combine the caller's assigned repository scope (null = unrestricted) with the
// team's repositories into the single scope every dashboard segment should
// count against:
//   - both present            → intersection (team ∩ assigned)
//   - only team               → team
//   - only assigned           → assigned
//   - neither                 → undefined (org-wide)
// An empty array is a meaningful result (team and assigned scopes don't
// overlap → caller sees none of the team's PRs); callers must guard it because
// the Mongo helpers treat an empty array as "no repository filter" (org-wide).
export function intersectAssignedAndTeamScope(
    assignedRepositoryIds: string[] | null,
    teamRepositoryIds: string[] | undefined,
): string[] | undefined {
    if (assignedRepositoryIds != null && teamRepositoryIds != null) {
        return teamRepositoryIds.filter((id) =>
            assignedRepositoryIds.includes(id),
        );
    }

    return teamRepositoryIds ?? assignedRepositoryIds ?? undefined;
}
