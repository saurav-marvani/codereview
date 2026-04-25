import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

export const IDE_RULES_SYNC_DISABLED_EVENT = 'ide-rules-sync.disabled';

export interface IdeRulesSyncDisabledEvent {
    organizationAndTeamData: OrganizationAndTeamData;
    repositoryId: string;
}
