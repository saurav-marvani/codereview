import { Inject, Injectable } from '@nestjs/common';
import { createLogger } from '@kodus/flow';

import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { FeatureGateService } from '@libs/feature-gate/application/feature-gate.service';
import { FEATURE_KEYS } from '@libs/feature-gate/domain/feature-keys';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';

import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import {
    AGENT_BRANCH_STAGE_NAMES,
    EE_BRANCH_STAGE_NAMES,
} from '../strategy/engine-branches.const';
import { buildRepositoryDirectoryKey } from '../utils/repository-directory-key';
import { resolveTouchedDirectoryIds } from '../utils/resolve-touched-directories';

/**
 * Picks which engine handles this PR — agent mode or EE mode. The
 * unified pipeline contains both branches; this gate calls
 * `skipStages([...])` to bypass whichever branch lost. Default is agent
 * mode; the `agent-review` flag is consulted per touched directory and
 * any denial drops the PR to EE mode (any-opt-out).
 *
 * The flag is keyed on the `repositoryDirectory` group in PostHog — a
 * composite of `${repositoryId}:${directoryId}` so the same directory
 * id appearing in two repos can be opted out independently. Evaluations
 * pass exactly that one group; nothing repo-only or directory-only.
 *
 * Decision precedence:
 *   1. `API_AGENT_REVIEW_ENABLED` env override → agent (admin escape).
 *   2. For each touched directory, evaluate the flag with the composite
 *      group key; the first denial drops the PR to EE.
 *   3. No touched directories or all allow → agent.
 *
 * Marked silent so the UI/timeline never shows this internal decision.
 * Runs right after `ResolveConfigStage` (so `preliminaryFiles` and
 * `codeReviewConfig.directoryFolders` are populated) and before
 * `FetchChangedFilesStage` (which reads `useAgentEngine` for its
 * max-files limit).
 */
@Injectable()
export class SelectReviewEngineStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'SelectReviewEngineStage';
    readonly visibility = StageVisibility.INTERNAL;
    readonly silent = true;

    private readonly logger = createLogger(SelectReviewEngineStage.name);

    constructor(
        private readonly featureGate: FeatureGateService,
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,
    ) {
        super();
    }

    protected override async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const useAgent = await this.decideUseAgent(context);
        const stagesToSkip = useAgent
            ? EE_BRANCH_STAGE_NAMES
            : AGENT_BRANCH_STAGE_NAMES;

        const withEngine = this.updateContext(context, (draft) => {
            draft.pipelineMetadata = {
                ...(draft.pipelineMetadata ?? {}),
                useAgentEngine: useAgent,
            };
        });
        return this.skipStages(withEngine, stagesToSkip);
    }

    private async decideUseAgent(
        context: CodeReviewPipelineContext,
    ): Promise<boolean> {
        const envOverride =
            process.env.API_AGENT_REVIEW_ENABLED?.toLowerCase();
        if (envOverride === 'true' || envOverride === '1') {
            this.logger.log({
                message:
                    '[ENGINE-SELECT] agent forced by API_AGENT_REVIEW_ENABLED',
                context: this.stageName,
                metadata: {
                    repositoryId: context.repository?.id,
                    organizationId:
                        context.organizationAndTeamData?.organizationId,
                },
            });
            return true;
        }

        const folders = context.codeReviewConfig?.directoryFolders ?? [];
        const paths = (context.preliminaryFiles ?? []).map(
            (file) => file.filename,
        );
        const touchedDirectoryIds = resolveTouchedDirectoryIds(paths, folders);

        if (touchedDirectoryIds.length === 0) {
            return true;
        }

        const repositoryId = context.repository?.id;
        if (!repositoryId) {
            // Composite key needs both ids. Without a repositoryId we
            // can't build the group key, so the gate is a no-op and
            // the default (agent) stands.
            this.logger.warn({
                message:
                    '[ENGINE-SELECT] no repository id on context — skipping directory opt-out probes',
                context: this.stageName,
            });
            return true;
        }

        const orgId = context.organizationAndTeamData?.organizationId;
        const identifier =
            orgId || context.organizationAndTeamData?.teamId || 'unknown';
        const releaseTrack = orgId
            ? await this.organizationService.getReleaseTrack(orgId)
            : undefined;

        for (const directoryId of touchedDirectoryIds) {
            const repositoryDirectory = buildRepositoryDirectoryKey(
                repositoryId,
                directoryId,
            );
            try {
                const directoryEnabled = await this.featureGate.isEnabled(
                    FEATURE_KEYS.agentReview,
                    {
                        identifier,
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        releaseTrack,
                        groups: { repositoryDirectory },
                    },
                );
                if (!directoryEnabled) {
                    this.logger.log({
                        message: `[ENGINE-SELECT] ${repositoryDirectory} opted out — dropping to EE mode`,
                        context: this.stageName,
                        metadata: {
                            repositoryDirectory,
                            directoryId,
                            repositoryId,
                        },
                    });
                    return false;
                }
            } catch (err) {
                // Probe failure for this directory: treat as not-opted-out
                // and keep checking the rest. A transient PostHog outage
                // therefore doesn't silently force everyone to EE — it
                // just means the failing directory can't veto.
                this.logger.warn({
                    message:
                        '[ENGINE-SELECT] directory probe failed — skipping this directory and continuing',
                    context: this.stageName,
                    metadata: {
                        repositoryDirectory,
                        directoryId,
                        repositoryId,
                        error:
                            err instanceof Error ? err.message : String(err),
                    },
                });
            }
        }

        return true;
    }
}
