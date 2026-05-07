import { createLogger } from '@kodus/flow';
import { SUPPORTED_LANGUAGES } from '@libs/code-review/domain/contracts/SupportedLanguages';
import { DocumentationLLMPlannerService } from '@libs/code-review/infrastructure/adapters/services/documentation-llm-planner.service';
import { DocumentationPackageDiscoveryService } from '@libs/code-review/infrastructure/adapters/services/documentation-package-discovery.service';
import { DocumentationSearchExaService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import posthog, { FEATURE_FLAGS } from '@libs/common/utils/posthog';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import path from 'path';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';

@Injectable()
export class GatherDocumentationContextStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'GatherDocumentationContextStage';
    readonly label = 'Gathering Documentation Context';
    readonly visibility = StageVisibility.SECONDARY;

    private readonly logger = createLogger(
        GatherDocumentationContextStage.name,
    );

    constructor(
        private readonly configService: ConfigService,
        private readonly packageDiscoveryService: DocumentationPackageDiscoveryService,
        private readonly llmPlannerService: DocumentationLLMPlannerService,
        private readonly documentationSearchService: DocumentationSearchExaService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const shouldRunDocumentationContext =
            await this.shouldRunDocumentationContext(context);

        if (!shouldRunDocumentationContext) {
            this.logger.log({
                message:
                    'Documentation context stage disabled by feature flag; skipping',
                context: this.stageName,
                metadata: {
                    prNumber: context.pullRequest.number,
                    repository: context.repository.name,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });

            return this.updateContext(context, (draft) => {
                draft.discoveredPackages = [];
                draft.documentationQueryPlanByFile = {};
                draft.documentationByFile = {};
            });
        }

        if (!context.changedFiles?.length) {
            return context;
        }

        const codeFiles = context.changedFiles.filter((file) =>
            this.isCodeFile(file.filename),
        );

        if (!codeFiles.length) {
            this.logger.log({
                message:
                    'No supported code files found for documentation context stage',
                context: this.stageName,
                metadata: {
                    prNumber: context.pullRequest.number,
                    repository: context.repository.name,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });

            return this.updateContext(context, (draft) => {
                draft.documentationQueryPlanByFile = {};
                draft.documentationByFile = {};
            });
        }

        try {
            // Single-sandbox-per-PR: reuse the lease-managed sandbox set up by
            // CreateSandboxStage (which runs earlier in the pipeline). When
            // the sandbox isn't available (e.g. no E2B configured, or trial
            // mode without auth) we fall back to manifest-only discovery via
            // the package discovery service — same behavior as before, just
            // without the redundant standalone sandbox creation.
            const remoteCommands = context.sandboxHandle?.remoteCommands;

            const discovery =
                await this.packageDiscoveryService.discoverPackages(context, {
                    remoteCommands,
                });

            if (!discovery.packages.length) {
                this.logger.log({
                    message:
                        'No packages discovered for documentation context stage',
                    context: this.stageName,
                    metadata: {
                        prNumber: context.pullRequest.number,
                        repository: context.repository.name,
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                    },
                });

                return this.updateContext(context, (draft) => {
                    draft.discoveredPackages = [];
                    draft.documentationQueryPlanByFile = {};
                    draft.documentationByFile = {};
                });
            }

            const documentationQueryPlanByFile =
                await this.llmPlannerService.planDocumentationByFile({
                    packages: discovery.packages,
                    changedFiles: codeFiles,
                    byokConfig: context.codeReviewConfig?.byokConfig,
                    organizationAndTeamData: context.organizationAndTeamData,
                });

            const hasPlannerQueries = Object.values(
                documentationQueryPlanByFile || {},
            ).some((plan) => (plan?.queryTasks || []).length > 0);

            if (!hasPlannerQueries) {
                this.logger.log({
                    message:
                        'Documentation planner returned no queries; skipping documentation retrieval stage',
                    context: this.stageName,
                    metadata: {
                        prNumber: context.pullRequest.number,
                        repository: context.repository.name,
                        discoveredPackages: discovery.packages.length,
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                    },
                });

                return this.updateContext(context, (draft) => {
                    draft.discoveredPackages = discovery.packages;
                    draft.documentationQueryPlanByFile =
                        documentationQueryPlanByFile;
                    draft.documentationByFile = {};
                });
            }

            const documentationByFile =
                await this.documentationSearchService.searchByFilePlan(
                    documentationQueryPlanByFile,
                    {
                        organizationAndTeamData:
                            context.organizationAndTeamData,
                        prNumber: context.pullRequest.number,
                        byokConfig: context.codeReviewConfig?.byokConfig,
                    },
                );

            this.logger.log({
                message: `Documentation context gathered for PR#${context.pullRequest.number}`,
                context: this.stageName,
                metadata: {
                    prNumber: context.pullRequest.number,
                    repository: context.repository.name,
                    discoveredPackages: discovery.packages.length,
                    manifestFiles: discovery.manifestFiles,
                    filesWithDocumentation:
                        Object.keys(documentationByFile).length,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });

            return this.updateContext(context, (draft) => {
                draft.discoveredPackages = discovery.packages;
                draft.documentationQueryPlanByFile =
                    documentationQueryPlanByFile;
                draft.documentationByFile = documentationByFile;
            });
        } catch (error) {
            this.logger.error({
                message:
                    'Failed to gather documentation context, continuing without documentation',
                context: this.stageName,
                error,
                metadata: {
                    prNumber: context.pullRequest.number,
                    repository: context.repository.name,
                    organizationAndTeamData: context.organizationAndTeamData,
                },
            });

            return context;
        }
        // Sandbox lifecycle is owned by SandboxLeaseManager (release →
        // pause); this stage doesn't manage cleanup anymore.
    }

    private isCodeFile(filePath: string): boolean {
        const extension = path.posix.extname(filePath).toLowerCase();

        if (!extension) {
            return false;
        }

        return Object.values(SUPPORTED_LANGUAGES).some((lang) =>
            lang.extensions.includes(extension),
        );
    }

    private async shouldRunDocumentationContext(
        context: CodeReviewPipelineContext,
    ): Promise<boolean> {
        const featureIdentifier =
            context.organizationAndTeamData?.organizationId ||
            context.organizationAndTeamData?.teamId ||
            'unknown';

        const isFeatureEnabled = await posthog.isFeatureEnabled(
            FEATURE_FLAGS.documentationContext,
            featureIdentifier,
            context.organizationAndTeamData,
        );

        const hasAPIKey = this.configService.get<string>('API_EXA_KEY');

        return !!hasAPIKey && isFeatureEnabled;
    }
}
