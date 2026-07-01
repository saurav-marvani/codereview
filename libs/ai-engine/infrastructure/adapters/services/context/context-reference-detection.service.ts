import { createHash } from 'crypto';

import type {
    ContextConsumerKind,
    ContextDependency,
    ContextDomain,
    ContextRequirement,
} from '@kodus/flow';
import { MCPServerConfig, createLogger } from '@kodus/flow';
import { BYOKConfig } from '@kodus/kodus-common/llm';
import { Inject, Injectable } from '@nestjs/common';
import {
    IPromptReferenceSyncError,
    PromptReferenceErrorType,
    PromptSourceType,
} from '@libs/ai-engine/domain/prompt/interfaces/promptExternalReference.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IPromptContextEngineService,
    PROMPT_CONTEXT_ENGINE_SERVICE_TOKEN,
} from '@libs/ai-engine/domain/prompt/contracts/promptContextEngine.contract';
import {
    CONTEXT_REFERENCE_SERVICE_TOKEN,
    IContextReferenceService,
} from '@libs/ai-engine/domain/contextReference/contracts/context-reference.service.contract';
import {
    MCPToolMetadata,
    MCPToolMetadataService,
} from '@libs/mcp-server/services/mcp-tool-metadata.service';

export interface ContextDetectionField {
    fieldId?: string;
    path: string[];
    sourceType: PromptSourceType | string;
    text: string;
    inlineMarkers?: string[];
    promptHash?: string;
    metadata?: Record<string, unknown>;
    consumerKind?: ContextConsumerKind;
    consumerName?: string;
    requestDomain?: ContextDomain;
    taskIntent?: string;
    conversationIdOverride?: string;
}

export interface ContextReferenceDetectionParams {
    entityType: 'kodyRule' | 'codeReviewConfig';
    entityId: string;
    fields: ContextDetectionField[];
    repositoryId?: string;
    repositoryName?: string;
    organizationAndTeamData: OrganizationAndTeamData;
    byokConfig?: BYOKConfig;
    subscriptionStatus?: string;
}

@Injectable()
export class ContextReferenceDetectionService {
    private readonly logger = createLogger(
        ContextReferenceDetectionService.name,
    );
    constructor(
        @Inject(PROMPT_CONTEXT_ENGINE_SERVICE_TOKEN)
        private readonly promptContextEngine: IPromptContextEngineService,
        @Inject(CONTEXT_REFERENCE_SERVICE_TOKEN)
        private readonly contextReferenceService: IContextReferenceService,
        private readonly mcpToolMetadataService: MCPToolMetadataService,
    ) {}

    async detectAndSaveReferences(
        params: ContextReferenceDetectionParams,
    ): Promise<string | undefined> {
        const {
            entityType,
            entityId,
            fields,
            repositoryId,
            repositoryName,
            organizationAndTeamData,
            byokConfig,
            subscriptionStatus,
        } = params;

        if (!fields || fields.length === 0) {
            this.logger.warn({
                message: 'No fields provided for context detection',
                context: ContextReferenceDetectionService.name,
                metadata: { entityType, entityId },
            });
            return undefined;
        }

        const preparedFields = fields
            .map((field) => ({
                ...field,
                text: field.text ?? '',
            }))
            .filter((field) => field.text.trim().length > 0);

        if (!preparedFields.length) {
            this.logger.warn({
                message: 'All provided fields are empty after trimming',
                context: ContextReferenceDetectionService.name,
                metadata: { entityType, entityId },
            });
            return undefined;
        }

        this.logger.log({
            message: `Starting context detection for ${entityType}`,
            context: ContextReferenceDetectionService.name,
            metadata: {
                entityType,
                entityId,
                repositoryId,
                fieldsCount: preparedFields.length,
            },
        });

        const requirements: ContextRequirement[] = [];
        const knowledgeRefsMap = new Map<
            string,
            { itemId: string; version?: string }
        >();
        const aggregatedSyncErrors: IPromptReferenceSyncError[] = [];

        for (const field of preparedFields) {
            const result = await this.processFieldDetection({
                entityType,
                entityId,
                field,
                repositoryId,
                repositoryName,
                organizationAndTeamData,
                byokConfig,
                subscriptionStatus,
            });

            if (!result) {
                continue;
            }

            requirements.push(result.requirement);

            for (const ref of result.knowledgeRefs) {
                if (!knowledgeRefsMap.has(ref.itemId)) {
                    knowledgeRefsMap.set(ref.itemId, ref);
                }
            }

            aggregatedSyncErrors.push(...result.syncErrors);
        }

        if (!requirements.length) {
            this.logger.warn({
                message: 'No requirements generated after processing fields',
                context: ContextReferenceDetectionService.name,
                metadata: { entityType, entityId },
            });
            return undefined;
        }

        const entityHash = this.calculateEntityHash(
            preparedFields.map((field) => field.text.trim()).join('\n:::\n'),
        );

        const knowledgeRefs = Array.from(knowledgeRefsMap.values());

        return this.saveToContextOS({
            entityType,
            entityId,
            requirements,
            knowledgeRefs,
            entityHash,
            aggregatedSyncErrors,
            organizationAndTeamData,
            repositoryId,
            repositoryName,
        });
    }

