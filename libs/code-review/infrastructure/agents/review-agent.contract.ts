/**
 * code-review — the shared CONTRACTS for a review-agent run: the input, output,
 * identity, progress and trace/anomaly shapes that the provider, the collaborators
 * (prompt-builder, batch-runner, model-factory, …) and the pipeline stage all
 * speak. Lives here (neutral home) rather than inside the provider class so the
 * collaborators don't have to import their vocabulary from the God class they
 * were extracted from (no type cycle).
 *
 * These are code-review domain shapes (changedFiles, kodyRules, remoteCommands,
 * coverage…), NOT harness primitives — the harness must never depend on them.
 *
 * `ReviewAgentInput` is composed from cohesive sub-interfaces (ISP): each
 * collaborator can depend on the narrow slice it needs (e.g.
 * `PrReviewContext & ReviewRuleConfig`) instead of the whole 34-field input.
 */
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    CodeReviewConfig,
    CodeSuggestion,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { CoverageSummary, CoverageTier } from './llm/coverage-ledger';
import { type AdaptiveProfile } from './llm/adaptive-fit';
import type { ReviewWarning } from './llm/review-warnings';
import type {
    VerificationTraceSummary,
    AgentAnomalySummary,
} from './llm/agent-loop';

export type {
    AgentLoopInput,
    AgentLoopOutput,
    AgentLoopSecrets,
    VerificationTraceSummary,
    AgentAnomalySummary,
} from './llm/agent-loop';

/**
 * Category-specific agent configuration provided by each concrete subclass.
 */
export interface ReviewAgentIdentity {
    name: string;
    description: string;
    goal: string;
    expertise: string[];
}

/**
 * Progress event emitted by agents during investigation.
 */
export interface AgentProgressEvent {
    agentName: string;
    agentCategory?: string;
    agentReplicaIndex?: number;
    agentReplicaTotal?: number;
    status:
        | 'started'
        | 'investigating'
        | 'completed'
        | 'error'
        | 'batch_started'
        | 'batch_completed';
    step?: number;
    toolCalls?: Array<{ tool: string; args: string; durationMs?: number }>;
    findings?: number;
    durationMs?: number;
    totalTokens?: number;
    /** Batch context: present when the PR was chunked into multiple
     *  token-budget batches and the event refers to one of them. */
    batchIndex?: number;
    batchTotal?: number;
    batchFiles?: number;
    /** Error detail surfaced in the PR logs UI when status === 'error'.
     *  Short, single-line (full stack goes in the server logs). */
    errorMessage?: string;
    /** Error class/name when available (e.g. "TypeError", "AbortError",
     *  "HARD-TIMEOUT"). Helps users recognize failure categories. */
    errorName?: string;
    /** How the agent finished — helps surface timeouts and max-steps in the UI */
    finishReason?: 'stop' | 'timeout' | 'max-steps' | 'error';
    /** How findings were obtained — 'json-parse' (normal), 'second-chance', 'generate-object' (fallback LLM), 'empty' */
    source?: string;
    suggestionsPreview?: Array<{
        relevantFile?: string;
        relevantLinesStart?: number;
        relevantLinesEnd?: number;
        oneSentenceSummary?: string;
        label?: string;
        severity?: string;
    }>;
    coverage?: CoverageSummary;
    verification?: VerificationTraceSummary | null;
    anomalies?: AgentAnomalySummary;
}

// ─── ReviewAgentInput, composed from cohesive slices (ISP) ───────────────────

/** What's being reviewed: the PR + repo identity + the diffs. */
export interface PrReviewContext {
    organizationAndTeamData: OrganizationAndTeamData;
    changedFiles: FileChange[];
    prNumber: number;
    repositoryId?: string;
    repositoryFullName: string;
    prTitle?: string;
    prBody?: string;
    /** Base branch of the PR (e.g. "main"). Passed to tools for git diff. */
    baseBranch?: string;
}

/** How the agent investigates: sandbox + auth + call graph. */
export interface ToolingContext {
    /**
     * Remote commands for the E2B sandbox. When undefined, the agent runs
     * in self-contained mode (no tools, single-shot analysis on the diffs
     * inlined in the user prompt). Used by the CLI trial flow where there
     * is no sandbox available.
     */
    remoteCommands: RemoteCommands | undefined;
    gitHubToken?: string;
    /** Pre-computed call graph for changed functions. Generated once, shared across agents. */
    callGraph?: string;
    /** Structured AST graph JSON (nodes + edges) produced by kodus-graph.
     *  Used by the priority scorer to measure in-PR file centrality when
     *  tiered coverage is active. Safe to omit — the scorer falls back to
     *  a neutral structural weight of 1.0 when missing. */
    callGraphJson?: { nodes: unknown[]; edges: unknown[] };
}

