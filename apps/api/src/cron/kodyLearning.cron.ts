import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { deepMerge } from '@libs/common/utils/deep';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { GenerateKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/generate-kody-rules.use-case';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { KodyLearningStatus } from '@libs/organization/domain/parameters/types/configValue.type';
import {
    TEAM_SERVICE_TOKEN,
    ITeamService,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import { IntegrationStatusFilter } from '@libs/organization/domain/team/interfaces/team.interface';

const CRON_KODY_LEARNING = process.env.API_CRON_KODY_LEARNING;

@Injectable()
export class KodyLearningCronProvider {
    private readonly logger = createLogger(KodyLearningCronProvider.name);
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly generateKodyRulesUseCase: GenerateKodyRulesUseCase,
    ) {}

    @Cron(CRON_KODY_LEARNING, {
        name: 'Kody Learning',
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron() {
        try {
            this.logger.log({
                message: 'Kody Rules generator cron started',
                context: KodyLearningCronProvider.name,
                metadata: {
                    timestamp: new Date().toISOString(),
                },
            });

            const teams = await this.teamService.findTeamsWithIntegrations({
                integrationCategories: [IntegrationCategory.CODE_MANAGEMENT],
                integrationStatus: IntegrationStatusFilter.CONFIGURED,
                status: STATUS.ACTIVE,
            });

            if (!teams || teams.length === 0) {
                this.logger.log({
                    message: 'No teams found',
                    context: KodyLearningCronProvider.name,
                    metadata: {
                        timestamp: new Date().toISOString(),
                    },
                });

                return;
            }

            for (const team of teams) {
                const organizationId = team.organization?.uuid;
                const teamId = team.uuid;

                const platformConfigs = await this.parametersService.findByKey(
                    ParametersKey.PLATFORM_CONFIGS,
                    { organizationId, teamId },
                );

                if (!platformConfigs) {
                    this.logger.error({
                        message: 'Platform configs not found',
                        context: KodyLearningCronProvider.name,
                        metadata: {
                            teamId,
                            timestamp: new Date().toISOString(),
                        },
                    });

                    continue;
                }

                const kodyLearningStatus =
                    platformConfigs.configValue.kodyLearningStatus;

                if (
                    !kodyLearningStatus ||
                    kodyLearningStatus === KodyLearningStatus.DISABLED
                ) {
                    this.logger.log({
                        message: 'Kody learning is disabled',
                        context: KodyLearningCronProvider.name,
                        metadata: {
                            teamId,
                            timestamp: new Date().toISOString(),
                        },
                    });

                    continue;
                }

                if (
                    kodyLearningStatus ===
                        KodyLearningStatus.GENERATING_CONFIG ||
                    kodyLearningStatus === KodyLearningStatus.GENERATING_RULES
                ) {
                    this.logger.log({
                        message: 'Kody learning is already generating',
                        context: KodyLearningCronProvider.name,
                        metadata: {
                            teamId,
                            timestamp: new Date().toISOString(),
                        },
                    });

                    continue;
                }

                await this.generateKodyRules({ organizationId, teamId });
            }
        } catch (error) {
            this.logger.error({
                message: 'Error in Kody Rules generator cron',
                context: KodyLearningCronProvider.name,
                error,
                metadata: {
                    timestamp: new Date().toISOString(),
                },
            });
        }
    }

    private async generateKodyRules(params: {
        organizationId: string;
        teamId: string;
    }) {
        try {
            const { organizationId, teamId } = params;
            const codeReviewConfig = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                { organizationId, teamId },
            );

            if (!codeReviewConfig || !codeReviewConfig.configValue) {
                this.logger.error({
                    message: 'Code review config not found',
                    context: KodyLearningCronProvider.name,
                    metadata: {
                        organizationId,
                        teamId,
                        timestamp: new Date().toISOString(),
                    },
                });
                return;
            }

            const repos = codeReviewConfig.configValue.repositories;

            if (!repos || repos.length === 0) {
                this.logger.error({
                    message: 'No repositories found',
                    context: KodyLearningCronProvider.name,
                    metadata: {
                        organizationId,
                        teamId,
                        timestamp: new Date().toISOString(),
                    },
                });
                return;
            }

            const defaultConfig = getDefaultKodusConfigFile();
            const resolvedGlobalConfig = deepMerge(
                defaultConfig,
                codeReviewConfig.configValue.configs ?? {},
            );

            const filteredRepos = repos.filter((repo) => {
                if (!repo.isSelected) return false;

                const resolvedRepoConfig = deepMerge(
                    resolvedGlobalConfig,
                    repo.configs ?? {},
                );

                return (
                    (resolvedRepoConfig as any)?.kodyRulesGeneratorEnabled ===
                    true
                );
            });

            if (!filteredRepos || filteredRepos.length === 0) {
                this.logger.log({
                    message: 'Kody rules generator is disabled',
                    context: KodyLearningCronProvider.name,
                    metadata: {
                        organizationId,
                        teamId,
                        timestamp: new Date().toISOString(),
                    },
                });
                return;
            }

            await this.generateKodyRulesUseCase.execute(
                {
                    teamId,
                    weeks: 1,
                    repositoriesIds: filteredRepos.map((repo) => repo.id),
                },
                organizationId,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error generating kody rules',
                context: KodyLearningCronProvider.name,
                error,
                metadata: {
                    params,
                    timestamp: new Date().toISOString(),
                },
            });
            return;
        }
    }
}
