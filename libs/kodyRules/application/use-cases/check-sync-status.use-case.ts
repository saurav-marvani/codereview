import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import {
    ICodeRepository,
    CodeReviewParameter,
    RepositoryCodeReviewConfig,
} from '@libs/core/infrastructure/config/types/general/codeReviewConfig.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { KodyLearningStatus } from '@libs/organization/domain/parameters/types/configValue.type';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from './find-rules-in-organization-by-filter.use-case';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import {
    IKodyRule,
    KodyRulesOrigin,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

@Injectable()
export class CheckSyncStatusUseCase {
    private readonly logger = createLogger(CheckSyncStatusUseCase.name);
    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly findRulesInOrganizationByRuleFilterKodyRulesUseCase: FindRulesInOrganizationByRuleFilterKodyRulesUseCase,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(
        teamId: string,
        repositoryId?: string,
    ): Promise<{
        ideRulesSyncEnabledFirstTime: boolean;
        kodyRulesGeneratorEnabledFirstTime: boolean;
    }> {
        const syncStatusFlags = {
            ideRulesSyncEnabledFirstTime: true,
            kodyRulesGeneratorEnabledFirstTime: true,
        };

        const organizationAndTeamData = {
            organizationId: this.request.user.organization.uuid,
            teamId: teamId,
        };

        const platformConfig = await this.parametersService.findByKey(
            ParametersKey.PLATFORM_CONFIGS,
            organizationAndTeamData,
        );

        try {
            const codeReviewConfigs: CodeReviewParameter =
                await this.getCodeReviewConfigs(organizationAndTeamData);

            const currentRepositoryConfig = codeReviewConfigs.repositories.find(
                (repository: RepositoryCodeReviewConfig) =>
                    repository.id === repositoryId,
            ) as RepositoryCodeReviewConfig;

            // Se não encontrou o repositório, retorna configuração padrão
            if (!currentRepositoryConfig) {
                return syncStatusFlags;
            }

            const ideRulesSyncEnabled =
                currentRepositoryConfig.configs.ideRulesSyncEnabled;

            if (!ideRulesSyncEnabled) {
                const rules =
                    await this.findRulesInOrganizationByRuleFilterKodyRulesUseCase.execute(
                        organizationAndTeamData.organizationId,
                        {},
                        repositoryId,
                    );

                const ideRules = rules?.find((rule) =>
                    rule?.rules?.find((r: IKodyRule) => r.sourcePath),
                );

                syncStatusFlags.ideRulesSyncEnabledFirstTime = !ideRules;
            }

            if (
                platformConfig.configValue.kodyLearningStatus ===
                KodyLearningStatus.DISABLED
            ) {
                syncStatusFlags.kodyRulesGeneratorEnabledFirstTime = false;
            } else {
                // "First time" means no rule has ever been generated from past
                // reviews for this repo/org. The old code returned the current
                // toggle value, which is always false the instant the user
                // re-enables it — so the off→on cycle never fired the modal.
                // The settings toggle stays as the manual re-trigger. execute()
                // returns a flat list already filtered by the predicate, so any
                // result means a past-review rule exists.
                const rules =
                    await this.findRulesInOrganizationByRuleFilterKodyRulesUseCase.execute(
                        organizationAndTeamData.organizationId,
                        { origin: KodyRulesOrigin.PAST_REVIEWS },
                        repositoryId,
                    );

                syncStatusFlags.kodyRulesGeneratorEnabledFirstTime = !rules?.length;
            }

            return syncStatusFlags;
        } catch (error) {
            this.logger.error({
                message: 'Error checking sync status',
                error,
                context: CheckSyncStatusUseCase.name,
                metadata: {
                    organizationId: this.request.user.organization.uuid,
                    teamId,
                    repositoryId,
                },
            });

            return syncStatusFlags;
        }
    }

    private async getCodeReviewConfigs(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<CodeReviewParameter> {
        const codeReviewConfig = await this.parametersService.findByKey(
            ParametersKey.CODE_REVIEW_CONFIG,
            organizationAndTeamData,
        );

        return codeReviewConfig?.configValue;
    }

    private async getFormattedRepositories(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        return await this.integrationConfigService.findIntegrationConfigFormatted<
            ICodeRepository[]
        >(IntegrationConfigKey.REPOSITORIES, organizationAndTeamData);
    }
}