    private calculateEntityHash(text: string): string {
        return createHash('sha256').update(text).digest('hex');
    }

    private async processFieldDetection(params: {
        entityType: 'kodyRule' | 'codeReviewConfig';
        entityId: string;
        field: ContextDetectionField;
        repositoryId?: string;
        repositoryName?: string;
        organizationAndTeamData: OrganizationAndTeamData;
        byokConfig?: BYOKConfig;
        subscriptionStatus?: string;
    }): Promise<
        | {
              requirement: ContextRequirement;
              knowledgeRefs: Array<{ itemId: string; version?: string }>;
              syncErrors: IPromptReferenceSyncError[];
          }
        | undefined
    > {
        const {
            entityType,
            entityId,
            field,
            repositoryId,
            repositoryName,
            organizationAndTeamData,
            byokConfig,
            subscriptionStatus,
        } = params;

        const trimmedText = field.text.trim();
        if (!trimmedText) {
            return undefined;
        }

        const fieldKey = this.resolveFieldKey(field);
        const hasSuffix = !!fieldKey && fieldKey.length > 0;
        const requirementId = hasSuffix
            ? `${entityType}:${entityId}#${fieldKey}`
            : `${entityType}:${entityId}`;
        const consumerId = field.conversationIdOverride
            ? field.conversationIdOverride
            : hasSuffix
              ? `${entityId}#${fieldKey}`
              : entityId;
        const consumerKind: ContextConsumerKind =
            field.consumerKind ??
            (entityType === 'kodyRule' ? 'prompt' : 'prompt_section');
        const consumerName =
            field.consumerName ?? (hasSuffix ? fieldKey : entityId);
        const requestDomain: ContextDomain =
            field.requestDomain ??
            (entityType === 'kodyRule' ? ('code' as ContextDomain) : 'general');
        const taskIntent =
            field.taskIntent ?? `Process ${entityType} references`;

        let detectionReferences: Array<{
            filePath: string;
            description?: string;
            originalText?: string;
            lineRange?: { start: number; end: number };
            repositoryName?: string;
            repositoryId?: string;
            lastValidatedAt?: string | Date;
            lastContentHash?: string;
            estimatedTokens?: number;
        }> = [];
        let detectionSyncErrors: IPromptReferenceSyncError[] = [];

        const shouldAttemptDetection =
            this.hasLikelyExternalReferences(trimmedText) ||
            entityType === 'kodyRule';

        if (shouldAttemptDetection) {
            const detection = await this.detectAndResolveReferences({
                text: trimmedText,
                path: field.path,
                sourceType: field.sourceType,
                entityType,
                repositoryId,
                repositoryName,
                organizationAndTeamData,
                byokConfig,
                subscriptionStatus,
                fieldId: fieldKey,
            });

            detectionReferences = detection.references;
            detectionSyncErrors = detection.syncErrors;
        } else {
            this.logger.debug({
                message: 'Skipping detection due to lack of reference patterns',
                context: ContextReferenceDetectionService.name,
                metadata: {
                    entityType,
                    entityId,
                    fieldKey,
                },
            });
        }

        const normalization = await this.applyFullMCPNormalization({
            references: detectionReferences,
            syncErrors: detectionSyncErrors,
            organizationAndTeamData,
            entityType,
            repositoryName,
            repositoryId,
        });

        const dependencies = normalization.dependencies;
        const syncErrors = normalization.syncErrors;

        if (dependencies.length === 0 && syncErrors.length === 0) {
            this.logger.debug({
                message: 'Skipping field without dependencies or sync errors',
                context: ContextReferenceDetectionService.name,
                metadata: {
                    entityType,
                    entityId,
                    fieldKey,
                },
            });
            return undefined;
        }

        const knowledgeRefs = this.extractKnowledgeRefs(dependencies);

        const requirementMetadata: Record<string, unknown> = {
            source: entityType,
            entityHash: this.calculateEntityHash(trimmedText),
            path: field.path,
            sourceType: field.sourceType,
            sourceSnippet: field.metadata?.sourceSnippet ?? trimmedText,
        };

        if (field.inlineMarkers?.length) {
            requirementMetadata.inlineMarkers = Array.from(
                new Set(field.inlineMarkers),
            );
        }

        if (field.promptHash) {
            requirementMetadata.promptHash = field.promptHash;
        }

        if (field.metadata) {
            const { sourceSnippet: _ignoredSnippet, ...rest } = field.metadata;
            Object.assign(requirementMetadata, rest);
        }

        if (syncErrors.length) {
            requirementMetadata.syncErrors = syncErrors;
        }

        const consumerMetadata: Record<string, unknown> = {
            path: field.path,
            sourceType: field.sourceType,
        };

        const requirement: ContextRequirement = {
            id: requirementId,
            consumer: {
                kind: consumerKind,
                id: consumerId,
                name: consumerName,
                metadata: consumerMetadata,
            },
            request: {
                domain: requestDomain,
                taskIntent,
                signal: {
                    conversationId: consumerId,
                    metadata: {
                        path: field.path,
                        sourceType: field.sourceType,
                    },
                },
            },
            dependencies,
            status: syncErrors.length > 0 ? 'draft' : 'active',
            metadata: requirementMetadata,
        };

        this.logger.debug({
            message: 'Built requirement for field',
            context: ContextReferenceDetectionService.name,
            metadata: {
                requirementId,
                dependencyCount: dependencies.length,
                syncErrors: syncErrors.length,
            },
        });

        return {
            requirement,
            knowledgeRefs,
            syncErrors,
        };
    }

