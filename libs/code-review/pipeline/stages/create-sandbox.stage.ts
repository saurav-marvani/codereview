import { CloneParamsResolverService } from '../services/clone-params-resolver.service';
import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import {
    ISandboxProvider,
    SANDBOX_PROVIDER_TOKEN,
} from '@libs/code-review/domain/contracts/sandbox.provider';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { CliReviewPipelineContext } from '@libs/cli-review/pipeline/context/cli-review-pipeline.context';

/**
 * Creates and stores a sandbox instance in the pipeline context.
 *
 * Extracted from CollectCrossFileContextStage so that the sandbox can be
 * shared across multiple downstream stages (agent review, safeguard, etc.)
 * without coupling sandbox lifecycle to cross-file context collection.
 */
@Injectable()
export class CreateSandboxStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'CreateSandboxStage';
    readonly label = 'Preparing Sandbox';
    readonly visibility = StageVisibility.SECONDARY;

    private readonly logger = createLogger(CreateSandboxStage.name);

    constructor(
        @Inject(SANDBOX_PROVIDER_TOKEN)
        private readonly sandboxProvider: ISandboxProvider,
        private readonly cloneParamsResolver: CloneParamsResolverService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        // Skip if sandbox already exists (e.g. created by CollectCrossFileContext in v2)
        if (context.sandboxHandle) {
            this.logger.log({
                message: 'Sandbox already exists in context, skipping creation',
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

        // Guard: skip in fast mode
        if (cliContext?.isFastMode) {
            this.logger.log({
                message: `Skipping sandbox creation: fast mode`,
                context: this.stageName,
            });
            return context;
        }

        // Guard: skip if no changed files
        if (!context?.changedFiles?.length) {
            this.logger.log({
                message: `Skipping sandbox creation: no changed files for ${label}`,
                context: this.stageName,
            });
            return context;
        }

        // Guard: skip if sandbox is not available
        if (!this.sandboxProvider.isAvailable()) {
            this.logger.log({
                message: `Skipping sandbox creation: no sandbox provider configured for ${label}`,
                context: this.stageName,
            });
            return context;
        }

        // Guard (CLI): skip if no git remote available
        if (isCliMode && !cliContext?.gitContext?.remote) {
            this.logger.log({
                message: `Skipping sandbox creation: no git remote in CLI context`,
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
                    message: `resolveCloneParams returned null for ${label}`,
                    context: this.stageName,
                });
                return context;
            }

            this.logger.log({
                message: `Creating sandbox for ${label}`,
                context: this.stageName,
                metadata: {
                    cloneUrl: cloneInfo.url,
                    platform: cloneInfo.platform,
                    branch: cloneInfo.branch,
                    prNumber: cloneInfo.prNumber,
                    hasAuthToken: !!cloneInfo.authToken,
                },
            });

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
                message: `Sandbox created successfully for ${label}`,
                context: this.stageName,
            });

            return this.updateContext(context, (draft) => {
                draft.sandboxHandle = {
                    remoteCommands: sandbox.remoteCommands,
                    cleanup: sandbox.cleanup,
                };
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
        } catch (firstError) {
            // Retry once — large repos may need a second attempt (network/timeout)
            this.logger.warn({
                message: `Sandbox creation failed for ${label}, retrying once...`,
                context: this.stageName,
                error: firstError,
            });

            try {
                if (cleanup) {
                    try {
                        await cleanup();
                    } catch {
                        // ignore cleanup errors on retry
                    }
                }

                // Second attempt with same params
                const retryResult = await this.sandboxProvider.create(
                    resolveCloneParams,
                );
                sandboxHandle = retryResult.sandboxHandle;
                cleanup = retryResult.cleanup;

                return this.updateContext(context, (draft) => {
                    draft.sandboxHandle = sandboxHandle;
                    draft.sandboxCloneParams =
                        context.sandboxCloneParams || undefined;
                });
            } catch (retryError) {
                this.logger.error({
                    message: `Failed to create sandbox for ${label} after retry, continuing without it`,
                    context: this.stageName,
                    error: retryError,
                    metadata: {
                        organizationAndTeamData:
                            context?.organizationAndTeamData,
                        prNumber: context?.pullRequest?.number,
                    },
                });
            }

            const error = firstError;
            if (cleanup) {
                try {
                    await cleanup();
                } catch (cleanupErr) {
                    this.logger.warn({
                        message: `Sandbox cleanup failed after creation error`,
                        context: this.stageName,
                        error: cleanupErr,
                    });
                }
            }
            return context;
        }
    }
}
