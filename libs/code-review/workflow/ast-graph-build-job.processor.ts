import { createLogger } from '@kodus/flow';
import { Injectable, Inject } from '@nestjs/common';
import type { Sandbox } from 'e2b';

import { IJobProcessorService } from '@libs/core/workflow/domain/contracts/job-processor.service.contract';
import {
    IWorkflowJobRepository,
    WORKFLOW_JOB_REPOSITORY_TOKEN,
} from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import { PlatformType } from '@libs/core/domain/enums';
import {
    ISandboxProvider,
    SANDBOX_PROVIDER_TOKEN,
    SandboxInstance,
} from '@libs/code-review/domain/contracts/sandbox.provider';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { AstGraphBuildService } from '@libs/code-review/infrastructure/adapters/services/astGraphBuild.service';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

interface AstGraphBuildJobPayload {
    repositoryId: string;
    cloneUrl: string;
    defaultBranch: string;
    fullName: string;
    platform: string;
    organizationAndTeamData: OrganizationAndTeamData;
}

@Injectable()
export class AstGraphBuildJobProcessor implements IJobProcessorService {
    private readonly logger = createLogger(AstGraphBuildJobProcessor.name);

    constructor(
        @Inject(WORKFLOW_JOB_REPOSITORY_TOKEN)
        private readonly jobRepository: IWorkflowJobRepository,
        @Inject(SANDBOX_PROVIDER_TOKEN)
        private readonly sandboxProvider: ISandboxProvider,
        private readonly codeManagementService: CodeManagementService,
        private readonly astGraphBuildService: AstGraphBuildService,
    ) {}

    async process(jobId: string): Promise<void> {
        const jobStart = Date.now();
        const job = await this.jobRepository.findOne(jobId);

        if (!job) {
            throw new Error(`Job ${jobId} not found`);
        }

        const payload = job.payload as unknown as AstGraphBuildJobPayload;
        const repoLabel =
            payload?.fullName || payload?.repositoryId || 'unknown';

        this.logger.log({
            message: `[AST-GRAPH-JOB] Starting build for ${repoLabel}`,
            context: AstGraphBuildJobProcessor.name,
            metadata: {
                jobId,
                repositoryId: payload?.repositoryId,
                fullName: payload?.fullName,
                defaultBranch: payload?.defaultBranch,
                platform: payload?.platform,
                correlationId: job.correlationId,
            },
        });

        await this.updateJobStage(jobId, 'VALIDATING');

        if (
            !payload?.repositoryId ||
            !payload?.fullName ||
            !payload?.defaultBranch
        ) {
            throw new Error(
                'Invalid payload: missing required fields (repositoryId, fullName, defaultBranch)',
            );
        }

        let sandbox: SandboxInstance | undefined;
        let sandboxId: string | undefined;

        try {
            // 1. Resolve auth
            await this.updateJobStage(jobId, 'RESOLVING_AUTH');
            const authStart = Date.now();

            const cloneParams = await this.codeManagementService.getCloneParams(
                {
                    repository: {
                        id: '0',
                        defaultBranch: payload.defaultBranch,
                        fullName: payload.fullName,
                        name:
                            payload.fullName.split('/').pop() ||
                            payload.fullName,
                    },
                    organizationAndTeamData: payload.organizationAndTeamData,
                },
                payload.platform as PlatformType,
            );

            this.logger.log({
                message: `[AST-GRAPH-JOB] Auth resolved for ${repoLabel} (${Date.now() - authStart}ms)`,
                context: AstGraphBuildJobProcessor.name,
                metadata: { jobId, hasToken: !!cloneParams.auth?.token },
            });

            // 2. Create sandbox + clone
            await this.updateJobStage(jobId, 'CLONING');
            const cloneStart = Date.now();

            sandbox = await this.sandboxProvider.createSandboxWithRepo({
                cloneUrl: cloneParams.url || payload.cloneUrl,
                authToken: cloneParams.auth?.token || '',
                authUsername: cloneParams.auth?.username,
                branch: payload.defaultBranch,
                platform: payload.platform as PlatformType,
                sandboxMetadata: { stage: 'graph-build' },
            });

            sandboxId =
                (sandbox.sandboxHandle as any)?.sandboxId ||
                (sandbox as any)?.id ||
                'unknown';

            await this.jobRepository.update(jobId, {
                metadata: { sandboxId, stage: 'CLONING' },
            });

            this.logger.log({
                message: `[AST-GRAPH-JOB] Sandbox ready for ${repoLabel} (${Date.now() - cloneStart}ms)`,
                context: AstGraphBuildJobProcessor.name,
                metadata: { jobId, sandboxId },
            });

            // 3. Get HEAD sha
            const shaResult = await (
                sandbox.sandboxHandle as Sandbox
            ).commands.run('git -C /home/user/repo rev-parse HEAD', {
                timeoutMs: 10_000,
            });
            const headSha = shaResult.stdout?.trim() || '';

            if (!headSha) {
                throw new Error('Failed to resolve HEAD sha from sandbox');
            }

            this.logger.log({
                message: `[AST-GRAPH-JOB] HEAD sha resolved: ${headSha.substring(0, 8)} for ${repoLabel}`,
                context: AstGraphBuildJobProcessor.name,
                metadata: { jobId, headSha, sandboxId },
            });

            // 4. Parse + persist
            await this.updateJobStage(jobId, 'PARSING', { sandboxId, headSha });

            await this.astGraphBuildService.fullBuild({
                repositoryId: payload.repositoryId,
                sandbox: sandbox.sandboxHandle as Sandbox,
                headSha,
            });

            const totalMs = Date.now() - jobStart;

            await this.markCompleted(jobId, {
                repositoryId: payload.repositoryId,
                headSha,
                sandboxId,
                durationMs: totalMs,
            });

            this.logger.log({
                message: `[AST-GRAPH-JOB] Build COMPLETED for ${repoLabel} in ${totalMs}ms`,
                context: AstGraphBuildJobProcessor.name,
                metadata: {
                    jobId,
                    repositoryId: payload.repositoryId,
                    headSha,
                    sandboxId,
                    durationMs: totalMs,
                },
            });
        } catch (error) {
            const totalMs = Date.now() - jobStart;
            const classification = this.classifyError(error);

            this.logger.error({
                message: `[AST-GRAPH-JOB] Build FAILED for ${repoLabel} after ${totalMs}ms — ${error.message}`,
                error,
                context: AstGraphBuildJobProcessor.name,
                metadata: {
                    jobId,
                    repositoryId: payload.repositoryId,
                    sandboxId,
                    durationMs: totalMs,
                    classification,
                },
            });

            await this.handleFailure(jobId, error, classification, sandboxId);

            // Only re-throw TRANSIENT errors so RabbitMQ retries.
            // PERMANENT errors are already marked FAILED — retrying would just overwrite the status.
            if (classification === ErrorClassification.TRANSIENT) {
                throw error;
            }
        } finally {
            if (sandbox) {
                try {
                    await sandbox.cleanup();
                    this.logger.log({
                        message: `[AST-GRAPH-JOB] Sandbox cleaned up for ${repoLabel}`,
                        context: AstGraphBuildJobProcessor.name,
                        metadata: { jobId, sandboxId },
                    });
                } catch (cleanupError) {
                    this.logger.warn({
                        message: `[AST-GRAPH-JOB] Sandbox cleanup failed for ${repoLabel}`,
                        context: AstGraphBuildJobProcessor.name,
                        error: cleanupError,
                        metadata: { jobId, sandboxId },
                    });
                }
            }
        }
    }

