/**
 * code-review (domain) — runAgentLoopViaCore: drop-in for runAgentLoop that
 * runs the GENERALIST finder + verify on the new agent-harness harness.
 *
 * Same signature/return as the legacy runAgentLoop, so the call site can route
 * to it for the generalist while kody-rules / deep agents stay on the legacy
 * loop (they have different behavior and must NOT be swapped wholesale).
 *
 * Fidelity notes:
 *  - recall/FP fields are faithful: findings.suggestions = verified-kept,
 *    droppedByVerify = refuted. This is what the benchmark measures.
 *  - usage is faithful: finder + verify sub-step combined, with cacheRead and
 *    reasoning tokens (cacheWrite stays 0 — implicit-cache providers don't
 *    report writes). verificationUsage carries the verify sub-step alone.
 *  - verification trace is reconstructed: before/after/dropped counts + a
 *    per-finding keep/drop decision list (verifierEvidence is empty — the new
 *    verify path doesn't compute per-finding tool evidence).
 *  - still downstream/best-effort: discardedBySeverity ([]); hypothesisLedger.
 */
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';

import { ContextWindowCompressor } from './adapters/context-window-compressor.adapter';
import { DiffCoverageLedger } from './adapters/diff-coverage-ledger.adapter';
import { buildFinderToolRegistry } from './adapters/finder-tools.adapter';
import { wrapByokModel } from '@libs/llm/byok-model-wrapper';
import { anthropicSystemCacheControl } from '@libs/llm/system-cache';
import { buildFinderAgentSpec, runFinderWithVerify } from './finder.agent';
import {
    type AgentLoopInput,
    type AgentLoopOutput,
    type AgentLoopSecrets,
    type VerificationTraceSummary,
} from './review-agent.contract';
import { AGENT_TIMEOUT_MS } from '@libs/llm/llm-call';
import { buildProviderOptions } from '@libs/llm/reasoning-options';
// buildAgentAnomalies is review-specific (anomaly summary shapes) — lives in its
// own module (relocated out of the legacy llm/agent-loop.ts).
import { buildAgentAnomalies } from './agent-anomalies';
import { composeAbortSignal } from '@libs/common/utils/parent-signal-compose';
import { buildCoverageLedger, getCoverageSummary } from './llm/coverage-ledger';

