/**
 * code-review (domain) — emits the per-agent usage spans (main + verify).
 *
 * Phase 4 of the provider decomposition. Pulls the OTel/Langfuse usage-span
 * accounting out of BaseCodeReviewAgentProvider. Best-effort: any failure is
 * swallowed (observability must never break a review). The ObservabilityService
 * is injected.
 */
import type { ObservabilityService } from '@libs/core/log/observability.service';
import { propagateAttributes, startActiveObservation } from '@langfuse/tracing';
import { shouldTrace } from '@libs/core/log/langfuse';

export interface AgentTraceMeta {
    traceName: string;
    organizationId?: string;
    teamId?: string;
    prNumber?: number;
    repositoryId?: string;
}

/**
 * Run `fn` inside a Langfuse trace span (session grouped by org:repo:pr).
 * No-op passthrough when tracing is disabled. `spanInput` is the sanitized
 * input recorded on the span (caller strips secrets / large diffs).
 */
export async function runAgentWithTrace<T>(
    meta: AgentTraceMeta,
    spanInput: unknown,
    fn: () => Promise<T>,
): Promise<T> {
    if (!shouldTrace()) {
        return fn();
    }

    const traceMetadata: Record<string, string> = {};
    traceMetadata.organizationId = meta.organizationId || 'unknown_org';
    traceMetadata.teamId = meta.teamId || 'unknown_team';
    if (meta.prNumber) {
        traceMetadata.prNumber = String(meta.prNumber);
        traceMetadata.pullRequestId = String(meta.prNumber);
    }
    if (meta.repositoryId) {
        traceMetadata.repositoryId = meta.repositoryId;
    }

    return propagateAttributes(
        {
            traceName: meta.traceName,
            sessionId: traceMetadata.prNumber
                ? `${traceMetadata.organizationId ?? 'org'}:${traceMetadata.repositoryId ?? 'repo'}:${traceMetadata.prNumber}`
                : undefined,
            userId: traceMetadata.organizationId,
            metadata: traceMetadata,
        },
        () =>
            startActiveObservation(meta.traceName, async (span: any) => {
                span.update({ input: spanInput });
                const result = await fn();
                span.update({ output: result });
                return result;
            }),
    );
}

interface UsageLike {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}

export interface RecordAgentUsageParams {
    agentResult: {
        usage: UsageLike;
        verificationUsage?: Partial<UsageLike>;
        steps: number;
        toolCalls: unknown[];
        finishReason: string;
        source: string;
    };
    modelName: string;
    /** byokConfig present → 'byok', else 'system'. */
    isByok: boolean;
    categoryLabel: string;
    identityName: string;
    organizationId?: string;
    teamId?: string;
    prNumber: number;
    durationMs: number;
    observability: ObservabilityService;
}

/**
 * Record two spans: the main review usage (finder, net of verify) and — when
 * present — a separate verify span. Token splits mirror the legacy provider.
 */
export async function recordAgentUsageSpans(
    p: RecordAgentUsageParams,
): Promise<void> {
    const { agentResult, observability } = p;
    const typeTag = p.isByok ? 'byok' : 'system';
    try {
        const vUsage = agentResult.verificationUsage;
        const mainInputTokens =
            agentResult.usage.inputTokens - (vUsage?.inputTokens ?? 0);
        const mainOutputTokens =
            agentResult.usage.outputTokens - (vUsage?.outputTokens ?? 0);
        const vCacheRead = (vUsage as any)?.cacheReadTokens ?? 0;
        const vCacheWrite = (vUsage as any)?.cacheWriteTokens ?? 0;
        const mainCacheRead =
            ((agentResult.usage as any).cacheReadTokens ?? 0) - vCacheRead;
        const mainCacheWrite =
            ((agentResult.usage as any).cacheWriteTokens ?? 0) - vCacheWrite;

        await observability.runInSpan(
            `${p.identityName}::review`,
            async () => agentResult,
            {
                'gen_ai.usage.input_tokens': mainInputTokens,
                'gen_ai.usage.output_tokens': mainOutputTokens,
                'gen_ai.usage.total_tokens': mainInputTokens + mainOutputTokens,
                ...(mainCacheRead > 0 && {
                    'gen_ai.usage.cache_read_input_tokens': mainCacheRead,
                }),
                ...(mainCacheWrite > 0 && {
                    'gen_ai.usage.cache_creation_input_tokens': mainCacheWrite,
                }),
                ...(agentResult.usage.reasoningTokens > 0 && {
                    'gen_ai.usage.reasoning_tokens':
                        agentResult.usage.reasoningTokens -
                        (vUsage?.reasoningTokens ?? 0),
                }),
                'gen_ai.response.model': p.modelName,
                'gen_ai.run.name': `code-review-${p.categoryLabel}`,
                // agent.name/agent.phase populate the observability_telemetry
                // agentName/phase columns (see @kodus/flow mongodb-exporter).
                'agent.name': p.identityName,
                'agent.phase': 'review',
                'type': typeTag,
                'organizationId': p.organizationId,
                'teamId': p.teamId,
                'prNumber': p.prNumber,
                'steps': agentResult.steps,
                'toolCalls': agentResult.toolCalls.length,
                'finishReason': agentResult.finishReason,
                'source': agentResult.source,
                'durationMs': p.durationMs,
            },
        );

        // Separate span for verification tokens
        if (vUsage && ((vUsage.inputTokens ?? 0) > 0 || (vUsage.outputTokens ?? 0) > 0)) {
            await observability.runInSpan(
                `${p.identityName}::verify`,
                async () => agentResult,
                {
                    'gen_ai.usage.input_tokens': vUsage.inputTokens ?? 0,
                    'gen_ai.usage.output_tokens': vUsage.outputTokens ?? 0,
                    'gen_ai.usage.total_tokens':
                        (vUsage.inputTokens ?? 0) + (vUsage.outputTokens ?? 0),
                    ...((vUsage as any).cacheReadTokens > 0 && {
                        'gen_ai.usage.cache_read_input_tokens': (vUsage as any)
                            .cacheReadTokens,
                    }),
                    ...((vUsage as any).cacheWriteTokens > 0 && {
                        'gen_ai.usage.cache_creation_input_tokens': (
                            vUsage as any
                        ).cacheWriteTokens,
                    }),
                    ...((vUsage.reasoningTokens ?? 0) > 0 && {
                        'gen_ai.usage.reasoning_tokens': vUsage.reasoningTokens,
                    }),
                    'gen_ai.response.model': p.modelName,
                    'gen_ai.run.name': `code-review-${p.categoryLabel}-verify`,
                    'agent.name': p.identityName,
                    'agent.phase': 'verify',
                    'type': typeTag,
                    'organizationId': p.organizationId,
                    'teamId': p.teamId,
                    'prNumber': p.prNumber,
                },
            );
        }
    } catch {
        // Observability is best-effort
    }
}