    private async updateJobStage(
        jobId: string,
        stage: string,
        extra?: Record<string, unknown>,
    ): Promise<void> {
        await this.jobRepository.update(jobId, {
            status: JobStatus.PROCESSING,
            startedAt: new Date(),
            currentStage: stage,
            metadata: { stage, ...extra },
        });
    }

    private classifyError(error: any): ErrorClassification {
        const msg = (error?.message || '').toLowerCase();
        const stderr = (error?.result?.stderr || '').toLowerCase();
        const combined = `${msg} ${stderr}`;

        // Transient: sandbox, network, timeout, clone auth, resource exhaustion
        if (
            combined.includes('timeout') ||
            combined.includes('econnrefused') ||
            combined.includes('econnreset') ||
            combined.includes('enotfound') ||
            combined.includes('epipe') ||
            combined.includes('sandbox') ||
            combined.includes('exit status 128') ||
            combined.includes('could not resolve host') ||
            combined.includes('rate limit') ||
            combined.includes('out of memory') ||
            combined.includes('enomem') ||
            combined.includes('enospc') ||
            combined.includes('503') ||
            combined.includes('502') ||
            combined.includes('temporarily unavailable')
        ) {
            return ErrorClassification.TRANSIENT;
        }

        return ErrorClassification.PERMANENT;
    }

    async handleFailure(
        jobId: string,
        error: Error,
        classification: ErrorClassification = ErrorClassification.PERMANENT,
        sandboxId?: string,
    ): Promise<void> {
        await this.jobRepository.update(jobId, {
            status: JobStatus.FAILED,
            errorClassification: classification,
            lastError: error.message?.slice(0, 1000),
            failedAt: new Date(),
            metadata: { sandboxId, stage: 'FAILED' },
        });
    }

    async markCompleted(jobId: string, result?: unknown): Promise<void> {
        await this.jobRepository.update(jobId, {
            status: JobStatus.COMPLETED,
            completedAt: new Date(),
            currentStage: 'DONE',
            result,
        });
    }
}
