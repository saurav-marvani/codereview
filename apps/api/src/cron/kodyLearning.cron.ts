import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { deepMerge } from '@libs/common/utils/deep';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
import { IntegrationCategory } from '@libs/core/domain/enums/integration-category.enum';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { GenerateKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/generate-kody-rules.use-case';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/find-rules-in-organization-by-filter.use-case';
import { KodyRulesOrigin } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
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
import {
    DistributedLock,
    DistributedLockService,
} from '@libs/core/workflow/infrastructure/distributed-lock.service';

import {
    hasExhaustedStuckRetries,
    isKodyLearningStatusStale,
} from './kody-learning-staleness';

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
        private readonly findRulesInOrganizationByRuleFilterKodyRulesUseCase: FindRulesInOrganizationByRuleFilterKodyRulesUseCase,
        private readonly distributedLockService: DistributedLockService,
    ) {}

    /**
     * A team's first-ever generation looks back 3 months (bootstrap); once any
     * past-review rule exists, later runs only need the incremental last week.
     */
    private async hasPastReviewRules(
        organizationId: string,
        repositoryId?: string,
    ): Promise<boolean> {
        try {
            // execute() returns a flat list of rules already filtered by the
            // predicate, so any result means a past-review rule exists.
            const rules =
                await this.findRulesInOrganizationByRuleFilterKodyRulesUseCase.execute(
                    organizationId,
                    { origin: KodyRulesOrigin.PAST_REVIEWS },
                    repositoryId,
                );

            return Boolean(rules?.length);
        } catch (error) {
            // On lookup failure, assume not-first so we don't accidentally
            // re-run an expensive 3-month backfill every week.
            this.logger.warn({
                message:
                    'Could not determine past-review rule history; defaulting to incremental lookback',
                context: KodyLearningCronProvider.name,
                error:
                    error instanceof Error ? error : new Error(String(error)),
                metadata: { organizationId, repositoryId },
            });
            return true;
        }
    }

    @Cron(CRON_KODY_LEARNING, {
        name: 'Kody Learning',
        timeZone: 'America/Sao_Paulo',
    })
    async handleCron() {
        // We run many app instances; the @Cron fires on every one. Acquire a
        // distributed lock so only a single instance runs the sweep.
        const lockKey = 'CRON:KODY_LEARNING';

        let lock: DistributedLock;
        try {
            lock = await this.distributedLockService.acquire(lockKey, {
                // Released in `finally` on a normal run — the TTL is only the
                // safety net if the holding instance crashes mid-sweep.
                ttl: 1000 * 60 * 30,
            });

            if (!lock) {
                this.logger.log({
                    message: 'Cron execution skipped - Lock already acquired',
                    context: KodyLearningCronProvider.name,
                    metadata: { lockKey },
                });
                return;
            }
        } catch (error) {
            this.logger.error({
                message: 'Error acquiring distributed lock for cron execution',
                context: KodyLearningCronProvider.name,
                metadata: { lockKey },
                error,
            });
            return;
        }

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
                    // A `generating_*` status can be stale: rule generation
                    // runs detached, so an API restart mid-run leaves a team
                    // stuck. A fresh status is a genuine in-progress run —
                    // skip it; an old one is a dead run we should restart.
                    if (
                        !isKodyLearningStatusStale(
                            kodyLearningStatus,
                            platformConfigs.updatedAt,
                        )
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

                    // A stuck run that keeps hard-crashing must not be
                    // retried forever — give up after MAX_STUCK_RETRIES so
                    // the cron stops re-crashing the process every tick.
                    if (
                        hasExhaustedStuckRetries(
                            platformConfigs.configValue
                                .kodyLearningStuckRetries,
                        )
                    ) {
                        this.logger.error({
                            message:
                                'Kody learning stuck and exhausted retries — giving up',
                            context: KodyLearningCronProvider.name,
                            metadata: {
                                teamId,
                                kodyLearningStatus,
                                stuckRetries:
                                    platformConfigs.configValue
                                        .kodyLearningStuckRetries,
                                timestamp: new Date().toISOString(),
                            },
                        });

                        continue;
                    }

                    this.logger.warn({
                        message:
                            'Kody learning stuck in a generating state — regenerating',
                        context: KodyLearningCronProvider.name,
                        metadata: {
                            teamId,
                            kodyLearningStatus,
                            stuckRetries:
                                platformConfigs.configValue
                                    .kodyLearningStuckRetries,
                            timestamp: new Date().toISOString(),
                        },
                    });
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
        } finally {
            try {
                await lock.release();
            } catch (error) {
                this.logger.error({
                    message:
                        'Error releasing distributed lock after cron execution',
                    context: KodyLearningCronProvider.name,
                    metadata: { lockKey },
                    error,
                });
            }
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

            // Repos whose resolved config has the generator enabled. Note this
            // does NOT gate on isSelected: right after onboarding repos sit in
            // the config with isSelected=false, and requiring it here meant the
            // cron never generated for a fresh team.
            const enabledRepos = repos.filter((repo) => {
                const resolvedRepoConfig = deepMerge(
                    resolvedGlobalConfig,
                    repo.configs ?? {},
                );

                return (
                    (resolvedRepoConfig as any)?.kodyRulesGeneratorEnabled ===
                    true
                );
            });

            if (enabledRepos.length === 0) {
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

            // First run for this team → 3-month bootstrap; later runs →
            // incremental last week.
            const isFirstGeneration = !(await this.hasPastReviewRules(
                organizationId,
            ));
            const lookback = isFirstGeneration ? { months: 3 } : { weeks: 1 };

            // Always scope to the generator-enabled repos (which include
            // post-onboarding repos still sitting at isSelected=false). Passing
            // them explicitly respects kodyRulesGeneratorEnabled instead of
            // letting the use-case fall back to every integration repo — which
            // would process repos where the generator was turned off.
            const enabledRepositoryIds = enabledRepos.map((repo) => repo.id);

            await this.generateKodyRulesUseCase.execute(
                {
                    teamId,
                    ...lookback,
                    repositoriesIds: enabledRepositoryIds,
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
