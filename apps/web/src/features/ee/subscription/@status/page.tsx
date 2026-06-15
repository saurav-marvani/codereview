import { authorizedFetch } from "@services/fetch";
import { SETUP_PATHS } from "@services/setup";
import type { TeamMembersResponse } from "@services/setup/types";
import { auth } from "src/core/config/auth";
import { publicDomainsSet } from "src/core/utils/email";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";

import {
    getOrganizationMembers,
    recalculateTrialUnlocks,
} from "../_services/billing/fetch";
import { Redirect } from "./_components";

const hasCompanyEmail = (email?: string | null) => {
    const domain = email?.split("@")[1]?.toLowerCase();

    return Boolean(domain && !publicDomainsSet.has(domain));
};

export default async function SubscriptionStatus() {
    const teamId = await getGlobalSelectedTeamId();
    const [session, { members }, organizationMembers] = await Promise.all([
        auth(),
        authorizedFetch<TeamMembersResponse>(SETUP_PATHS.TEAM_MEMBERS, {
            params: { teamId },
        }),
        getOrganizationMembers({ teamId }).catch(() => []),
    ]);

    const codeHostMembersCount = Array.isArray(organizationMembers)
        ? organizationMembers.length
        : undefined;
    const recalculatedLicense = await recalculateTrialUnlocks({
        teamId,
        signals: {
            companyEmailVerified: hasCompanyEmail(session?.user?.email),
            workspaceMembersCount: members.length,
            codeHostMembersCount,
        },
    }).catch(() => undefined);
    const trialLicense =
        recalculatedLicense?.valid &&
        recalculatedLicense.subscriptionStatus === "trial"
            ? recalculatedLicense
            : undefined;

    return (
        <Redirect
            members={members}
            codeHostMembersCount={codeHostMembersCount}
            trialLicense={trialLicense}
        />
    );
}
