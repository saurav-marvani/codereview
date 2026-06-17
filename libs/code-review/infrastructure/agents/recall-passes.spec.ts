/**
 * runRecallPasses unit tests — ZERO LLM, fully deterministic.
 *
 * Locks the legacy recall behavior ported into the new path: coverage recovery
 * (gate: not satisfied + finder investigated), second/third chance (gate: <70%),
 * synthesis rescue (always unless skipped), dedup-merge, and the fast/trial skip.
 */
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import type { ToolContext } from '@libs/agent-harness/domain/contracts/tool.contract';

import { runRecallPasses, type FinderSuggestion } from './finder.agent';

const ctx: ToolContext = { runId: 'recall-test' };

function sug(file: string, content: string): FinderSuggestion {
    return {
        relevantFile: file,
        suggestionContent: content,
        existingCode: '',
        improvedCode: '',
    };
}

/** A RunState whose submitResult artifact carries the given suggestions. */
function stateWith(suggestions: FinderSuggestion[]): RunState {
    return {
        artifacts: [
            { type: 'submitResult', payload: { reasoning: 'r', suggestions } },
        ],
        steps: [
            {
                index: 0,
                message: {
                    toolCalls: [{ name: 'readFile', input: { path: 'a.ts' } }],
                },
            },
        ],
        usage: {
            inputTokens: 10,
            outputTokens: 4,
            reasoningTokens: 2,
            cacheReadTokens: 1,
        },
        status: 'done',
    } as any;
}

/** A runner that returns the queued states in order (one per extra pass). */
function fakeRunner(states: RunState[]) {
    let i = 0;
    return {
        run: jest.fn(async () => states[i++] ?? states[states.length - 1]),
    } as any;
}

const ledger = (opts: {
    satisfied: boolean;
    low: boolean;
}) =>
    ({
        isSatisfied: () => opts.satisfied,
        isLowCoverage: () => opts.low,
        debtNote: () => 'b.ts: 1 hunk uncovered',
    }) as any;

const base = { reasoning: 'base', suggestions: [sug('a.ts', 'bug1')] };
const finderState = stateWith(base.suggestions);

describe('runRecallPasses', () => {
    it('skips ALL passes in fast/trial mode (skipHeavyPasses)', async () => {
        const runner = fakeRunner([]);
        const out = await runRecallPasses(
            base,
            { runner, finderSpec: {} as any, finderState, userPrompt: 'p', skipHeavyPasses: true },
            ctx,
        );
        expect(runner.run).not.toHaveBeenCalled();
        expect(out.findings).toBe(base);
        expect(out.usage.inputTokens).toBe(0);
    });

    it('runs coverage recovery when not satisfied + finder investigated, and merges NEW findings', async () => {
        const runner = fakeRunner([stateWith([sug('b.ts', 'bug2')])]);
        const out = await runRecallPasses(
            base,
            {
                runner,
                finderSpec: {} as any,
                coverageLedger: ledger({ satisfied: false, low: false }),
                finderState,
                userPrompt: 'p',
                skipSynthesisRescue: true,
            },
            ctx,
        );
        expect(runner.run).toHaveBeenCalledTimes(1); // recovery only (low=false → no chances)
        expect(out.findings.suggestions.map((s) => s.relevantFile)).toEqual([
            'a.ts',
            'b.ts',
        ]);
        expect(out.usage.inputTokens).toBe(10); // one extra run's usage
    });

    it('dedups identical findings across passes', async () => {
        const runner = fakeRunner([stateWith([sug('a.ts', 'bug1')])]); // same as base
        const out = await runRecallPasses(
            base,
            {
                runner,
                finderSpec: {} as any,
                coverageLedger: ledger({ satisfied: false, low: false }),
                finderState,
                userPrompt: 'p',
                skipSynthesisRescue: true,
            },
            ctx,
        );
        expect(out.findings.suggestions).toHaveLength(1);
    });

    it('runs up to 2 extra chances while coverage stays low (recovery + 2)', async () => {
        const runner = fakeRunner([
            stateWith([sug('b.ts', 'bug2')]),
            stateWith([sug('c.ts', 'bug3')]),
            stateWith([sug('d.ts', 'bug4')]),
        ]);
        const out = await runRecallPasses(
            base,
            {
                runner,
                finderSpec: {} as any,
                coverageLedger: ledger({ satisfied: false, low: true }),
                finderState,
                userPrompt: 'p',
                skipSynthesisRescue: true,
            },
            ctx,
        );
        // recovery + second + third = 3 (legacy cap)
        expect(runner.run).toHaveBeenCalledTimes(3);
    });

    it('runs synthesis rescue when coverage is satisfied and synthesis not skipped', async () => {
        const runner = fakeRunner([stateWith([sug('e.ts', 'missed bug')])]);
        const out = await runRecallPasses(
            base,
            {
                runner,
                finderSpec: {} as any,
                coverageLedger: ledger({ satisfied: true, low: false }),
                finderState,
                userPrompt: 'review this',
            },
            ctx,
        );
        expect(runner.run).toHaveBeenCalledTimes(1); // only synthesis (coverage ok)
        expect(out.findings.suggestions.map((s) => s.relevantFile)).toContain(
            'e.ts',
        );
    });

    it('skips coverage passes when no ledger is provided, still runs synthesis', async () => {
        const runner = fakeRunner([stateWith([])]);
        const out = await runRecallPasses(
            base,
            { runner, finderSpec: {} as any, finderState, userPrompt: 'p' },
            ctx,
        );
        expect(runner.run).toHaveBeenCalledTimes(1); // synthesis only
        expect(out.findings.suggestions).toHaveLength(1);
    });
});