export async function runAgentLoopViaCore(
    input: AgentLoopInput,
    secrets: AgentLoopSecrets,
): Promise<AgentLoopOutput> {
    const model = wrapByokModel((input as any).model, {
        byokConfig: secrets.byokConfig,
        organizationId: (input as any).telemetryMetadata?.organizationId,
        provider:
            typeof (input as any).byokProvider === 'string'
                ? (input as any).byokProvider
                : undefined,
        queueTimeoutMs: secrets.byokQueueTimeoutMs,
        reporter: secrets.byokErrorReporter,
    });

    const runner = new AiSdkAgentRunner({ resolve: () => model });

    const tools = buildFinderToolRegistry({
        remoteCommands: secrets.remoteCommands,
        repositoryFullName: (input as any).repositoryFullName,
        callGraph: (input as any).callGraph,
    });

    const coverageLedger = new DiffCoverageLedger({
        changedFiles: (input as any).changedFiles,
        fileTiers: (input as any).fileTiers,
    });

    // Reasoning/thinking config (provider-specific) → providerOptions, forwarded
    // to every model call (finder + verifier). Ported from the legacy loop.
    const providerOptions = buildProviderOptions(
        (input as any).agentName ?? 'finder',
        (input as any).telemetryMetadata,
        {
            reasoningEffort: (input as any).reasoningEffort,
            reasoningConfigOverride: (input as any).reasoningConfigOverride,
            byokProvider: (input as any).byokProvider,
            openrouterProviderOrder: (input as any).openrouterProviderOrder,
            openrouterAllowFallbacks: (input as any).openrouterAllowFallbacks,
        },
    );

    // Anthropic prompt caching for the (large, static) system prompt — ported
    // from the legacy `withAnthropicCacheControl`. Cached across the loop's many
    // steps + every verifier run, so Claude models don't re-pay the system
    // prompt's input tokens each step. No-op for non-Anthropic models.
    const systemProviderOptions = anthropicSystemCacheControl(
        (input as any).model,
    );

    // Recall-pass gating — ported from the legacy loop: skip the heavy passes in
    // fast mode, self-contained (no tools) trial flow, or when the caller asks.
    const isSelfContained = tools.list().length === 0;
    const skipHeavyPasses =
        (input as any).reviewMode === 'fast' ||
        isSelfContained ||
        !!(input as any).skipHeavyPasses;
    const skipSynthesisRescue = !!(input as any).skipSynthesisRescue;

    const contextWindowTokens = (input as any).contextWindowTokens;
    const finderSpec = buildFinderAgentSpec({
        systemPrompt: (input as any).systemPrompt,
        modelId: 'resolved',
        tools,
        coverageLedger,
        compressor: contextWindowTokens
            ? new ContextWindowCompressor(contextWindowTokens)
            : undefined,
        maxSteps: (input as any).maxSteps ?? 20,
        providerOptions,
        systemProviderOptions,
    });

    // Hard timeout + cancellation: a local controller that aborts on the parent
    // job signal OR after AGENT_TIMEOUT_MS — ported from the legacy loop so a
    // stuck agent can't run forever (the runner forwards ctx.signal to the model).
    const controller = new AbortController();
    const detach = composeAbortSignal((input as any).parentSignal, controller);
    const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

    const ctx = {
        runId: `${(input as any).prNumber ?? 'pr'}:${(input as any).agentName ?? 'finder'}`,
        signal: controller.signal,
    };

    const r = await runFinderWithVerify(
        {
            runner,
            finderSpec,
            modelId: 'resolved',
            tools,
            providerOptions,
            systemProviderOptions,
            coverageLedger,
            skipHeavyPasses,
            skipSynthesisRescue,
            telemetryMetadata: (input as any).telemetryMetadata,
            agentName: (input as any).agentName,
        },
        { prompt: (input as any).userPrompt },
        ctx,
    ).finally(() => {
        clearTimeout(timeout);
        detach();
    });

    // --- map RunState -> AgentLoopOutput (essential fields faithful) ---
    const toolCalls = r.finderState.steps.flatMap((s) =>
        (s.message.toolCalls ?? []).map((tc) => ({
            tool: tc.name,
            toolName: tc.name,
            args:
                tc.input && typeof tc.input === 'object'
                    ? (tc.input as Record<string, unknown>)
                    : {},
        })),
    );
    const covTargets = buildCoverageLedger((input as any).changedFiles, {
        fileTiers: (input as any).fileTiers,
    });
    const coverage = getCoverageSummary(covTargets);

    // Usage = finder run + verify sub-step (the verify usage is NOT in
    // finderState — it is summed across the verifier runs). cacheWrite stays 0:
    // implicit-cache providers (Gemini/Moonshot) don't report write tokens.
    const fu = r.finderState.usage;
    const vu = r.verifyUsage;
    const ru = r.recallUsage; // extra finder runs (recovery/chances/synthesis)
    const inputTokens = (fu.inputTokens ?? 0) + vu.inputTokens + ru.inputTokens;
    const outputTokens =
        (fu.outputTokens ?? 0) + vu.outputTokens + ru.outputTokens;
    const reasoningTokens =
        (fu.reasoningTokens ?? 0) + vu.reasoningTokens + ru.reasoningTokens;
    const cacheReadTokens =
        (fu.cacheReadTokens ?? 0) + vu.cacheReadTokens + ru.cacheReadTokens;

    // Verify funnel made observable: before = kept + dropped, after = kept.
    const verifiedBefore = r.kept.length + r.droppedByVerify.length;
    const verification: VerificationTraceSummary | null =
        verifiedBefore === 0
            ? null
            : {
                  beforeCount: verifiedBefore,
                  afterCount: r.kept.length,
                  droppedByVerifier: r.droppedByVerify.length,
                  droppedByEvidenceFilter: 0,
                  decisions: [
                      ...r.kept.map((f, i) => ({
                          index: i,
                          relevantFile: f.relevantFile,
                          action: 'keep' as const,
                          parseMode: 'direct' as const,
                          rationale: '',
                          verifierEvidence: { strongFiles: [], weakFiles: [] },
                      })),
                      ...r.droppedByVerify.map((d, i) => ({
                          index: r.kept.length + i,
                          relevantFile: d.finding.relevantFile,
                          action: 'drop' as const,
                          parseMode: 'direct' as const,
                          rationale: d.evidence ?? '',
                          verifierEvidence: { strongFiles: [], weakFiles: [] },
                      })),
                  ],
              };

    return {
        findings: { reasoning: r.reasoning, suggestions: r.kept as any },
        text: r.reasoning,
        steps: r.finderState.steps.length,
        toolCalls,
        finishReason: r.finderState.status,
        source: r.kept.length || r.reasoning ? 'json-parse' : 'empty',
        usage: {
            inputTokens,
            cacheReadTokens,
            cacheWriteTokens: 0,
            outputTokens,
            reasoningTokens,
            totalTokens: inputTokens + outputTokens,
        },
        discardedBySeverity: [],
        droppedByVerify: r.droppedByVerify.map((d) => d.finding) as any,
        coverage,
        verification,
        verificationUsage: {
            inputTokens: vu.inputTokens,
            cacheReadTokens: vu.cacheReadTokens,
            cacheWriteTokens: 0,
            outputTokens: vu.outputTokens,
            reasoningTokens: vu.reasoningTokens,
        },
        anomalies: buildAgentAnomalies({
            steps: r.finderState.steps.length,
            toolCalls,
            coverage,
        }),
        warnings: [],
    };
}