    private resolveFieldKey(field: ContextDetectionField): string {
        if (field.fieldId !== undefined) {
            return field.fieldId.trim();
        }

        return this.buildPathKey(field.path);
    }

    private buildPathKey(path: string[]): string {
        if (!path || path.length === 0) {
            return '';
        }

        return path.join('.');
    }

    private extractKnowledgeRefs(
        dependencies: ContextDependency[],
    ): Array<{ itemId: string; version?: string }> {
        const refs: Array<{ itemId: string; version?: string }> = [];

        for (const dependency of dependencies) {
            if (dependency.type !== 'knowledge') {
                continue;
            }

            const metadata =
                (dependency.metadata as Record<string, unknown> | undefined) ??
                {};
            const repositoryId = metadata.repositoryId as string | undefined;
            const repositoryName = metadata.repositoryName as
                | string
                | undefined;
            const filePath =
                (metadata.filePath as string | undefined) ??
                (typeof dependency.id === 'string' ? dependency.id : 'unknown');

            const baseId =
                typeof dependency.id === 'string' && dependency.id.includes('|')
                    ? dependency.id
                    : `${repositoryId ?? repositoryName ?? 'unknown'}|${filePath}`;

            const version =
                (metadata.version as string | undefined) ??
                (metadata.lastContentHash as string | undefined);

            refs.push({ itemId: baseId, version });
        }

        return refs;
    }

