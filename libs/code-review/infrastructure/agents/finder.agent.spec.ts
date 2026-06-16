/**
 * finder.agent end-to-end test with a MOCKED model.
 * Proves the assembled finder runs on the new harness AND that findings are
 * extracted from the RunState — the full "produces a real review" path,
 * deterministic, zero real LLM.
 */
import { MockLanguageModelV3 } from 'ai/test';

import type { ProgressLedger } from '@libs/agent-harness/domain/contracts/progress.contract';
import type { ModelResolver } from '@libs/agent-harness/domain/contracts/model.contract';
import type { ToolContext } from '@libs/agent-harness/domain/contracts/tool.contract';
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';

import { buildFinderAgentSpec, extractFindings } from './finder.agent';

const sampleFindings = {
    reasoning: 'found a null deref',
    suggestions: [
        {
            relevantFile: 'src/a.ts',
            label: 'bug',
            suggestionContent: 'null deref on line 10',
            existingCode: 'x.y',
            improvedCode: 'x?.y',
            severity: 'high',
            confidence: 8,
        },
    ],
};

// model: step 1 -> grep; step 2 -> submitResult with findings
function scriptedModel() {
    let call = 0;
    const doGenerate = (async () => {
        call += 1;
        const tc =
            call === 1
                ? { id: 'c1', name: 'grep', input: { pattern: 'x.y' } }
                : { id: 'c2', name: 'submitResult', input: sampleFindings };
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

const grepTool = {
    name: 'grep',
    description: 'search',
    inputSchema: {
        type: 'object' as const,
        properties: { pattern: { type: 'string' as const } },
    },
    execute: async () => ({ output: 'src/a.ts:10: x.y' }),
};

const noCriticalLedger: ProgressLedger = {
    markFromToolCall: () => undefined,
    summary: () => ({
        totalTargets: 0,
        pendingTargets: 0,
        criticalTotal: 0,
        criticalPending: 0,
    }),
    debtNote: () => null,
};

const ctx: ToolContext = { runId: 'finder-e2e' };

describe('finder.agent (assembled on agent-harness)', () => {
    it('runs the finder and extracts findings from the RunState', async () => {
        const spec = buildFinderAgentSpec({
            systemPrompt: 'find bugs',
            modelId: 'mock',
            tools: new InMemoryToolRegistry([grepTool]),
            coverageLedger: noCriticalLedger,
            maxSteps: 10,
        });

        // spec composed correctly: grep + submitResult present, 2 policies
        expect(spec.tools.get('grep')).toBeDefined();
        expect(spec.tools.get('submitResult')).toBeDefined();
        expect(spec.policies.map((p) => p.name)).toEqual([
            'budget',
            'completion-gate',
            'force-finalize',
        ]);

        const state = await new AiSdkAgentRunner(resolver).run(
            spec,
            { prompt: 'review this PR' },
            ctx,
        );

        const { reasoning, suggestions } = extractFindings(state);
        expect(reasoning).toBe('found a null deref');
        expect(suggestions).toHaveLength(1);
        expect(suggestions[0].relevantFile).toBe('src/a.ts');
        expect(suggestions[0].severity).toBe('high');
    });

    it('returns empty findings when the agent never finalized', () => {
        const state = {
            runId: 'r',
            agentId: 'finder',
            status: 'budget-exhausted' as const,
            steps: [],
            artifacts: [],
            usage: {},
            trace: [],
        };
        expect(extractFindings(state).suggestions).toEqual([]);
    });
});
