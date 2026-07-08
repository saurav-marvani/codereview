import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { KodyRulesOrigin } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { GenerateKodyRulesUseCase } from './generate-kody-rules.use-case';

/**
 * How far back the FIRST past-reviews generation looks — 3 months, matching the
 * historical onboarding window. The weekly cron only pulls the last week, so
 * without this seed a repo enabled after onboarding would never learn from its
 * history (issue #1506).
 */
const INITIAL_GENERATION_MONTHS = 3;

/**
 * Seed a repository's Kody Rules from its last 3 months of PR review comments,
 * the first time its generator is enabled. Idempotent: skips when the repo
 * already has past-reviews rules, so re-enabling (or a duplicate transition
 * signal) never re-runs the expensive analysis. Designed to be fired detached
 * from the config-save request.
 */
@Injectable()
export class GenerateInitialKodyRulesUseCase {
    private readonly logger = createLogger(
        GenerateInitialKodyRulesUseCase.name,
    );

    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
        private readonly generateKodyRulesUseCase: GenerateKodyRulesUseCase,
    ) {}

    async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<void> {
        const { organizationAndTeamData, repositoryId } = params;
        const { organizationId, teamId } = organizationAndTeamData;

        if (!organizationId || !teamId || !repositoryId) {
            return;
        }

        try {
            if (await this.hasPastReviewRules(organizationId, repositoryId)) {
                this.logger.log({
                    message:
                        'Initial Kody Rules generation skipped — repository already has past-review rules',
                    context: GenerateInitialKodyRulesUseCase.name,
                    metadata: { organizationId, teamId, repositoryId },
                });
                return;
            }

            this.logger.log({
                message:
                    'Starting initial 3-month Kody Rules generation for newly-enabled repository',
                context: GenerateInitialKodyRulesUseCase.name,
                metadata: { organizationId, teamId, repositoryId },
            });

            await this.generateKodyRulesUseCase.execute(
                {
                    teamId,
                    months: INITIAL_GENERATION_MONTHS,
                    repositoriesIds: [repositoryId],
                },
                organizationId,
            );
        } catch (error) {
            this.logger.error({
                message: 'Initial Kody Rules generation failed',
                context: GenerateInitialKodyRulesUseCase.name,
                error:
                    error instanceof Error ? error : new Error(String(error)),
                metadata: { organizationId, teamId, repositoryId },
            });
        }
    }

    /** Whether the repo already carries generator-produced (past-reviews) rules,
     *  i.e. the initial generation has already run for it. Public so the weekly
     *  cron can decide, per repo, between the 3-month backfill and the 1-week
     *  delta window. */
    async hasPastReviewRules(
        organizationId: string,
        repositoryId: string,
    ): Promise<boolean> {
        // Query the singleton service directly (not the request-scoped find
        // use-case) so this stays callable from the cron, which has no request
        // context.
        const documents = await this.kodyRulesService.find({
            organizationId,
            rules: [
                {
                    repositoryId,
                    origin: KodyRulesOrigin.PAST_REVIEWS,
                },
            ],
        });

        return (documents ?? []).some((document) =>
            document?.rules?.some(
                (rule) =>
                    rule?.repositoryId === repositoryId &&
                    rule?.origin === KodyRulesOrigin.PAST_REVIEWS,
            ),
        );
    }
}
