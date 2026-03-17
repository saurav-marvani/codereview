import { createLogger } from '@kodus/flow';
import { CodeReviewVersion } from '@libs/core/domain/enums/code-review.enum';
import { Inject, Injectable } from '@nestjs/common';

import {
    COLLECT_CROSS_FILE_CONTEXTS_SERVICE_TOKEN,
    CollectCrossFileContextsService,
} from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import {
    ISandboxProvider,
    SANDBOX_PROVIDER_TOKEN,
} from '@libs/code-review/domain/contracts/sandbox.provider';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { CloneParamsResolverService } from '../services/clone-params-resolver.service';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { CliReviewPipelineContext } from '@libs/cli-review/pipeline/context/cli-review-pipeline.context';

/**
 * Parse a git remote URL (HTTPS or SSH) into owner/repo parts.
 * Supports:
 *  - https://github.com/owner/repo.git
 *  - git@github.com:owner/repo.git
 */
export function parseGitRemoteUrl(
    url: string,
): { fullName: string; name: string } | null {
    // HTTPS format: https://github.com/owner/repo.git
    const httpsMatch = url.match(
        /https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/,
    );
    if (httpsMatch) {
        const fullName = httpsMatch[1];
        const name = fullName.split('/')[1];
        return { fullName, name };
    }

    // SSH format: git@github.com:owner/repo.git
    const sshMatch = url.match(/[^@]+@[^:]+:([^/]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch) {
        const fullName = sshMatch[1];
        const name = fullName.split('/')[1];
        return { fullName, name };
    }

    return null;
}

@Injectable()
export class CollectCrossFileContextStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'CollectCrossFileContextStage';
    readonly label = 'Gathering Cross-File Context';
    readonly visibility = StageVisibility.PRIMARY;

    private readonly logger = createLogger(CollectCrossFileContextStage.name);

    constructor(
        @Inject(COLLECT_CROSS_FILE_CONTEXTS_SERVICE_TOKEN)
        private readonly collectCrossFileContextsService: CollectCrossFileContextsService,
        @Inject(SANDBOX_PROVIDER_TOKEN)
        private readonly sandboxProvider: ISandboxProvider,
        private readonly cloneParamsResolver: CloneParamsResolverService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        // V3 agents use sandbox tools directly — cross-file context is collected on demand
        if (
            context.codeReviewConfig?.codeReviewVersion ===
            CodeReviewVersion.V3_AGENT
        ) {
            this.logger.log({
                message:
                    'Skipping cross-file context: v3-agent mode (agents search on demand)',
                context: this.stageName,
            });
            return context;
        }

        const isCliMode = context.origin === 'cli';
        const cliContext = isCliMode
            ? (context as unknown as CliReviewPipelineContext)
            : undefined;
        const label = isCliMode
            ? `branch ${cliContext?.gitContext?.branch ?? 'unknown'}`
            : `PR#${context?.pullRequest?.number}`;

        // Guard: skip in fast mode (fast = speed over depth)
        if (cliContext?.isFastMode) {
            this.logger.log({
                message: `Skipping cross-file context collection: fast mode`,
                context: this.stageName,
            });
            return context;
        }

        // Guard: skip if crossFileDependenciesAnalysis is disabled
        if (context.codeReviewConfig?.crossFileDependenciesAnalysis === false) {
            this.logger.log({
                message: `Skipping cross-file context collection: crossFileDependenciesAnalysis is disabled for ${label}`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
            });
            return context;
        }

        // Guard: skip if no changed files
        if (!context?.changedFiles?.length) {
            this.logger.log({
                message: `Skipping cross-file context collection: no changed files for ${label}`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
            });
            return context;
        }

        // Guard: skip if sandbox is not available
        if (!this.sandboxProvider.isAvailable()) {
            this.logger.log({
                message: `Skipping cross-file context collection: no sandbox provider configured for ${label}`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
            });
            return context;
        }

        // Guard (CLI): skip if no git remote available
        if (isCliMode && !cliContext?.gitContext?.remote) {
            this.logger.log({
                message: `Skipping cross-file context collection: no git remote in CLI context`,
                context: this.stageName,
            });
            return context;
        }

        let cleanup: (() => Promise<void>) | undefined;

        try {
            const cloneInfo = await this.cloneParamsResolver.resolve(
                context,
                cliContext,
            );
            if (!cloneInfo) {
                this.logger.warn({
                    message: `[DEBUG] resolveCloneParams returned null for ${label}`,
                    context: this.stageName,
                });
                return context;
            }

            this.logger.log({
                message: `[DEBUG] Clone params resolved for ${label}: url=${cloneInfo.url} platform=${cloneInfo.platform} branch=${cloneInfo.branch} prNumber=${cloneInfo.prNumber} hasToken=${!!cloneInfo.authToken}`,
                context: this.stageName,
                metadata: {
                    cloneUrl: cloneInfo.url,
                    platform: cloneInfo.platform,
                    branch: cloneInfo.branch,
                    prNumber: cloneInfo.prNumber,
                    hasAuthToken: !!cloneInfo.authToken,
                    tokenLength: cloneInfo.authToken?.length ?? 0,
                    sandboxProviderType: this.sandboxProvider.constructor.name,
                },
            });

            // Create sandbox and clone repo
            const sandbox = await this.sandboxProvider.createSandboxWithRepo({
                cloneUrl: cloneInfo.url,
                authToken: cloneInfo.authToken,
                authUsername: cloneInfo.authUsername,
                branch: cloneInfo.branch,
                prNumber: cloneInfo.prNumber,
                platform: cloneInfo.platform,
            });

            cleanup = sandbox.cleanup;

            this.logger.log({
                message: `[DEBUG] Sandbox created successfully for ${label}, starting collectContexts`,
                context: this.stageName,
            });

            // Collect cross-file contexts using sandbox remoteCommands
            const result =
                await this.collectCrossFileContextsService.collectContexts({
                    remoteCommands: sandbox.remoteCommands,
                    changedFiles: context.changedFiles,
                    byokConfig: context.codeReviewConfig?.byokConfig,
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                    language:
                        context.codeReviewConfig?.languageResultPrompt ||
                        'en-US',
                    repoRoot: '.',
                });

            this.logger.log({
                message: `Cross-file context collected for ${label}: ${result.contexts.length} snippets from ${result.totalSearches} searches`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                    contextsCount: result.contexts.length,
                    totalSearches: result.totalSearches,
                    totalSnippetsBeforeDedup: result.totalSnippetsBeforeDedup,
                },
            });

            return this.updateContext(context, (draft) => {
                draft.crossFileContexts = result;
                // Keep sandbox alive for safeguard agent verification
                draft.sandboxHandle = {
                    remoteCommands: sandbox.remoteCommands,
                    cleanup: sandbox.cleanup,
                };
                // Save a factory for clone params so safeguard can renew sandbox if it expires
                draft.getFreshCloneParams = async () => {
                    const freshCloneInfo =
                        await this.cloneParamsResolver.resolve(
                            context,
                            cliContext,
                        );
                    if (!freshCloneInfo) {
                        throw new Error(
                            'Failed to resolve fresh clone parameters',
                        );
                    }
                    return {
                        cloneUrl: freshCloneInfo.url,
                        authToken: freshCloneInfo.authToken,
                        authUsername: freshCloneInfo.authUsername,
                        branch: freshCloneInfo.branch,
                        prNumber: freshCloneInfo.prNumber,
                        platform: freshCloneInfo.platform,
                    };
                };
            });
        } catch (error) {
            // Non-fatal: log error and return context unchanged
            this.logger.error({
                message: `Failed to collect cross-file context for ${label}, continuing without it`,
                context: this.stageName,
                error,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
            });
            // Cleanup sandbox on error since we won't store it in context
            if (cleanup) {
                try {
                    await cleanup();
                } catch (cleanupErr) {
                    this.logger.warn({
                        message: `Sandbox cleanup failed after cross-file context error`,
                        context: this.stageName,
                        error: cleanupErr,
                    });
                }
            }
            return context;
        }
    }

    /**
     * Resolve clone parameters based on context origin.
     * - PR mode: uses codeManagementService.getCloneParams() as before
     * - CLI mode: parses git remote URL and tries to get auth from platform integration
     */
}
