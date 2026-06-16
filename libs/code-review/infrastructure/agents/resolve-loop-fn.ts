/**
 * code-review — the ONE seam that decides which loop a review agent runs on:
 * the new agent-harness path (`runAgentLoopViaCore`) or the legacy loop
 * (`runAgentLoop`).
 *
 * Decoupling the legacy from the live process happens HERE. The process now runs
 * entirely on the harness; `runAgentLoop` is kept (imported) so a case can be
 * carved back to it the moment we hit a parity gap — by editing this one named
 * function, never by surgery inside the provider's execute().
 *
 * Parity gaps still pending before the legacy can lose its last caller:
 *  - kody-rules behavior (the rules-forwarding execute override)
 *  - self-contained / no-sandbox runs (the harness finder needs tools)
 *  - reviewMode 'deep' (verify-everything) semantics
 */
import { runAgentLoopViaCore } from './core-agent-loop.adapter';
import { runAgentLoop } from './llm/agent-loop';
import type {
    AgentLoopInput,
    AgentLoopOutput,
    AgentLoopSecrets,
} from './review-agent.contract';

export type ReviewLoopFn = (
    input: AgentLoopInput,
    secrets: AgentLoopSecrets,
) => Promise<AgentLoopOutput>;

/** Inputs the routing decision is allowed to read. Pure data — keep it small so
 *  the decision stays trivially testable and obvious. */
export interface LoopRoutingContext {
    /** Stable agent identity (NOT the batch-overridable runtime name). */
    readonly baseAgentName: string;
    /** Whether a sandbox (remoteCommands) is available this run. */
    readonly hasSandbox: boolean;
}

export interface LoopRouting {
    readonly loopFn: ReviewLoopFn;
    readonly usesCoreHarness: boolean;
}

export function resolveLoopFn(ctx: LoopRoutingContext): LoopRouting {
    const usesCoreHarness = routeToCoreHarness(ctx);
    return {
        loopFn: usesCoreHarness ? runAgentLoopViaCore : runAgentLoop,
        usesCoreHarness,
    };
}

/** Currently every case runs on the harness. As parity gaps surface, add the
 *  carve-outs here that return `false` for the cases that must stay on the
 *  legacy loop — this is the single place that knowledge lives. */
function routeToCoreHarness(_ctx: LoopRoutingContext): boolean {
    return true;
}
