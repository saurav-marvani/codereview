import { ContextDependency } from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';
import { createLogger } from '@libs/core/log/logger';
import { BYOKConfig } from '@kodus/kodus-common/llm';
import { Injectable } from '@nestjs/common';

import {
    IDetectedReference,
    IFileReference,
} from '@libs/ai-engine/domain/prompt/interfaces/promptExternalReference.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { buildLangfuseTelemetry } from '@libs/core/log/langfuse';
import {
    prompt_detect_external_references_system,
    prompt_detect_external_references_user,
} from '@libs/common/utils/langchainCommon/prompts/externalReferences';
import {
    prompt_kodyrules_detect_references_system,
    prompt_kodyrules_detect_references_user,
} from '@libs/common/utils/langchainCommon/prompts/kodyRulesExternalReferences';
import { extractJsonFromResponse } from '@libs/common/utils/prompt-parser.utils';
import { byokToVercelModel, getModelName } from '@libs/llm/byok-to-vercel';
import { tracedGenerateText as generateText } from '@libs/llm/llm-call';

// Trial-only override: while the org is in the 14-day subscription trial
// and hasn't wired a BYOK key, route reference detection through Moonshot's
// Kimi K2.6 so we don't burn the expensive production default on Kodus's
// dime. Off-trial callers get no override, so byokToVercelModel falls back
// to the production default (cloud) or API_LLM_PROVIDER_MODEL (self-hosted).
// Any BYOK config takes precedence over this in every case.
const TRIAL_MODEL_OVERRIDE = 'kimi-k2.6';

/**
 * Kodus control markers are instructions to the sync engine, never file
 * references. They must be filtered from EVERY detection path — both the
 * regex marker extraction and the LLM-based detector (which happily
 * returns "@kody-sync" as a file); the miss on the LLM path kept stamping
 * spurious 'file not found: @kody-sync' sync errors on every rule synced
 * via the marker.
 */
const KODUS_CONTROL_MARKERS = new Set(['@kody-sync', '@kody-ignore']);

function isControlMarker(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    // Compare the BASENAME: the LLM detector emits the marker with a
    // fabricated repo prefix ("kody-sync/@kody-sync" — observed in
    // production sync errors), so an exact-string check misses it.
    const normalized = value.trim().toLowerCase().replace(/[.]+$/, '');
    const basename = normalized.split('/').pop() ?? normalized;
    return (
        KODUS_CONTROL_MARKERS.has(normalized) ||
        KODUS_CONTROL_MARKERS.has(basename)
    );
}

export interface DetectReferencesParams {
    requirementId: string;
    promptText: string;
    organizationAndTeamData: OrganizationAndTeamData;
    context?: 'rule' | 'instruction' | 'prompt';
    detectionMode?: 'rule' | 'prompt';
    byokConfig?: BYOKConfig;
    subscriptionStatus?: string;
}

@Injectable()
export class ReferenceDetectorService {
    private readonly logger = createLogger(ReferenceDetectorService.name);

