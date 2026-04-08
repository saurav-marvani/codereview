import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import { GenerateKodyRulesDTO } from '@libs/core/domain/dtos/generate-kody-rules.dto';

import { CommentAnalysisService } from '@libs/code-review/infrastructure/adapters/services/commentAnalysis.service';
import { generateDateFilter } from '@libs/common/utils/transforms/date';
import { IntegrationConfigKey, ParametersKey } from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    CreateKodyRuleDto,
    KodyRuleSeverity,
} from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrations/contracts/integration.service.contracts';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { ParametersEntity } from '@libs/organization/domain/parameters/entities/parameters.entity';
import { KodyLearningStatus } from '@libs/organization/domain/parameters/types/configValue.type';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { ModuleRef } from '@nestjs/core';
import { CreateOrUpdateKodyRulesUseCase } from './create-or-update.use-case';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from './find-rules-in-organization-by-filter.use-case';
import { SendRulesNotificationUseCase } from './send-rules-notification.use-case';
import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';

@Injectable()
export class GenerateKodyRulesUseCase {
    private readonly logger = createLogger(GenerateKodyRulesUseCase.name);
    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,
        private readonly codeManagementService: CodeManagementService,
        private readonly commentAnalysisService: CommentAnalysisService,
        private readonly moduleRef: ModuleRef,
        private readonly sendRulesNotificationUseCase: SendRulesNotificationUseCase,
    ) {}

    async execute(body: GenerateKodyRulesDTO, organizationId: string) {
        let platformConfig: ParametersEntity<ParametersKey.PLATFORM_CONFIGS>;
        let organizationAndTeamData: OrganizationAndTeamData;

        try {
            const { teamId, months, weeks, days, repositoriesIds = [] } = body;

            organizationAndTeamData = {
                organizationId,
                teamId,
            };

            const dateFilter = generateDateFilter({ months, weeks, days });

            const repositories = await this.getRepositories(
                organizationAndTeamData,
            );

            if (!repositories || repositories.length === 0) {
                this.logger.log({
                    message: 'No repositories found',
                    context: GenerateKodyRulesUseCase.name,
                    metadata: { body, organizationAndTeamData },
                });
                return [];
            }

            const filteredRepositories =
                repositoriesIds.length > 0
                    ? repositories.filter((repo) =>
                          repositoriesIds.includes(repo.id),
                      )
                    : repositories;

            if (!filteredRepositories || filteredRepositories.length === 0) {
                this.logger.log({
                    message: 'No repositories found after filtering',
                    context: GenerateKodyRulesUseCase.name,
                    metadata: { body, organizationAndTeamData },
                });
                return [];
            }

            const findRulesUseCase = await this.moduleRef.resolve(
                FindRulesInOrganizationByRuleFilterKodyRulesUseCase,
                undefined,
                { strict: false },
            );

            const existingRules = await findRulesUseCase.execute(
                organizationId,
                {},
            );

            platformConfig = await this.parametersService.findByKey(
                ParametersKey.PLATFORM_CONFIGS,
                organizationAndTeamData,
            );

            if (!platformConfig || !platformConfig.configValue) {
                throw new Error('Platform config not found');
            }

            await this.createOrUpdateParametersUseCase.execute(
                ParametersKey.PLATFORM_CONFIGS,
                {
                    ...platformConfig.configValue,
                    kodyLearningStatus: KodyLearningStatus.GENERATING_RULES,
                },
                organizationAndTeamData,
            );

            const allRules = [];
            const createdRules = []; // To track created rules for notification

            for (const repository of filteredRepositories) {
                const pullRequests =
                    await this.codeManagementService.getPullRequestsByRepository(
                        {
                            organizationAndTeamData,
                            repository,
                            filters: {
                                ...dateFilter,
                            },
                        },
                    );

                if (!pullRequests || pullRequests.length === 0) {
                    this.logger.log({
                        message: 'No pull requests found',
                        context: GenerateKodyRulesUseCase.name,
                        metadata: {
                            dateFilter,
                            repositoryId: repository
                                ? repository.id
                                : 'repository not found',
                        },
                    });
                    continue;
                }

                const comments = [];

                for (const pr of pullRequests) {
                    const generalComments =
                        await this.codeManagementService.getAllCommentsInPullRequest(
                            {
                                organizationAndTeamData,
                                repository,
                                prNumber: pr.pull_number,
                            },
                        );

                    const reviewComments =
                        await this.codeManagementService.getPullRequestReviewComment(
                            {
                                organizationAndTeamData,
                                filters: {
                                    repository,
                                    pullRequestNumber: pr.pull_number,
                                },
                            },
                        );

                    const files =
                        await this.codeManagementService.getFilesByPullRequestId(
                            {
                                organizationAndTeamData,
                                repository,
                                prNumber: pr.pull_number,
                            },
                        );

                    comments.push({
                        pr,
                        generalComments,
                        reviewComments,
                        files,
                    });
                }

                if (!comments || comments.length === 0) {
                    this.logger.log({
                        message: 'No comments found',
                        context: GenerateKodyRulesUseCase.name,
                        metadata: {
                            repositoryId: repository
                                ? repository.id
                                : 'repository not found',
                        },
                    });
                    continue;
                }

                const processedComments =
                    this.commentAnalysisService.processComments(comments);

                if (!processedComments || processedComments.length === 0) {
                    continue;
                }

                const rules =
                    await this.commentAnalysisService.generateKodyRules({
                        comments: processedComments,
                        existingRules,
                        organizationAndTeamData,
                    });

                if (!rules || rules.length === 0) {
                    this.logger.log({
                        message: 'No rules generated',
                        context: GenerateKodyRulesUseCase.name,
                        metadata: {
                            repositoryId: repository
                                ? repository.id
                                : 'repository not found',
                        },
                    });
                    continue;
                }

                for (const rule of rules) {
                    const dto: CreateKodyRuleDto = {
                        examples: rule.examples,
                        origin: rule.origin,
                        rule: rule.rule,
                        title: rule.title,
                        repositoryId: repository.id,
                        path: '',
                        status: KodyRulesStatus.PENDING,
                        severity: rule.severity as KodyRuleSeverity,
                    };

                    const userInfo = {
                        userId: 'kody-system-rules-generator',
                        userEmail: 'kody@kodus.io',
                    };

                    const createOrUpdateUseCase = await this.moduleRef.resolve(
                        CreateOrUpdateKodyRulesUseCase,
                        undefined,
                        { strict: false },
                    );

                    await createOrUpdateUseCase.execute(
                        dto,
                        organizationId,
                        userInfo,
                    );

                    // Add rule to notification data
                    createdRules.push({
                        title: rule.title,
                        rule: rule.rule,
                        severity: rule.severity,
                    });

                    this.logger.log({
                        message: 'Rule generated and saved successfully',
                        context: GenerateKodyRulesUseCase.name,
                        metadata: { rule },
                    });
                }

                allRules.push(rules);
            }

            await this.createOrUpdateParametersUseCase.execute(
                ParametersKey.PLATFORM_CONFIGS,
                {
                    ...platformConfig.configValue,
                    kodyLearningStatus: KodyLearningStatus.ENABLED,
                },
                organizationAndTeamData,
            );

            if (allRules.length === 0) {
                this.logger.log({
                    message: 'No rules generated',
                    context: GenerateKodyRulesUseCase.name,
                    metadata: { body, organizationAndTeamData },
                });

                return [];
            }

            this.logger.log({
                message: 'Kody rules generated successfully',
                context: GenerateKodyRulesUseCase.name,
                metadata: { body, organizationAndTeamData },
            });

            // Send email notification if rules were created
            if (createdRules.length > 0) {
                this.logger.log({
                    message: 'Sending email notification for new Kody rules',
                    context: GenerateKodyRulesUseCase.name,
                    metadata: {
                        organizationId,
                        rulesCount: createdRules.length,
                    },
                });

                // Execute notification asynchronously to not block the main flow
                this.sendRulesNotificationUseCase
                    .execute(organizationId, createdRules)
                    .catch((error) => {
                        this.logger.error({
                            message:
                                'Error sending email notification for Kody rules',
                            context: GenerateKodyRulesUseCase.name,
                            error,
                            metadata: {
                                organizationId,
                                rulesCount: createdRules.length,
                            },
                        });
                    });
            }

            return allRules.flat();
        } catch (error) {
            this.logger.error({
                message: 'Error generating kody rules',
                context: GenerateKodyRulesUseCase.name,
                error,
                metadata: body,
            });

            if (platformConfig) {
                await this.createOrUpdateParametersUseCase.execute(
                    ParametersKey.PLATFORM_CONFIGS,
                    {
                        ...platformConfig.configValue,
                        kodyLearningStatus: KodyLearningStatus.ENABLED,
                    },
                    organizationAndTeamData ?? { teamId: body.teamId },
                );
            }

            throw error;
        }
    }

    private async getRepositories(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const codeReviewConfig = await this.parametersService.findByKey(
            ParametersKey.CODE_REVIEW_CONFIG,
            organizationAndTeamData,
        );

        if (!codeReviewConfig || !codeReviewConfig.configValue)
            return this.getRepositoriesIntegration(organizationAndTeamData);

        return codeReviewConfig.configValue.repositories.filter(
            (repo) => repo.isSelected === true,
        );
    }

    private async getRepositoriesIntegration(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const integration = await this.integrationService.findOne({
            organization: { uuid: organizationAndTeamData.organizationId },
            team: { uuid: organizationAndTeamData.teamId },
        });

        if (!integration) {
            throw new Error('Integration not found');
        }

        const integrationConfig = await this.integrationConfigService.findOne({
            integration: { uuid: integration?.uuid },
            team: { uuid: organizationAndTeamData.teamId },
            configKey: IntegrationConfigKey.REPOSITORIES,
        });

        if (!integrationConfig) {
            throw new Error('Integration config not found');
        }

        return integrationConfig.configValue as Repositories[];
    }
}
