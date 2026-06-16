/**
 * agent-harness — Verifier port (generic; the "checker" of doer≠checker).
 *
 * A Verifier turns ONE candidate output into a Verdict. The harness does not
 * care HOW it verifies — it can be an LLM sub-agent (a judge), an EXECUTABLE
 * command (compiler / linter / test → a runtime signal), or anything else. The
 * domain supplies the implementation.
 *
 * This is the seam the harness-engineering lectures call "externalized,
 * executable verification": making verification a PORT lets an agent gate on
 * objective signals instead of the generator's own confidence (which is
 * systematically overconfident). Every agent built on the harness inherits the
 * doer≠checker discipline by plugging a Verifier here.
 */
import type { ToolContext } from './tool.contract';

export interface VerdictDimension {
    readonly name: string;
    readonly pass: boolean;
    readonly note?: string;
}

/** A structured verdict (a rubric, not a bare boolean). `keep` is the gate the
 *  verification pass acts on; `confidence`/`rationale`/`dimensions` are evidence
 *  for observability and tuning. Domains decide which dimensions to score. */
export interface Verdict {
    readonly keep: boolean;
    readonly confidence?: 'high' | 'medium' | 'low';
    readonly rationale?: string;
    readonly dimensions?: readonly VerdictDimension[];
}

export interface Verifier<T> {
    /** Verify ONE candidate. MUST default to keep when unsure (fail open) — a
     *  checker that errors or is uncertain never silently drops a candidate. */
    verify(candidate: T, ctx: ToolContext): Promise<Verdict>;
}
