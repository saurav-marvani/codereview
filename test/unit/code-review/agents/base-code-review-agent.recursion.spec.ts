/**
 * Failing tests covering the recursion bug in BaseCodeReviewAgentProvider
 * AND the two-pronged fix proposed in the loop-production discussion:
 *
 *   - Opção B (root cause): when chunkFilesByTokenBudget returns a single
 *     chunk that contains EVERY input file, recursing back into execute()
 *     with the same set is pointless and infinite. executeChunked should
 *     fail fast with AGENT_PROMPT_OVERHEAD_EXCEEDS_BUDGET BEFORE the
 *     recursive call.
 *
 *   - Opção A (defense in depth): execute() should enforce a recursion
 *     depth limit, throwing AGENT_RECURSION_LIMIT_EXCEEDED if any future
 *     code path manages to recurse past 2 levels. recursionDepth must be
 *     forwarded by executeChunked when it calls execute() per-batch.
 *
 *   - Log readability: batchLabel must be built from the unmodified
 *     baseIdentity.name so the agent name in logs stays bounded instead
 *     of growing one " batch X/Y" suffix per recursion level.
 *
 * The healthy paths (chunking that legitimately reduces file count, and
 * small PRs that bypass chunking entirely) are also covered as regression
 * guards: they must keep working after the fixes are applied.
 *
 * Mocks are scoped to external collaborators only. The recursion mechanics
 * (estimatePromptTokens, chunkFilesByTokenBudget) are exercised with real
 * inputs because those are the gates the bug rides on.
 */

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

jest.mock(
    '@/code-review/infrastructure/agents/llm/byok-to-vercel',
    () => ({
        byokToVercelModel: jest.fn(() => ({ id: 'fake-model' })),
        getModelName: jest.fn(() => 'fake-model'),
    }),
);

jest.mock(
    '@/code-review/infrastructure/agents/llm/model-context-window',
    () => ({
        resolveContextWindow: jest.fn(() => 200_000),
    }),
);

jest.mock('@libs/core/log/langfuse', () => ({
    shouldTrace: jest.fn(() => false),
}));

jest.mock('@/code-review/infrastructure/agents/llm/agent-loop', () => ({
    runAgentLoop: jest.fn(async () => ({
        findings: { suggestions: [] },
        text: '',
        steps: 0,
        toolCalls: [],
        finishReason: 'stop',
        source: 'empty',
        usage: {
            inputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
        },
        discardedBySeverity: [],
        droppedByVerify: [],
        coverage: {
            totalTargets: 0,
            touchedTargets: 0,
            pendingTargets: 0,
            touchedFiles: [],
            pendingFiles: [],
            criticalTotal: 0,
            criticalTouched: 0,
            criticalPending: 0,
            warmTotal: 0,
            warmTouched: 0,
            warmPending: 0,
            optionalTotal: 0,
            optionalTouched: 0,
            optionalPending: 0,
        },
        verification: null,
        anomalies: {
            stepsLe2: false,
            zeroToolCalls: false,
            zeroStrongEvidenceFiles: false,
            zeroCoverage: false,
            lowCoverage: false,
            lowStrongEvidenceFiles: false,
        },
    })),
}));

