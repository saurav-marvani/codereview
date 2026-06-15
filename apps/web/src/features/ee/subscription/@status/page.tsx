import { authorizedFetch } from "@services/fetch";
import { SETUP_PATHS } from "@services/setup";
import type { TeamMembersResponse } from "@services/setup/types";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";

import { getOrganizationMembers } from "../_services/billing/fetch";
import { Redirect } from "./_components";

export default async function SubscriptionStatus() {
    const teamId = await getGlobalSelectedTeamId();
    const [{ members }, organizationMembers] = await Promise.all([
        authorizedFetch<TeamMembersResponse>(SETUP_PATHS.TEAM_MEMBERS, {
            params: { teamId },
        }),
        getOrganizationMembers({ teamId }).catch(() => []),
    ]);

    return (
        <Redirect
            members={members}
            codeHostMembersCount={
                Array.isArray(organizationMembers)
                    ? organizationMembers.length
                    : undefined
            }
        />
    );
}