/** Review behavior + rules the agent applies. */
export interface ReviewRuleConfig {
    languageResultPrompt: string;
    memoryRules?: Partial<IKodyRule>[];
    /** Kody rules passed through so findings tagged with ruleUuid can be cross-referenced. */
    kodyRules?: Partial<IKodyRule>[];
    v2PromptOverrides?: CodeReviewConfig['v2PromptOverrides'];
    generationMain?: string;
    /** Categories allowed for this run when using a mixed/generalist reviewer. */
    requestedCategories?: Array<'bug' | 'security' | 'performance'>;
    /** Review mode: 'fast' skips heavy passes (verify, coverage recovery, synthesis rescue) and caps agent steps; 'normal' skips verify only for very-high-confidence findings; 'deep' verifies everything. */
    reviewMode?: 'fast' | 'normal' | 'deep';
}

/** Model selection for the run. */
export interface ModelConfig {
    /**
     * When the caller has no BYOK config (e.g. the public-demo / trial
     * flow with `organizationId='trial'`), this overrides the hardcoded
     * gemini-3.1-pro default that `byokToVercelModel` falls back to.
     * Used by the trial pipeline to force a cheaper, faster model
     * (`gemini-2.5-flash`) so anonymous reviews don't take 5 minutes.
     */
    defaultModelOverride?: string;
    /**
     * Resolved BYOK *main* model override (directory -> repository -> BYOK
     * settings) from `codeReviewConfig.byokModel`. When set, it replaces
     * `byokConfig.main.model` for this run so the agent uses the same model
     * the rest of the pipeline does. Empty/undefined means "inherit".
     */
    byokModel?: string;
    /** Optional per-agent step budget for the main investigation loop. */
    maxSteps?: number;
}

/** Adaptive-fit decisions resolved upstream (by the stage) to fit the window. */
export interface FitConfig {
    /** Internal: populated by the large-PR non-deep branch of execute().
     *  Downstream consumers (buildUserPrompt, runAgentLoop) switch the
     *  coverage ledger into tiered mode when this is set. Maps each
     *  changed file to its tier ('critical' | 'warm' | 'optional'). */
    fileTiers?: Map<string, CoverageTier>;
    /**
     * Optional adaptive-fit profile resolved upstream (by the stage) from
     * the same BYOK config and model the agent will use. When present,
     * per-agent code paths read these flags instead of re-resolving the
     * profile locally — guarantees the stage's gating decisions (drop
     * callGraph, skip heavy passes) and the provider's behaviour
     * (compact prompt, all-optional, diff truncation) agree.
     */
    adaptiveProfile?: AdaptiveProfile;
    /** When true, skip recovery, second-chance, AND synthesis-rescue
     *  passes. Used by very-narrow agents (rule checks in fast mode,
     *  self-contained CLI flow). */
    skipHeavyPasses?: boolean;
    /** When true, run recovery + second-chance but skip ONLY the
     *  synthesis-rescue pass. The rescue pass re-words the same finding
     *  with different language, which is fine for open-ended bug review
     *  but produces duplicate comments for explicit-rule agents like
     *  kody-rules. */
    skipSynthesisRescue?: boolean;
}

/** Replica / batch / recursion bookkeeping (mostly internal). */
export interface RuntimeMeta {
    /** Optional runtime alias used to distinguish replicated agent runs in traces. */
    agentRuntimeName?: string;
    /** Optional replica metadata for replicated agent runs. */
    agentReplicaIndex?: number;
    agentReplicaTotal?: number;
    /** Batch metadata when the parent executeChunked has split the PR into
     *  token-budget batches. Forwarded so per-step progress events can show
     *  "batch i/N · step k" in the UI. */
    batchIndex?: number;
    batchTotal?: number;
    /** Internal: how many times executeChunked has re-entered execute()
     *  for this review. Bounded to MAX_RECURSION_DEPTH by execute() to
     *  prevent the historical execute() ↔ executeChunked() loop from
     *  exhausting the worker heap. Always undefined at the public entry
     *  point; populated by executeChunked when fanning out per-batch. */
    recursionDepth?: number;
}

/**
 * Input passed to the agent for a single review execution. Composed from the
 * cohesive slices above so a consumer can depend on just what it needs.
 */
export interface ReviewAgentInput
    extends PrReviewContext,
        ToolingContext,
        ReviewRuleConfig,
        ModelConfig,
        FitConfig,
        RuntimeMeta {
    onAgentProgress?: (event: AgentProgressEvent) => void;
    /** Parent (job-level) AbortSignal. Forwarded to runAgentLoop so the
     *  outer router timeout cancels the LLM call instead of leaving it
     *  running ghost in the background. */
    parentSignal?: AbortSignal;
}

/**
 * Output from a single agent execution.
 */
export interface ReviewAgentOutput {
    suggestions: Partial<CodeSuggestion>[];
    discardedBySeverity?: Partial<CodeSuggestion>[];
    discardedByVerify?: Partial<CodeSuggestion>[];
    agentName: string;
    agentCategory?: string;
    agentReplicaIndex?: number;
    agentReplicaTotal?: number;
    turnsUsed: number;
    durationMs: number;
    /** Fidelity warnings emitted by this agent's loop (small context window
     *  forced compact prompt, dropped callGraph, etc). Empty when no
     *  adaptive strategy fired. */
    warnings?: ReviewWarning[];
}