import {
    BaseCodeReviewAgentProvider,
    type ReviewAgentIdentity,
    type ReviewAgentInput,
} from '@/code-review/infrastructure/agents/base-code-review-agent.provider';
import type { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';

class TestAgent extends BaseCodeReviewAgentProvider {
    constructor() {
        const permissionService: any = {
            getBYOKConfig: jest.fn().mockResolvedValue(null),
        };
        super(null as any, permissionService, null as any);
    }

    protected getIdentity(): ReviewAgentIdentity {
        return {
            name: 'kodus-test-agent',
            description: 'test',
            goal: 'test',
            expertise: ['test'],
        };
    }

    protected getCategoryPrompt(): string {
        return 'category-prompt-stub';
    }

    protected getCategoryLabel(): string {
        return 'bug';
    }
}

function makeFile(name: string, patchChars: number): FileChange {
    const patch = 'a'.repeat(patchChars);
    return {
        filename: name,
        sha: 'abc',
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
        patch,
        patchWithLinesStr: patch,
    } as any;
}

const BASE_INPUT_FIELDS = {
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    prNumber: 42,
    repositoryFullName: 'kodus/test',
    languageResultPrompt: 'en',
    remoteCommands: undefined,
    // 'deep' skips the aggressive filter / tiering branch so the chunking
    // gate is the only branch exercised here.
    reviewMode: 'deep' as const,
    maxSteps: 1,
};

/**
 * Pathological scenario: three tiny files plus a 400k-char callGraph.
 *   estimatePromptTokens ≈ 115k tokens (> promptBudget = 110k → gate fires)
 *   chunkFilesByTokenBudget(files, 94_500) → ONE chunk with all 3 files
 *     because each diff is ~20 tokens, well below the chunk budget.
 * executeChunked then calls execute() with the same 3 files, the gate
 * fires again, and we recurse forever.
 */
function makePathologicalInput(): ReviewAgentInput {
    return {
        ...BASE_INPUT_FIELDS,
        changedFiles: [
            makeFile('src/a.ts', 80),
            makeFile('src/b.ts', 80),
            makeFile('src/c.ts', 80),
        ],
        callGraph: 'x'.repeat(400_000),
    } as ReviewAgentInput;
}

/**
 * Healthy scenario: two 200k-char diffs. Each file individually fits in
 * chunkDiffBudget (50k ≤ 94.5k tokens) but the pair doesn't, so the
 * chunker produces two chunks of one file each. No recursion.
 */
function makeHealthyChunkingInput(): ReviewAgentInput {
    return {
        ...BASE_INPUT_FIELDS,
        changedFiles: [
            makeFile('src/large1.ts', 200_000),
            makeFile('src/large2.ts', 200_000),
        ],
    } as ReviewAgentInput;
}

/**
 * Small scenario: one tiny file, no callGraph. estimatedPromptTokens
 * stays well below promptBudget → chunking gate never fires.
 */
function makeSmallInput(): ReviewAgentInput {
    return {
        ...BASE_INPUT_FIELDS,
        changedFiles: [makeFile('src/tiny.ts', 80)],
    } as ReviewAgentInput;
}

/**
 * Wrap agent.execute() with a counter + hard cap so a runaway recursion
 * cannot hang the test runner. The cap throw is caught by executeChunked's
 * per-batch try/catch and absorbed into an empty result — exactly what
 * happens in production today, just bounded.
 */
const RECURSION_CAP = 25;

function setupExecuteSpy(agent: TestAgent) {
    const original = TestAgent.prototype.execute;
    let count = 0;
    const calls: ReviewAgentInput[] = [];
    const spy = jest
        .spyOn(agent, 'execute')
        .mockImplementation(async function (
            this: TestAgent,
            input: ReviewAgentInput,
        ) {
            count++;
            calls.push(input);
            if (count > RECURSION_CAP) {
                throw new Error(
                    `TEST_RECURSION_CAP_EXCEEDED after ${count} calls`,
                );
            }
            return original.call(this, input);
        });
    return { spy, calls, getCount: () => count };
}

describe('BaseCodeReviewAgentProvider — recursion bug + proposed fixes', () => {
    let agent: TestAgent;

    beforeEach(() => {
        agent = new TestAgent();
        jest.clearAllMocks();
    });

    describe('Fix B — fail-fast when chunker cannot reduce file count', () => {
        it('rejects with AGENT_PROMPT_OVERHEAD_EXCEEDS_BUDGET', async () => {
            setupExecuteSpy(agent);
            await expect(
                agent.execute(makePathologicalInput()),
            ).rejects.toThrow('AGENT_PROMPT_OVERHEAD_EXCEEDS_BUDGET');
        });

        it('does NOT recurse — execute() is called exactly once before failing', async () => {
            const { getCount } = setupExecuteSpy(agent);
            await agent
                .execute(makePathologicalInput())
                .catch(() => undefined);
            expect(getCount()).toBe(1);
        });
    });

    describe('Fix A — recursion-depth guard (defense in depth)', () => {
        it('rejects with AGENT_RECURSION_LIMIT_EXCEEDED when execute() is called directly with recursionDepth >= 2', async () => {
            const input = makeSmallInput() as any;
            input.recursionDepth = 2;
            await expect(agent.execute(input)).rejects.toThrow(
                'AGENT_RECURSION_LIMIT_EXCEEDED',
            );
        });

        it('propagates an incrementing recursionDepth from executeChunked into each per-batch execute() call', async () => {
            const { calls } = setupExecuteSpy(agent);
            await agent
                .execute(makeHealthyChunkingInput())
                .catch(() => undefined);
            // calls[0] = root execute, calls[1] = batch 1, calls[2] = batch 2
            expect(calls.length).toBeGreaterThanOrEqual(3);
            expect((calls[0] as any)?.recursionDepth ?? 0).toBe(0);
            expect((calls[1] as any)?.recursionDepth).toBe(1);
            expect((calls[2] as any)?.recursionDepth).toBe(1);
        });
    });

    describe('Log readability — batchLabel must not accumulate " batch X/Y" suffixes', () => {
        it('agentRuntimeName seen at every recursion level carries at most ONE " batch " segment', async () => {
            const { calls } = setupExecuteSpy(agent);
            await agent
                .execute(makePathologicalInput())
                .catch(() => undefined);
            for (const call of calls) {
                const name = call.agentRuntimeName || '';
                const occurrences = (name.match(/ batch /g) || []).length;
                expect(occurrences).toBeLessThanOrEqual(1);
            }
        });
    });

    describe('Regression guard — healthy paths must keep working', () => {
        it('chunker that reduces file count completes without recursing (root + 2 batches = 3 execute() calls)', async () => {
            const { getCount } = setupExecuteSpy(agent);
            const result = await agent.execute(makeHealthyChunkingInput());
            expect(result).toBeDefined();
            expect(getCount()).toBe(3);
        });

        it('small PR skips the chunking gate entirely (execute called once)', async () => {
            const { getCount } = setupExecuteSpy(agent);
            const result = await agent.execute(makeSmallInput());
            expect(result).toBeDefined();
            expect(getCount()).toBe(1);
        });
    });
});
