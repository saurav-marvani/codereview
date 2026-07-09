import { ParametersKey } from '@libs/core/domain/enums';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { PullRequestClosedEvent } from '@libs/core/domain/events/pull-request-closed.event';
import { KodyRulesSyncService } from '../services/kodyRulesSync.service';
import { createLogger } from '@libs/core/log/logger';
import {
    IDE_RULES_SYNC_DISABLED_EVENT,
    IdeRulesSyncDisabledEvent,
} from '@libs/kodyRules/domain/events/ide-rules-sync.events';

@Injectable()
export class KodyRulesSyncListener {
    private readonly logger = createLogger(KodyRulesSyncListener.name);

    constructor(
        private readonly kodyRulesSyncService: KodyRulesSyncService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        @InjectDataSource()
        private readonly dataSource: DataSource,
    ) {}

    /**
     * Cross-process idempotency claim. The pull-request.closed event reaches
     * every process that hosts this listener (local emit in the webhook
     * consumer + CrossProcessEventsBridge re-emits elsewhere), and in
     * production there are N worker replicas — without a shared claim each
     * of them imports the same rule files concurrently and the sync creates
     * DUPLICATE rules (observed live: two identical rules from one merge).
     * First INSERT wins; everyone else skips. On infrastructure failure we
     * choose availability: proceed (worst case a duplicate, never a lost
     * sync).
     */
    private async claimSyncRun(claimKey: string): Promise<boolean> {
        try {
            await this.dataSource.query(
                `CREATE TABLE IF NOT EXISTS kodus_event_claims (
                    claim_key text PRIMARY KEY,
                    created_at timestamptz NOT NULL DEFAULT now()
                )`,
            );
            // Opportunistic TTL sweep so the table never grows unbounded.
            await this.dataSource.query(
                `DELETE FROM kodus_event_claims WHERE created_at < now() - interval '7 days'`,
            );
            const rows: unknown[] = await this.dataSource.query(
                `INSERT INTO kodus_event_claims (claim_key) VALUES ($1)
                 ON CONFLICT (claim_key) DO NOTHING
                 RETURNING claim_key`,
                [claimKey],
            );
            return rows.length > 0;
        } catch (error) {
            this.logger.warn({
                message:
                    'Sync claim check failed — proceeding without dedupe (availability over exactly-once)',
                context: KodyRulesSyncListener.name,
                error,
                metadata: { claimKey },
            });
            return true;
        }
    }

    @OnEvent('pull-request.closed')
    async handlePullRequestClosedEvent(event: PullRequestClosedEvent) {
        if (!event.repository || !event.repository.id) {
            this.logger.warn({
                message:
                    'Received pull-request.closed event without repository information, skipping Kody rules sync',
                context: KodyRulesSyncListener.name,
                metadata: {
                    pullRequestNumber: event.pullRequestNumber,
                },
            });
            return;
        }

        if (!event.merged) {
            this.logger.log({
                message:
                    'Received non-merged pull-request.closed event, skipping Kody rules sync',
                context: KodyRulesSyncListener.name,
                metadata: {
                    pullRequestNumber: event.pullRequestNumber,
                    repositoryId: event.repository.id,
                },
            });
            return;
        }

        if (await this.isCentralizedConfigRepo(event)) {
            this.logger.log({
                message:
                    'Pull request closed in centralized config repository, skipping Kody rules sync',
                context: KodyRulesSyncListener.name,
                metadata: {
                    pullRequestNumber: event.pullRequestNumber,
                    repositoryId: event.repository.id,
                },
            });
            return;
        }

        this.logger.log({
            message: 'Handling pull-request.closed event for Kody Rules Sync',
            context: KodyRulesSyncListener.name,
            metadata: {
                prNumber: event.pullRequestNumber,
                repositoryId: event.repository.id,
            },
        });

        if (!event.files || event.files.length === 0) {
            return;
        }

        const claimKey = `kody-rules-sync:${event.organizationAndTeamData?.organizationId}:${event.repository.id}:${event.pullRequestNumber}`;
        if (!(await this.claimSyncRun(claimKey))) {
            this.logger.log({
                message:
                    'Sync already claimed by another process for this merge — skipping duplicate run',
                context: KodyRulesSyncListener.name,
                metadata: {
                    claimKey,
                    prNumber: event.pullRequestNumber,
                },
            });
            return;
        }

        await this.kodyRulesSyncService.syncFromChangedFiles({
            organizationAndTeamData: event.organizationAndTeamData,
            repository: event.repository,
            pullRequestNumber: event.pullRequestNumber,
            files: event.files,
        });
    }

    @OnEvent(IDE_RULES_SYNC_DISABLED_EVENT)
    async handleIdeRulesSyncDisabled(
        event: IdeRulesSyncDisabledEvent,
    ): Promise<void> {
        if (!event?.repositoryId) {
            this.logger.warn({
                message:
                    'Received ide-rules-sync.disabled event without repositoryId, skipping',
                context: KodyRulesSyncListener.name,
                metadata: { event },
            });
            return;
        }

        // Action defaults to 'keep' (least destructive) when missing — matches
        // the use-case behaviour for callers that don't pass it explicitly.
        const action = event.action ?? 'keep';

        this.logger.log({
            message: `Handling ide-rules-sync.disabled event with action=${action}`,
            context: KodyRulesSyncListener.name,
            metadata: {
                repositoryId: event.repositoryId,
                organizationAndTeamData: event.organizationAndTeamData,
                action,
            },
        });

        switch (action) {
            case 'keep':
                // No-op: the user only stopped automatic re-imports. Rules
                // stay ACTIVE.
                return;
            case 'pause':
                await this.kodyRulesSyncService.pauseAllIdeSyncRulesForRepository(
                    {
                        organizationAndTeamData: event.organizationAndTeamData,
                        repositoryId: event.repositoryId,
                    },
                );
                return;
            case 'delete':
                await this.kodyRulesSyncService.purgeAllIdeSyncRulesForRepository(
                    {
                        organizationAndTeamData: event.organizationAndTeamData,
                        repositoryId: event.repositoryId,
                    },
                );
                return;
        }
    }

    private async isCentralizedConfigRepo(
        event: PullRequestClosedEvent,
    ): Promise<boolean> {
        try {
            const centralizedConfigParameter =
                await this.parametersService.findByKey(
                    ParametersKey.CENTRALIZED_CONFIG,
                    event.organizationAndTeamData,
                );

            if (
                !centralizedConfigParameter ||
                !centralizedConfigParameter.configValue
            ) {
                return false;
            }

            if (!centralizedConfigParameter.configValue.enabled) {
                return false;
            }

            const centralizedConfigRepoId =
                centralizedConfigParameter.configValue.repository?.id;

            return centralizedConfigRepoId === event.repository?.id;
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to determine centralized config status for Kody rules listener',
                context: KodyRulesSyncListener.name,
                metadata: {
                    organizationAndTeamData: event.organizationAndTeamData,
                    repositoryId: event.repository?.id,
                },
                error,
            });

            return false;
        }
    }
}
