import { AbilityBuilder, createMongoAbility, Subject } from '@casl/ability';
import {
    IPermissionsService,
    PERMISSIONS_SERVICE_TOKEN,
} from '@libs/identity/domain/permissions/contracts/permissions.service.contract';
import {
    Action,
    ResourceType,
    Role,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AppAbility } from '@libs/identity/domain/permissions/types/permissions.types';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class PermissionsAbilityFactory {
    constructor(
        @Inject(PERMISSIONS_SERVICE_TOKEN)
        private readonly permissionsService: IPermissionsService,
    ) {}

    async createForUser(
        user: IUser,
        repositoryIds?: string[],
    ): Promise<AppAbility> {
        const { can, cannot, build } = new AbilityBuilder(createMongoAbility);

        const userRole = user.role;
        const userOrganizationId = user.organization?.uuid;

        if (!userRole || !userOrganizationId) {
            cannot(Action.Manage, ResourceType.All);

            return build() as AppAbility;
        }

        let assignedRepoUuids: string[] = [];
        if (repositoryIds) {
            assignedRepoUuids = repositoryIds;
        } else {
            const permissionsEntity = await this.permissionsService.findOne({
                user: { uuid: user.uuid },
            });
            assignedRepoUuids =
                permissionsEntity?.permissions?.assignedRepositoryIds || [];
        }

        const canInOrg = <S extends Subject, C>(
            action: Action,
            subject: S,
            conditions?: C,
        ) => {
            const finalConditions = {
                ...conditions,
                organizationId: userOrganizationId,
            };
            can(action, subject, finalConditions);
        };

        const canInRepo = <S extends Subject, C>(
            action: Action,
            subject: S,
            conditions?: C,
            global?: boolean,
        ) => {
            const repos = [...assignedRepoUuids];
            if (global) repos.push('global');

            const finalConditions = {
                ...conditions,
                organizationId: userOrganizationId,
                repoId: {
                    $in: repos,
                },
            };

            can(action, subject, finalConditions);
        };

        switch (userRole) {
            case Role.OWNER:
                canInOrg(Action.Manage, ResourceType.All);
                break;

            case Role.REPO_ADMIN:
                canInRepo(
                    Action.Read,
                    ResourceType.CodeReviewSettings,
                    {},
                    true,
                );
                canInRepo(Action.Update, ResourceType.CodeReviewSettings);
                canInRepo(Action.Create, ResourceType.CodeReviewSettings);

                canInOrg(Action.Read, ResourceType.KodyRules);
                canInRepo(Action.Update, ResourceType.KodyRules);
                canInRepo(Action.Create, ResourceType.KodyRules);
                canInRepo(Action.Delete, ResourceType.KodyRules);

                canInRepo(Action.Read, ResourceType.Cockpit, {}, true);
                canInOrg(Action.Update, ResourceType.Cockpit);

                canInOrg(Action.Read, ResourceType.Issues);
                canInRepo(Action.Update, ResourceType.Issues);
                canInRepo(Action.Create, ResourceType.Issues);

                canInOrg(Action.Read, ResourceType.IssuesSettings);
                canInOrg(Action.Update, ResourceType.IssuesSettings);
                canInOrg(Action.Create, ResourceType.IssuesSettings);

                canInRepo(Action.Read, ResourceType.Logs, {}, true);

                canInRepo(Action.Read, ResourceType.PullRequests);

                canInOrg(Action.Read, ResourceType.GitSettings);

                canInOrg(Action.Read, ResourceType.PluginSettings);
                break;

            case Role.BILLING_MANAGER:
                canInOrg(Action.Read, ResourceType.CodeReviewSettings);
                canInOrg(Action.Read, ResourceType.KodyRules);

                canInOrg(Action.Manage, ResourceType.Billing);

                canInOrg(Action.Read, ResourceType.GitSettings);

                canInOrg(Action.Read, ResourceType.PluginSettings);

                canInOrg(Action.Read, ResourceType.UserSettings);

                canInOrg(Action.Read, ResourceType.IssuesSettings);

                canInOrg(Action.Read, ResourceType.Logs);
                break;

            case Role.CONTRIBUTOR:
                canInRepo(
                    Action.Read,
                    ResourceType.CodeReviewSettings,
                    {},
                    true,
                );

                canInOrg(Action.Read, ResourceType.KodyRules);

                canInRepo(Action.Read, ResourceType.Issues);

                canInOrg(Action.Read, ResourceType.IssuesSettings);
                break;

            default:
                cannot(Action.Manage, ResourceType.All);
                break;
        }

        return build() as AppAbility;
    }
}