    private hasLikelyExternalReferences(text: string): boolean {
        const patterns = [
            /@file[:\s]/i,
            /\[\[file:/i,
            /@\w+\.(ts|js|py|md|yml|yaml|json|txt|go|java|cpp|c|h|rs)/i,

            /refer to.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /check.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /see.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /use.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /read.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /open.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /examine.*\.(ts|js|py|md|yml|yaml|json|txt)/i,

            /\b\w+\.\w+\.(ts|js|py|md|yml|yaml|json|txt)\b/i,
            /\b[A-Z_][A-Z0-9_]*\.(ts|js|py|md|yml|yaml|json|txt)\b/,

            /\b(readme|contributing|changelog|license|setup|config|package|tsconfig|jest\.config|vite\.config|webpack\.config|dockerfile|makefile)\b/i,

            /src\//i,
            /lib\//i,
            /test\//i,
            /docs\//i,
            /config\//i,

            /@mcp/i,
            /mcp:/i,
        ];
        return patterns.some((pattern) => pattern.test(text));
    }

    private async detectAndResolveReferences(params: {
        text: string;
        path: string[];
        sourceType: any;
        entityType: 'kodyRule' | 'codeReviewConfig';
        repositoryId?: string;
        repositoryName?: string;
        organizationAndTeamData: OrganizationAndTeamData;
        byokConfig?: BYOKConfig;
        subscriptionStatus?: string;
        fieldId?: string;
    }): Promise<{
        references: Array<{
            filePath: string;
            description?: string;
            originalText?: string;
            lineRange?: { start: number; end: number };
            repositoryName?: string;
            repositoryId?: string;
        }>;
        syncErrors: IPromptReferenceSyncError[];
    }> {
        const detection =
            await this.promptContextEngine.detectAndResolveReferences({
                requirementId:
                    params.fieldId && params.fieldId.length > 0
                        ? `field-detection:${params.fieldId}`
                        : `unified-detection-${Date.now()}`,
                promptText: params.text,
                path: params.path,
                sourceType: params.sourceType,
                repositoryId: params.repositoryId,
                repositoryName: params.repositoryName,
                organizationAndTeamData: params.organizationAndTeamData,
                context:
                    params.entityType === 'codeReviewConfig'
                        ? 'instruction'
                        : 'rule',
                detectionMode:
                    params.entityType === 'kodyRule' ? 'rule' : 'prompt',
                byokConfig: params.byokConfig,
                subscriptionStatus: params.subscriptionStatus,
            });

        const allDependencies: ContextDependency[] =
            detection.requirements && detection.requirements.length > 0
                ? [...(detection.requirements[0].dependencies || [])]
                : [];

        const references = allDependencies.map((dep) => {
            if (dep.type === 'mcp') {
                return {
                    filePath: dep.id,
                    description: dep.metadata?.description as string,
                    originalText: dep.metadata?.originalText as string,
                    repositoryName: undefined,
                    repositoryId: undefined,
                    lineRange: undefined,
                    lastValidatedAt: undefined,
                    lastContentHash: undefined,
                    estimatedTokens: undefined,
                };
            }

            const resolvedRepositoryName =
                (dep.metadata?.repositoryName as string | undefined) ??
                params.repositoryName;
            const resolvedRepositoryId =
                (dep.metadata?.repositoryId as string | undefined) ??
                params.repositoryId;

            return {
                filePath: (dep.metadata?.filePath as string) || dep.id,
                description: dep.metadata?.description as string,
                originalText: dep.metadata?.originalText as string,
                repositoryName: resolvedRepositoryName,
                repositoryId: resolvedRepositoryId,
                lineRange: dep.metadata?.lineRange as
                    | { start: number; end: number }
                    | undefined,
                lastValidatedAt: dep.metadata?.lastValidatedAt as
                    | string
                    | Date
                    | undefined,
                lastContentHash: dep.metadata?.lastContentHash as
                    | string
                    | undefined,
                estimatedTokens: dep.metadata?.estimatedTokens as
                    | number
                    | undefined,
            };
        });

        this.logger.log({
            message: `Detected ${references.length} references for ${params.entityType}`,
            context: ContextReferenceDetectionService.name,
            metadata: {
                entityType: params.entityType,
                entityId: params.fieldId ?? params.entityType,
                referenceCount: references.length,
                references: references.map((r) => ({
                    filePath: r.filePath,
                    hasDescription: !!r.description,
                })),
            },
        });

        return {
            references,
            syncErrors: detection.syncErrors || [],
        };
    }

    private async applyFullMCPNormalization(params: {
        references: Array<{
            filePath: string;
            description?: string;
            originalText?: string;
            lineRange?: { start: number; end: number };
            repositoryName?: string;
            repositoryId?: string;
            lastValidatedAt?: string | Date;
            lastContentHash?: string;
            estimatedTokens?: number;
        }>;
        syncErrors: IPromptReferenceSyncError[];
        organizationAndTeamData: OrganizationAndTeamData;
        entityType: 'kodyRule' | 'codeReviewConfig';
        repositoryName?: string;
        repositoryId?: string;
    }): Promise<{
        dependencies: ContextDependency[];
        syncErrors: IPromptReferenceSyncError[];
    }> {
        const {
            references,
            syncErrors,
            organizationAndTeamData,
            entityType,
            repositoryName,
            repositoryId,
        } = params;

        const dependenciesInput: ContextDependency[] = references.map((ref) => {
            if (ref.filePath.includes('|')) {
                const [provider, tool] = ref.filePath.split('|', 2);
                return {
                    type: 'mcp' as const,
                    id: ref.filePath,
                    metadata: {
                        provider,
                        toolName: tool,
                        description: ref.description,
                        originalText: ref.originalText,
                        detectedAt: new Date(),
                    },
                } satisfies ContextDependency;
            }

            const knowledgeId = ref.repositoryId
                ? `${ref.repositoryId}|${ref.filePath}`
                : ref.repositoryName
                  ? `${ref.repositoryName}|${ref.filePath}`
                  : ref.filePath;

            return {
                type: 'knowledge' as const,
                id: knowledgeId,
                metadata: {
                    filePath: ref.filePath,
                    description: ref.description,
                    originalText: ref.originalText,
                    repositoryName: ref.repositoryName ?? repositoryName,
                    repositoryId: ref.repositoryId ?? repositoryId,
                    lineRange: ref.lineRange,
                    lastValidatedAt: ref.lastValidatedAt
                        ? new Date(ref.lastValidatedAt)
                        : undefined,
                    lastContentHash: ref.lastContentHash,
                    estimatedTokens: ref.estimatedTokens,
                    detectedAt: new Date(),
                },
            } satisfies ContextDependency;
        });

        if (!dependenciesInput.some((dep) => dep.type === 'mcp')) {
            return { dependencies: dependenciesInput, syncErrors };
        }

        const { connections: mcpConnections, metadata: toolMetadata } =
            await this.mcpToolMetadataService.loadMetadataForOrganization(
                organizationAndTeamData,
            );

        const { providerAliases, toolAliases, allowedTools } =
            this.buildMCPAliasStructures(mcpConnections);

        const normalizedDependencies = this.normalizeMCPDependencies(
            dependenciesInput,
            providerAliases,
            toolAliases,
            allowedTools,
            toolMetadata,
            mcpConnections,
        );

        const allSyncErrors = [...syncErrors, ...normalizedDependencies.errors];

        return {
            dependencies: normalizedDependencies.dependencies,
            syncErrors: allSyncErrors,
        };
    }

    private buildMCPAliasStructures(connections: MCPServerConfig[]): {
        providerAliases: Map<string, string>;
        toolAliases: Map<string, Map<string, string>>;
        allowedTools: Map<string, Set<string>>;
    } {
        const providerAliases = new Map<string, string>();
        const toolAliases = new Map<string, Map<string, string>>();
        const allowedTools = new Map<string, Set<string>>();

        const registerProviderAlias = (
            alias: string | undefined,
            canonical: string,
        ) => {
            const trimmed = alias?.trim();
            if (!trimmed) {
                return;
            }
            if (!providerAliases.has(trimmed)) {
                providerAliases.set(trimmed, canonical);
            }
            const normalized = this.normalizeProviderKey(trimmed);
            if (normalized && !providerAliases.has(normalized)) {
                providerAliases.set(normalized, canonical);
            }
        };

        const registerToolAlias = (
            aliasMap: Map<string, string>,
            canonicalTool: string,
        ) => {
            const trimmed = canonicalTool?.trim();
            if (!trimmed) {
                return;
            }

            if (!aliasMap.has(trimmed)) {
                aliasMap.set(trimmed, trimmed);
            }

            const lower = trimmed.toLowerCase();
            if (!aliasMap.has(lower)) {
                aliasMap.set(lower, trimmed);
            }

            const upper = trimmed.toUpperCase();
            if (!aliasMap.has(upper)) {
                aliasMap.set(upper, trimmed);
            }

            const normalized = this.normalizeToolKey(trimmed);
            if (normalized && !aliasMap.has(normalized)) {
                aliasMap.set(normalized, trimmed);
            }
        };

        for (const connection of connections ?? []) {
            const canonicalProvider =
                connection.provider?.trim() ||
                connection.name?.trim() ||
                connection.url?.trim();

            if (!canonicalProvider) {
                continue;
            }

            registerProviderAlias(canonicalProvider, canonicalProvider);
            registerProviderAlias(connection.provider, canonicalProvider);
            registerProviderAlias(connection.name, canonicalProvider);
            registerProviderAlias(connection.url, canonicalProvider);

            if (!allowedTools.has(canonicalProvider)) {
                allowedTools.set(canonicalProvider, new Set());
            }

            if (!toolAliases.has(canonicalProvider)) {
                toolAliases.set(canonicalProvider, new Map());
            }

            const aliasMap = toolAliases.get(canonicalProvider)!;
            const providerAllowedTools = allowedTools.get(canonicalProvider)!;

            for (const tool of connection.allowedTools ?? []) {
                const canonicalTool = tool?.trim();
                if (!canonicalTool) {
                    continue;
                }

                providerAllowedTools.add(canonicalTool);
                registerToolAlias(aliasMap, canonicalTool);
            }
        }

        return { providerAliases, toolAliases, allowedTools };
    }

    private normalizeMCPDependencies(
        dependencies: ContextDependency[] | undefined,
        providerAliases: Map<string, string>,
        toolAliases: Map<string, Map<string, string>>,
        allowedTools: Map<string, Set<string>>,
        toolMetadata: Map<string, MCPToolMetadata>,
        mcpConnections: MCPServerConfig[],
    ): {
        dependencies: ContextDependency[];
        errors: IPromptReferenceSyncError[];
    } {
        if (!dependencies?.length) {
            return { dependencies: [], errors: [] };
        }

        const merged: ContextDependency[] = [];
        const errors: IPromptReferenceSyncError[] = [];

        for (const dependency of dependencies) {
            const normalized = this.normalizeDependency(
                dependency,
                providerAliases,
                toolAliases,
                allowedTools,
                mcpConnections,
            );
            if (normalized.errors.length) {
                errors.push(...normalized.errors);
            }
            if (normalized.dependency) {
                const enriched = this.applyToolMetadata(
                    normalized.dependency,
                    toolMetadata,
                    providerAliases,
                    toolAliases,
                );
                merged.push(enriched);
            }
        }

        return { dependencies: merged, errors };
    }

    private normalizeDependency(
        dependency: ContextDependency,
        providerAliases: Map<string, string>,
        toolAliases: Map<string, Map<string, string>>,
        allowedTools: Map<string, Set<string>>,
        mcpConnections: MCPServerConfig[],
    ): {
        dependency?: ContextDependency;
        errors: IPromptReferenceSyncError[];
    } {
        if (dependency.type !== 'mcp' && dependency.type !== 'tool') {
            return { dependency, errors: [] };
        }

        const originalProvider = this.resolveDependencyProvider(dependency);
        const connection = originalProvider
            ? this.findConnectionByAlias(originalProvider, mcpConnections)
            : undefined;

        const canonicalProvider = connection?.provider?.trim();

        const errors: IPromptReferenceSyncError[] = [];

        const finalProvider =
            canonicalProvider ??
            (originalProvider && allowedTools.has(originalProvider)
                ? originalProvider
                : undefined);

        if (!finalProvider) {
            if (originalProvider) {
                errors.push({
                    type: PromptReferenceErrorType.INVALID_FORMAT,
                    message: `MCP provider "${originalProvider}" is not configured for this organization/team. Adjust the prompt or enable the corresponding connection.`,
                    details: {
                        timestamp: new Date(),
                    },
                });
            }
            return { dependency: undefined, errors };
        }

        const originalTool = this.resolveDependencyToolName(dependency);
        const canonicalTool = this.resolveCanonicalTool(
            originalTool,
            finalProvider,
            toolAliases,
        );
        const finalTool = canonicalTool ?? originalTool;

        const metadata: Record<string, unknown> = {
            ...(dependency.metadata ?? {}),
        };

        if (connection?.name) {
            metadata.providerName = connection.name;
        }

        metadata.provider = finalProvider;
        if (
            originalProvider &&
            originalProvider !== finalProvider &&
            !metadata.providerAlias
        ) {
            metadata.providerAlias = originalProvider;
        }

        if (finalTool) {
            metadata.toolName = finalTool;
        }
        if (
            originalTool &&
            finalTool &&
            originalTool !== finalTool &&
            !metadata.toolNameAlias
        ) {
            metadata.toolNameAlias = originalTool;
        }

        if (!finalTool && originalTool) {
            const available = allowedTools.get(finalProvider);
            const availableList = available
                ? Array.from(available.values()).join(', ')
                : 'no tools registered';

            errors.push({
                type: PromptReferenceErrorType.INVALID_FORMAT,
                message: `Tool "${originalTool}" is not enabled for MCP provider "${finalProvider}". Available tools: ${availableList}.`,
                details: {
                    timestamp: new Date(),
                },
            });
            return { dependency: undefined, errors };
        }

        let descriptor = dependency.descriptor;
        if (descriptor && typeof descriptor === 'object') {
            const candidate = descriptor as Record<string, unknown>;
            descriptor = {
                ...candidate,
                mcpId: finalProvider,
                ...(finalTool ? { toolName: finalTool } : {}),
            };
        }

        let normalizedId = dependency.id;
        if (finalTool) {
            normalizedId = `${finalProvider}|${finalTool}`;
        } else if (
            typeof normalizedId === 'string' &&
            normalizedId.includes('|')
        ) {
            const [, tool] = normalizedId.split('|', 2);
            normalizedId = tool ? `${finalProvider}|${tool}` : finalProvider;
        } else {
            normalizedId = finalProvider;
        }

        return {
            dependency: {
                ...dependency,
                id: normalizedId,
                metadata,
                descriptor,
            },
            errors,
        };
    }

    private applyToolMetadata(
        dependency: ContextDependency,
        metadataMap: Map<string, MCPToolMetadata>,
        providerAliases: Map<string, string>,
        toolAliases: Map<string, Map<string, string>>,
    ): ContextDependency {
        const provider = this.resolveDependencyProvider(dependency);
        const toolName = this.resolveDependencyToolName(dependency);

        if (!provider || !toolName) {
            return dependency;
        }

        const canonicalProvider =
            this.resolveCanonicalProvider(provider, providerAliases) ??
            provider;
        const canonicalToolName =
            this.resolveCanonicalTool(
                toolName,
                canonicalProvider,
                toolAliases,
            ) ?? toolName;

        const metadataEntry = this.mcpToolMetadataService.resolveToolMetadata(
            metadataMap,
            canonicalProvider,
            canonicalToolName,
        );

        const resolvedProvider = metadataEntry?.providerId ?? canonicalProvider;
        const resolvedToolName = metadataEntry?.toolName ?? canonicalToolName;
        const metadata = metadataEntry?.metadata;

        if (!metadata) {
            return dependency;
        }

        const currentMetadata = (dependency.metadata ?? {}) as Record<
            string,
            unknown
        >;
        const existingRequired = Array.isArray(currentMetadata.requiredArgs)
            ? (currentMetadata.requiredArgs as string[])
            : [];
        const mergedRequired = Array.from(
            new Set([...existingRequired, ...metadata.requiredArgs]),
        );

        const mergedMetadata = {
            ...currentMetadata,
            requiredArgs: mergedRequired,
            toolInputSchema: metadata.inputSchema,
            provider: resolvedProvider,
            toolName: resolvedToolName,
        } as Record<string, unknown>;

        if (
            provider &&
            resolvedProvider &&
            provider !== resolvedProvider &&
            !mergedMetadata.providerAlias
        ) {
            mergedMetadata.providerAlias = provider;
        }

        if (
            toolName &&
            resolvedToolName &&
            toolName !== resolvedToolName &&
            !mergedMetadata.toolNameAlias
        ) {
            mergedMetadata.toolNameAlias = toolName;
        }

        let descriptor = dependency.descriptor;
        if (descriptor && typeof descriptor === 'object') {
            const candidate = descriptor as Record<string, unknown>;
            descriptor = {
                ...candidate,
                mcpId: resolvedProvider,
                toolName: resolvedToolName,
            };
        }

        return {
            ...dependency,
            id: `${resolvedProvider}|${resolvedToolName}`,
            metadata: mergedMetadata,
            descriptor,
        };
    }

    private resolveCanonicalProvider(
        provider: string,
        aliasMap: Map<string, string>,
    ): string | undefined {
        const trimmed = provider?.trim();
        if (!trimmed) {
            return undefined;
        }

        if (aliasMap.has(trimmed)) {
            return aliasMap.get(trimmed);
        }

        const key = this.normalizeProviderKey(trimmed);
        if (key && aliasMap.has(key)) {
            return aliasMap.get(key);
        }

        return undefined;
    }

    private resolveCanonicalTool(
        toolName: string | undefined,
        provider: string,
        toolAliases: Map<string, Map<string, string>>,
    ): string | undefined {
        if (!toolName) {
            return undefined;
        }

        const trimmedProvider = provider?.trim();
        if (!trimmedProvider) {
            return undefined;
        }

        const aliasMap = toolAliases.get(trimmedProvider);

        if (!aliasMap) {
            return undefined;
        }

        const trimmedTool = toolName.trim();
        if (!trimmedTool) {
            return undefined;
        }

        if (aliasMap.has(trimmedTool)) {
            return aliasMap.get(trimmedTool);
        }

        const lower = trimmedTool.toLowerCase();
        if (aliasMap.has(lower)) {
            return aliasMap.get(lower);
        }

        const upper = trimmedTool.toUpperCase();
        if (aliasMap.has(upper)) {
            return aliasMap.get(upper);
        }

        const normalized = this.normalizeToolKey(trimmedTool);
        if (normalized && aliasMap.has(normalized)) {
            return aliasMap.get(normalized);
        }

        return undefined;
    }

    private resolveDependencyProvider(
        dependency: ContextDependency,
    ): string | undefined {
        const metadata = dependency.metadata as
            | Record<string, unknown>
            | undefined;

        if (metadata) {
            const provider = metadata.provider as string | undefined;
            if (provider && provider.trim()) {
                return provider;
            }

            const providerAlias = metadata.providerAlias as string | undefined;
            if (providerAlias && providerAlias.trim()) {
                return providerAlias;
            }
        }

        if (
            dependency.descriptor &&
            typeof dependency.descriptor === 'object'
        ) {
            const candidate = dependency.descriptor as Record<string, unknown>;
            const descriptorProvider = candidate.mcpId as string | undefined;
            if (descriptorProvider && descriptorProvider.trim()) {
                return descriptorProvider;
            }
        }

        if (typeof dependency.id === 'string' && dependency.id.includes('|')) {
            const [providerId] = dependency.id.split('|', 2);
            if (providerId && providerId.trim()) {
                return providerId;
            }
        }

        return undefined;
    }

    private resolveDependencyToolName(
        dependency: ContextDependency,
    ): string | undefined {
        const metadata = dependency.metadata as
            | Record<string, unknown>
            | undefined;

        if (metadata && typeof metadata.toolName === 'string') {
            return metadata.toolName;
        }

        if (
            dependency.descriptor &&
            typeof dependency.descriptor === 'object'
        ) {
            const candidate = dependency.descriptor as Record<string, unknown>;
            if (typeof candidate.toolName === 'string') {
                return candidate.toolName;
            }
        }

        if (typeof dependency.id === 'string' && dependency.id.includes('|')) {
            const [, tool] = dependency.id.split('|', 2);
            if (tool && tool.trim()) {
                return tool;
            }
        }

        return undefined;
    }

    private normalizeProviderKey(value?: string | null): string | undefined {
        if (!value) {
            return undefined;
        }

        const normalized = value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');

        if (!normalized) {
            return undefined;
        }

        return normalized.endsWith('mcp') && normalized.length > 3
            ? normalized.slice(0, -3)
            : normalized;
    }

    private normalizeToolKey(value?: string | null): string | undefined {
        if (!value) {
            return undefined;
        }

        const normalized = value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');

        return normalized || undefined;
    }

    private findConnectionByAlias(
        alias: string,
        mcpConnections: MCPServerConfig[],
    ): MCPServerConfig | undefined {
        const normalizedAlias = this.normalizeProviderKey(alias);
        if (!normalizedAlias) {
            return undefined;
        }

        for (const connection of mcpConnections) {
            const candidates = [
                connection.name,
                connection.provider,
                connection.url,
            ];
            for (const candidate of candidates) {
                if (this.normalizeProviderKey(candidate) === normalizedAlias) {
                    return connection;
                }
            }
        }

        return undefined;
    }

    private buildScopePath(
        scopeLevel: string,
        organizationId: string,
        teamId?: string,
        repositoryId?: string,
    ): Array<{ level: string; id: string }> {
        const path: Array<{ level: string; id: string }> = [
            { level: 'organization', id: organizationId },
        ];

        if (teamId) {
            path.push({ level: 'team', id: teamId });
        }

        if (scopeLevel === 'repository' && repositoryId) {
            path.push({ level: 'repository', id: repositoryId });
        }

        return path;
    }

    private async saveToContextOS(params: {
        entityType: 'kodyRule' | 'codeReviewConfig';
        entityId: string;
        entityHash: string;
        requirements: ContextRequirement[];
        knowledgeRefs: Array<{ itemId: string; version?: string }>;
        aggregatedSyncErrors: IPromptReferenceSyncError[];
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId?: string;
        repositoryName?: string;
    }): Promise<string> {
        const {
            entityType,
            entityId,
            entityHash,
            requirements,
            knowledgeRefs,
            aggregatedSyncErrors,
            organizationAndTeamData,
            repositoryId,
            repositoryName,
        } = params;

        const isGlobalScope = !repositoryId || repositoryId === 'global';
        const scopeLevel = isGlobalScope ? 'organization' : 'repository';
        const scopePath = this.buildScopePath(
            scopeLevel,
            organizationAndTeamData.organizationId,
            organizationAndTeamData.teamId,
            isGlobalScope ? undefined : repositoryId,
        );

        const scope = {
            level: scopeLevel,
            identifiers: {
                tenantId: organizationAndTeamData.organizationId,
                organizationId: organizationAndTeamData.organizationId,
                ...(organizationAndTeamData.teamId && {
                    teamId: organizationAndTeamData.teamId,
                }),
                ...(!isGlobalScope && { repositoryId }),
            },
            path: scopePath,
            metadata: { source: entityType },
        };

        const previousReference =
            await this.contextReferenceService.getLatestRevision(
                entityType,
                entityId,
            );

        const revisionId = `rev:${entityType}:${entityId}:${Date.now()}`;
        const result = await this.contextReferenceService.commitRevision({
            scope,
            entityType,
            entityId,
            requirements,
            origin: { kind: 'system', id: 'kody-system' },
            revisionId,
            parentReferenceId: previousReference?.uuid,
            knowledgeRefs: knowledgeRefs.length ? knowledgeRefs : undefined,
            metadata: {
                source: entityType,
                repositoryId: repositoryId ?? 'global',
                repositoryName,
                entityHash,
                requirementsCount: requirements.length,
                syncErrorsCount: aggregatedSyncErrors.length,
                syncErrors:
                    aggregatedSyncErrors.length > 0
                        ? aggregatedSyncErrors
                        : undefined,
            },
        });

        this.logger.log({
            message: `Successfully saved unified references to Context OS`,
            context: ContextReferenceDetectionService.name,
            metadata: {
                entityType,
                entityId,
                contextReferenceId: result.pointer.uuid,
                requirementsCount: requirements.length,
                knowledgeRefsCount: knowledgeRefs.length,
            },
        });

        return result.pointer.uuid;
    }
}
