/**
 * runVerificationPass unit tests — deterministic, fake Verifier, zero LLM.
 * Asserts refute-to-drop semantics: keep by default, drop only on explicit
 * keep:false, fail-open when the Verifier throws.
 */
import type { ToolContext } from '../../domain/contracts/tool.contract';
import type { Verifier } from '../../domain/contracts/verifier.contract';
import { runVerificationPass } from './verification-pass';

const ctx: ToolContext = { runId: 'v' };

// A Verifier whose verdict is decided by a predicate over the candidate string.
const predicateVerifier = (
    decide: (candidate: string) => boolean | 'throw',
): Verifier<string> => ({
    verify: async (candidate) => {
        const d = decide(candidate);
        if (d === 'throw') throw new Error('checker dead');
        return { keep: d, rationale: d ? 'confirmed' : 'refuted' };
    },
});

describe('runVerificationPass (refute-to-drop)', () => {
    it('keeps candidates the checker confirms, drops the refuted ones', async () => {
        const r = await runVerificationPass<string>(
            {
                candidates: ['real-bug', 'false-positive', 'real-bug-2'],
                verifier: predicateVerifier((c) => !c.includes('false-positive')),
            },
            ctx,
        );
        expect(r.kept).toEqual(['real-bug', 'real-bug-2']);
        expect(r.dropped.map((d) => d.candidate)).toEqual(['false-positive']);
        expect(r.dropped[0].verdict.rationale).toBe('refuted');
    });

    it('fails OPEN: a checker error keeps the candidate (never silent-drop)', async () => {
        const r = await runVerificationPass<string>(
            { candidates: ['x'], verifier: predicateVerifier(() => 'throw') },
            ctx,
        );
        expect(r.kept).toEqual(['x']);
        expect(r.dropped).toEqual([]);
    });

    it('runs the verifier once per candidate', async () => {
        const seen: string[] = [];
        const verifier: Verifier<string> = {
            verify: async (candidate) => {
                seen.push(candidate);
                return { keep: true };
            },
        };
        await runVerificationPass<string>(
            { candidates: ['a', 'b'], verifier },
            ctx,
        );
        expect(seen.sort()).toEqual(['a', 'b']);
    });
});
