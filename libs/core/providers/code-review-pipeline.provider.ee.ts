/**
 * @license
 * Kodus Tech. All rights reserved.
 */
import { CodeReviewAgentPipelineStrategy } from '@libs/code-review/pipeline/strategy/code-review-agent-pipeline.strategy';
import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { IPipeline } from '@libs/core/infrastructure/pipeline/interfaces/pipeline.interface';
import { PipelineExecutor } from '@libs/core/infrastructure/pipeline/services/pipeline-executor.service';
import { Provider } from '@nestjs/common';
import { CodeReviewPipelineStrategyEE } from '@libs/ee/codeReview/strategies/code-review-pipeline.strategy.ee';
import { createLogger } from '@kodus/flow';
import { CodeReviewPipelineObserver } from '@libs/code-review/infrastructure/observers/code-review-pipeline.observer';
import posthog, { FEATURE_FLAGS } from '@libs/common/utils/posthog';

export const CODE_REVIEW_PIPELINE_TOKEN = 'CODE_REVIEW_PIPELINE';

const logger = createLogger('codeReviewPipelineProvider');

export const codeReviewPipelineProvider: Provider = {
    provide: CODE_REVIEW_PIPELINE_TOKEN,
    useFactory: (
        eeStrategy: CodeReviewPipelineStrategyEE,
        agentStrategy: CodeReviewAgentPipelineStrategy,
        observer: CodeReviewPipelineObserver,
    ): IPipeline<CodeReviewPipelineContext> => {
        logger.log({
            message: `Pipeline provider initialized with EE (v4) and Agent strategies`,
            context: 'CodeReviewPipelineProvider',
        });

        return {
            pipeLineName: 'CodeReviewPipeline',
            execute: async (
                context: CodeReviewPipelineContext,
            ): Promise<CodeReviewPipelineContext> => {
                const featureIdentifier =
                    context.organizationAndTeamData?.organizationId ||
                    context.organizationAndTeamData?.teamId ||
                    'unknown';

                const repositoryId = context.repository?.id;

                logger.log({
                    message: `[FEATURE-FLAG] Evaluating agent-review flag`,
                    context: 'CodeReviewPipelineProvider',
                    metadata: {
                        featureIdentifier,
                        repositoryId,
                        repositoryName: context.repository?.name,
                        repositoryFullName: context.repository?.fullName,
                        organizationId:
                            context.organizationAndTeamData?.organizationId,
                        teamId: context.organizationAndTeamData?.teamId,
                        posthogInitialized: posthog.isInitialized,
                    },
                });

                let useAgentPipeline = false;

                // Self-hosted override: instance admin can force the new
                // agent engine on without PostHog. When set, bypasses the
                // feature-flag check entirely (all orgs on this instance
                // use the agent pipeline).
                const envOverride =
                    process.env.API_AGENT_REVIEW_ENABLED?.toLowerCase();
                if (envOverride === 'true' || envOverride === '1') {
                    useAgentPipeline = true;
                    logger.log({
                        message: `[FEATURE-FLAG] agent-review forced by API_AGENT_REVIEW_ENABLED env var`,
                        context: 'CodeReviewPipelineProvider',
                        metadata: {
                            repositoryId,
                            featureIdentifier,
                        },
                    });
                } else if (posthog.isInitialized) {
                    const flagResult = await posthog.isFeatureEnabled(
                        FEATURE_FLAGS.agentReview,
                        featureIdentifier,
                        context.organizationAndTeamData,
                        repositoryId,
                    );
                    useAgentPipeline = flagResult === true;

                    logger.log({
                        message: `[FEATURE-FLAG] agent-review result: ${flagResult} (repositoryId=${repositoryId})`,
                        context: 'CodeReviewPipelineProvider',
                        metadata: {
                            flagResult,
                            repositoryId,
                            featureIdentifier,
                        },
                    });
                }

                const strategy = useAgentPipeline ? agentStrategy : eeStrategy;

                logger.log({
                    message: `Pipeline strategy selected: ${strategy.getPipelineName()} (agentFlag=${useAgentPipeline}, posthogInitialized=${posthog.isInitialized}, identifier=${featureIdentifier}, repositoryId=${repositoryId})`,
                    context: 'CodeReviewPipelineProvider',
                });

                // Mark which engine will run so downstream stages (e.g.
                // FetchChangedFilesStage) can apply engine-specific limits.
                context.pipelineMetadata = {
                    ...(context.pipelineMetadata || {}),
                    useAgentEngine: useAgentPipeline,
                };

                const stages = strategy.configureStages();
                const executor = new PipelineExecutor();
                return (await executor.execute(
                    context,
                    stages,
                    strategy.getPipelineName(),
                    undefined,
                    undefined,
                    [observer],
                )) as CodeReviewPipelineContext;
            },
        };
    },
    inject: [
        CodeReviewPipelineStrategyEE,
        CodeReviewAgentPipelineStrategy,
        CodeReviewPipelineObserver,
    ],
};
