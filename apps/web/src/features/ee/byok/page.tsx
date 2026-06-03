import {
    getBYOK,
    getLLMConfigStatus,
} from "@services/organizationParameters/fetch";
import { getGlobalSelectedTeamId } from "src/core/utils/get-global-selected-team-id";

import { ByokPageClient } from "./_components/page.client";

export default async function ByokPage() {
    const [byokConfig, llmConfigStatus, teamId] = await Promise.all([
        getBYOK().catch(() => null),
        getLLMConfigStatus().catch(() => null),
        getGlobalSelectedTeamId().catch(() => undefined),
    ]);

    return (
        <ByokPageClient
            config={byokConfig}
            llmConfigStatus={llmConfigStatus}
            teamId={teamId ?? undefined}
        />
    );
}
