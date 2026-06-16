/**
 * code-review — the shared CONTRACTS for a review-agent run: the input, output,
 * secrets and trace/anomaly shapes that BOTH execution paths agree on (the
 * legacy llm/agent-loop.ts loop and the new harness path). This is the one
 * genuinely multi-consumer surface — base-provider, core adapter and the routing
 * seam all speak it — so it gets its own named home instead of being read off
 * the legacy loop file.
 *
 * These are code-review domain shapes (they carry changedFiles, kodyRules,
 * remoteCommands, coverage…), NOT harness primitives — the harness must never
 * depend on them.
 *
 * SEAM, not a physical move yet: the definitions still live in agent-loop.ts and
 * are re-exported here. Relocating them is deliberately deferred — they form an
 * entangled type web (AgentLoopInput -> ReasoningEffort; AgentLoopOutput ->
 * FindingsOutput/VerificationTraceSummary -> private trace interfaces) that is
 * only worth untangling when the legacy loop is retired. Consumers import from
 * THIS surface so that relocation won't touch them.
 */
export type {
    AgentLoopInput,
    AgentLoopOutput,
    AgentLoopSecrets,
    VerificationTraceSummary,
    AgentAnomalySummary,
} from './llm/agent-loop';
