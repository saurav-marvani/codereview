/**
 * AiSdkAgentRunner compression regression (mocked model, ai/test).
 *
 * Reproduces the production crash "TypeError: message.content.filter is not a
 * function" that fires ONLY on long runs, right after a `context.compress`
 * event. Root cause: `tool` messages carry structured content (an array of
 * `tool-result` parts), but the harness stringifies that content at two seams
 * (toAgentMessage in the runner + the compressor output mapping) because
 * AgentMessage.content is typed `string`. When CompressionPolicy fires, the
 * compressed window is handed back to generateText with a STRING as the `tool`
 * message content; the AI SDK's `case "tool"` does `content.filter(...)` with
 * no string guard → TypeError.
 *
 * These are written BEFORE the fix (TDD):
 *   - "crashes ... when compression fires"  → RED today, green after the fix.
 *   - "completes normally when compression does NOT fire" → GUARD: green today
 *     AND after the fix, so the fix can't silently break the happy path.
 */
import { MockLanguageModelV3 } from 'ai/test';

import type { AgentSpec } from '../../domain/contracts/agent.contract';
import type { ModelResolver } from '../../domain/contracts/model.contract';
import type { ProgressLedger } from '../../domain/contracts/progress.contract';
import type { AgentTool, ToolContext } from '../../domain/contracts/tool.contract';
import { ContextWindowCompressor } from '../compression/context-window-compressor';
import { CompletionGatePolicy } from '../policies/completion-gate.policy';
import { CompressionPolicy } from '../policies/compression.policy';
import { InMemoryToolRegistry } from '../tools/in-memory-tool-registry';
import { AiSdkAgentRunner } from './ai-sdk-agent-runner';

// A tool result big enough (well above the compressor's 3_000-char "recent"
// cap) that compression actually truncates it and reports real token savings.
const BIG_RESULT = 'x'.repeat(8_000);

// Scripted model: step 0 -> call readFile (produces a large `tool` message),
// step 1 -> call submitResult (finalize). Deterministic, no real LLM.
function scriptedModel() {
    let call = 0;
    const doGenerate = (async () => {
        call += 1;
        const tc =
            call === 1
                ? { id: 'c1', name: 'readFile', input: { path: 'big.txt' } }
                : { id: 'c2', name: 'submitResult', input: { findings: [] } };
        return {
            content: [
                {
                    type: 'tool-call',
                    toolCallId: tc.id,
                    toolName: tc.name,
                    input: JSON.stringify(tc.input),
                },
            ],
            finishReason: 'tool-calls',
            usage: { inputTokens: 10, outputTokens: 5 },
            warnings: [],
        };
    }) as any;
    return new MockLanguageModelV3({ doGenerate });
}

const resolver: ModelResolver<any> = {
    resolve: () => scriptedModel() as any,
};

const readFileTool: AgentTool = {
    name: 'readFile',
    description: 'read a file',
    inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
    },
    execute: async () => ({ output: BIG_RESULT }),
};

const doneTool: AgentTool = {
    name: 'submitResult',
    description: 'finalize',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ output: 'submitted' }),
};

function noCriticalLedger(): ProgressLedger {
    return {
        markFromToolCall: () => undefined,
        summary: () => ({
            totalTargets: 0,
            pendingTargets: 0,
            criticalTotal: 0,
            criticalPending: 0,
        }),
        debtNote: () => null,
    };
}

const ctx: ToolContext = { runId: 'compress-e2e-1' };

function specWithContextWindow(contextWindowTokens: number): AgentSpec {
    return {
        id: 'generalist',
        systemPrompt: 'review the diff',
        modelId: 'mock',
        tools: new InMemoryToolRegistry([readFileTool, doneTool]),
        policies: [
            new CompressionPolicy(
                new ContextWindowCompressor(contextWindowTokens),
            ),
            new CompletionGatePolicy(noCriticalLedger(), {
                doneToolName: 'submitResult',
            }),
        ],
        maxSteps: 10,
        resultToolName: 'submitResult',
    };
}

describe('AiSdkAgentRunner + CompressionPolicy (context compression e2e)', () => {
    // RED before the fix: a tiny context window forces compression on the
    // second step; the compressed `tool` message reaches generateText as a
    // string and the SDK crashes on content.filter. The runner captures the
    // throw into RunState{status:'error'} with the original message in trace.
    it('completes (does not crash on tool content.filter) when compression fires on a long run', async () => {
        const runner = new AiSdkAgentRunner(resolver);
        // window=1 token -> shouldCompress is always true; the big tool result
        // guarantees real savings so maybeCompress returns a compressed window.
        const state = await runner.run(
            specWithContextWindow(1),
            { prompt: 'go' },
            ctx,
        );

        // The compression event must have actually fired (else this test
        // wouldn't exercise the bug at all).
        expect(
            state.trace.some((e) => e.kind === 'context.compress'),
        ).toBe(true);

        // The bug: an error trace event carrying the SDK's TypeError.
        const filterError = state.trace.find(
            (e) =>
                e.kind === 'error' &&
                /content\.filter is not a function|filter is not a function/i.test(
                    String(e.detail?.message ?? ''),
                ),
        );
        expect(filterError).toBeUndefined();

        // And the run finishes instead of erroring out.
        expect(state.status).not.toBe('error');
    });

    // GUARD: green before AND after the fix. A large context window means
    // compression never triggers, so structured messages flow through
    // untouched and the loop finalizes normally. Protects the happy path.
    it('completes normally when compression does NOT fire (no context overflow)', async () => {
        const runner = new AiSdkAgentRunner(resolver);
        const state = await runner.run(
            specWithContextWindow(1_000_000),
            { prompt: 'go' },
            ctx,
        );

        // Compression must NOT have fired in this scenario.
        expect(
            state.trace.some((e) => e.kind === 'context.compress'),
        ).toBe(false);
        expect(
            state.trace.some((e) => e.kind === 'error'),
        ).toBe(false);

        // The loop drove readFile then submitResult, and the completion gate
        // honored the done tool.
        expect(state.status).toBe('stopped');
        expect(state.stopReason).toBe('completion-gate');
        expect(state.artifacts).toHaveLength(1);
        expect(state.artifacts[0]).toMatchObject({
            type: 'submitResult',
            payload: { findings: [] },
        });
    });
});
