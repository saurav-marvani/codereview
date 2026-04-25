import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { IOrganization } from '@libs/organization/domain/organization/interfaces/organization.interface';
import { ITeam } from '@libs/organization/domain/team/interfaces/team.interface';
import { IPostHog, PostHog } from 'posthog-node';

export const FEATURE_FLAGS = {
    tokenUsagePage: 'token-usage-page',
    kodyRuleSuggestions: 'kody-rules-suggestions',
    codeReviewDryRun: 'code-review-dry-run',
    businessLogic: 'business-logic',
    documentationContext: 'documentation-context',
    sso: 'sso',
    cliKeys: 'cli-keys',
    committableSuggestions: 'committable-suggestions',
    agentReview: 'agent-review',
    cockpitInternalSource: 'cockpit-internal-source',
} as const;

export type FeatureFlagKey = (typeof FEATURE_FLAGS)[keyof typeof FEATURE_FLAGS];

class PostHogClient {
    private readonly posthog: IPostHog | null = null;

    constructor() {
        const apiKey = process.env.API_POSTHOG_KEY;

        if (apiKey) {
            this.posthog = new PostHog(apiKey, {
                host: 'https://us.i.posthog.com',
            });
        } else {
            this.posthog = null;
        }
    }

    get isInitialized(): boolean {
        return this.posthog !== null;
    }

    userIdentify(user: IUser): void {
        if (!this.posthog) {
            return;
        }

        const properties: any = {
            email: user.email,
            id: user.uuid,
        };

        if (user.organization) {
            properties.organizationId = user.organization.uuid;
            properties.organizationName = user.organization.name;
        }

        this.posthog.identify({
            distinctId: user.uuid,
            properties,
        });

        this.posthog.capture({
            distinctId: user.uuid,
            event: 'user_added_to_organization',
            properties,
            groups: {
                organization: user.organization?.uuid,
            },
        });
    }

    organizationIdentify(organization: IOrganization): void {
        if (!this.posthog) {
            return;
        }

        this.posthog.groupIdentify({
            groupType: 'organization',
            groupKey: organization.uuid,
            properties: {
                name: organization.name,
                tenantName: organization.tenantName,
                id: organization.uuid,
            },
        });
    }

    teamIdentify(team: ITeam): void {
        if (!this.posthog) {
            return;
        }

        const properties: any = {
            name: team.name,
            id: team.uuid,
        };

        if (team.organization) {
            properties.organizationId = team.organization.uuid;
            properties.organizationName = team.organization.name;
        }

        this.posthog.groupIdentify({
            groupType: 'team',
            groupKey: team.uuid,
            properties,
        });
    }

    repositoryIdentify(repository: {
        repositoryId: string;
        name: string;
        fullName: string;
        platform: string;
        organizationId: string;
        agentReviewEnabled?: boolean;
    }): void {
        if (!this.posthog) {
            return;
        }

        this.posthog.groupIdentify({
            groupType: 'repository',
            groupKey: repository.repositoryId,
            properties: {
                name: repository.name,
                fullName: repository.fullName,
                platform: repository.platform,
                organizationId: repository.organizationId,
                repositoryId: repository.repositoryId,
                agentReviewEnabled: repository.agentReviewEnabled ?? false,
            },
        });
    }

    async isFeatureEnabled(
        featureName: string,
        identifier: string,
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId?: string,
    ): Promise<boolean> {
        if (!this.posthog) {
            return Promise.resolve(true);
        }

        const groups: Record<string, string> = {
            organization: organizationAndTeamData.organizationId,
        };

        if (repositoryId) {
            groups.repository = repositoryId;
        }

        return await this.posthog.isFeatureEnabled(featureName, identifier, {
            groups,
        });
    }
}

export default new PostHogClient();