    hasLikelyExternalReferences(promptText: string): boolean {
        const patterns = [
            /@file[:\s]/i,
            /\[\[file:/i,
            /@\w+\.(ts|js|py|md|yml|yaml|json|txt|go|java|cpp|c|h|rs)/i,
            /refer to.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /check.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /see.*\.(ts|js|py|md|yml|yaml|json|txt)/i,
            /\b\w+\.\w+\.(ts|js|py|md|yml|yaml|json|txt)\b/i,
            /\b[A-Z_][A-Z0-9_]*\.(ts|js|py|md|yml|yaml|json|txt)\b/,
            /\b(readme|contributing|changelog|license|setup|config|package|tsconfig|jest\.config|vite\.config|webpack\.config)\.(md|json|yml|yaml|ts|js)\b/i,
        ];

        return patterns.some((pattern) => pattern.test(promptText));
    }

    async detectReferences(
        params: DetectReferencesParams,
    ): Promise<IDetectedReference[]> {
        const { organizationAndTeamData } = params;

        const defaultModelOverride =
            params.subscriptionStatus === 'trial'
                ? TRIAL_MODEL_OVERRIDE
                : undefined;

        const model = byokToVercelModel(
            params.byokConfig,
            'main',
            {},
            defaultModelOverride,
        );

        const resolvedModelName = getModelName(
            params.byokConfig,
            defaultModelOverride,
        );
        this.logger.log({
            message: `[REF-DETECTOR-DEBUG] Resolved model: ${resolvedModelName}`,
            context: ReferenceDetectorService.name,
            metadata: {
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                requirementId: params.requirementId,
                subscriptionStatus: params.subscriptionStatus,
                hasByok: !!params.byokConfig,
                byokMainProvider: params.byokConfig?.main?.provider,
                byokMainModel: params.byokConfig?.main?.model,
                defaultModelOverride,
                resolvedModelName,
            },
        });

        const isRuleMode = params.detectionMode === 'rule';
        const systemPrompt = isRuleMode
            ? prompt_kodyrules_detect_references_system()
            : prompt_detect_external_references_system();
        const userPrompt = isRuleMode
            ? prompt_kodyrules_detect_references_user({
                  rule: params.promptText,
              })
            : prompt_detect_external_references_user({
                  text: params.promptText,
                  context: params.context,
              });

        const result = await generateText({
            model,
            system: systemPrompt,
            prompt: userPrompt,
            experimental_telemetry: buildLangfuseTelemetry(
                'detectExternalReferences',
                {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                },
            ),
        });

        const raw = result.text;
        if (!raw) {
            return [];
        }

        const parsedRaw = extractJsonFromResponse(raw);
        if (!parsedRaw || !Array.isArray(parsedRaw)) {
            return [];
        }
        const parsed = parsedRaw.filter(
            (ref: any) =>
                !isControlMarker(ref?.filePath) &&
                !isControlMarker(ref?.fileName) &&
                !isControlMarker(ref?.originalText),
        );
        // Temporary tracer for the @kody-sync ghost: shows exactly what the
        // model emitted and what survived the control-marker filter.
        this.logger.log({
            message: `[REF-DETECTOR-TRACE] raw=${parsedRaw.length} kept=${parsed.length} rawRefs=${JSON.stringify(parsedRaw.map((r: any) => ({ f: r?.fileName ?? r?.filePath, o: r?.originalText, repo: r?.repositoryName }))).slice(0, 800)}`,
            context: ReferenceDetectorService.name,
        });

        this.logger.debug({
            message: 'Detected external references',
            context: ReferenceDetectorService.name,
            metadata: {
                referencesCount: parsed.length,
                organizationAndTeamData,
                requirementId: params.requirementId,
            },
        });

        return parsed as IDetectedReference[];
    }

    extractMarkers(promptText: string, references: IFileReference[]): string[] {
        const markers = new Set<string>();

        for (const reference of references) {
            if (reference.originalText) {
                markers.add(reference.originalText);
            }
        }

        const fileRegex = /@[A-Za-z0-9/_\-.]+/g;
        const fileMatches = promptText.match(fileRegex);
        if (fileMatches) {
            fileMatches
                .filter((match) => !isControlMarker(match))
                .forEach((match) => markers.add(match));
        }

        // Detect MCP markers: @mcp<app|tool>
        const mcpRegex = /@mcp<([^|>]+)\|([^>]+)>/g;
        let mcpMatch;
        while ((mcpMatch = mcpRegex.exec(promptText)) !== null) {
            markers.add(mcpMatch[0]); // Add the full @mcp<app|tool> marker
        }

        return Array.from(markers.values());
    }

    extractMCPDependencies(
        text: string,
        repositoryId: string,
    ): ContextDependency[] {
        const mcpDependencies: ContextDependency[] = [];
        const mcpRegex = /@mcp<([^|>]+)\|([^>]+)>/g;
        let match;

        this.logger.debug({
            message: 'Extracting MCP dependencies from text',
            context: ReferenceDetectorService.name,
            metadata: {
                textLength: text.length,
                textSnippet: text.substring(0, 200),
                repositoryId,
            },
        });

        while ((match = mcpRegex.exec(text)) !== null) {
            const [fullMatch, app, tool] = match;
            this.logger.log({
                message: 'Found MCP dependency',
                context: ReferenceDetectorService.name,
                metadata: {
                    fullMatch,
                    app,
                    tool,
                    repositoryId,
                },
            });
            mcpDependencies.push({
                type: 'mcp',
                id: `${app}|${tool}`,
                metadata: {
                    app,
                    tool,
                    originalText: fullMatch,
                    repositoryId,
                    detectedAt: new Date().toISOString(),
                },
            });
        }

        this.logger.debug({
            message: 'MCP extraction completed',
            context: ReferenceDetectorService.name,
            metadata: {
                foundCount: mcpDependencies.length,
            },
        });

        return mcpDependencies;
    }
}
