import {
    judgeKodyRulesSharded,
    shardViolationsSchema,
    RunJudge,
    RawShardViolation,
} from './kody-rules-sharded.judge';
import { KodyRulesScope } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

// The one genuinely-new runtime risk in the wired provider is the ZOD schema
// (passed to PromptRunnerService.builder().setParser(ParserType.ZOD, ...))
// parsing the model's JSON. The builder/run chain itself is generic infra used
// by every agent. These pin the schema contract against realistic responses.
//
// Rules are presented to the model with 1-based indices ([1], [2], …) and the
// model echoes that index in `ruleId`, NOT the 36-char UUID it used to copy —
// indices are the class of token LLMs corrupt (see #1170), so we removed them
// from the round-trip entirely and resolve index→uuid in code.
describe('shardViolationsSchema — model JSON parsing', () => {
    it('parses a well-formed file-level response with a numeric ruleId', () => {
        const r = shardViolationsSchema.parse({
            violations: [
                {
                    ruleId: 1,
                    relevantLinesStart: 42,
                    relevantLinesEnd: 42,
                    existingCode: 'console.log(x)',
                    suggestionContent: 'WHAT/WHY/HOW',
                    oneSentenceSummary: 'no console',
                },
            ],
        });
        expect(r.violations).toHaveLength(1);
        expect(r.violations[0].ruleId).toBe(1);
    });

    it('coerces a stringified index ("2") to a number', () => {
        const r = shardViolationsSchema.parse({
            violations: [{ ruleId: '2', suggestionContent: 'x' }],
        });
        expect(r.violations[0].ruleId).toBe(2);
    });

    it('tolerates a UUID string in ruleId (fallback echo path)', () => {
        const r = shardViolationsSchema.parse({
            violations: [
                { ruleId: 'a-b-c-uuid', suggestionContent: 'needs a test' },
            ],
        });
        expect(r.violations[0].ruleId).toBe('a-b-c-uuid');
    });

    it('defaults to an empty array when the model returns {} or empty', () => {
        expect(shardViolationsSchema.parse({}).violations).toEqual([]);
        expect(
            shardViolationsSchema.parse({ violations: [] }).violations,
        ).toEqual([]);
    });

    it('rejects a violation missing the required ruleId/suggestionContent', () => {
        expect(() =>
            shardViolationsSchema.parse({
                violations: [{ relevantLinesStart: 1 }],
            }),
        ).toThrow();
    });
});

const file = (filename: string, patch: string): any => ({
    filename,
    patchWithLinesStr: patch,
    patch,
});

// A fake runJudge that returns canned raw violations (as the model would emit
// them — a `ruleId` index, or a UUID string on the fallback path) for a given
// (file, ruleId) pair. Lets us assert the deterministic orchestration —
// including index→uuid resolution — without a live model.
function fakeJudge(
    hits: Record<string, Array<{ ruleId: number | string; line?: number }>>,
): {
    run: RunJudge;
    calls: Array<{ filename: string | null; ruleUuids: string[] }>;
} {
    const calls: Array<{ filename: string | null; ruleUuids: string[] }> = [];
    const run: RunJudge = async ({ filename, ruleUuids }) => {
        calls.push({ filename, ruleUuids });
        const key = filename ?? '__PR__';
        return (hits[key] || []).map(
            (h): RawShardViolation => ({
                ruleId: h.ruleId,
                relevantLinesStart: h.line ?? 1,
                suggestionContent: 'x',
                oneSentenceSummary: 's',
            }),
        );
    };
    return { run, calls };
}

describe('judgeKodyRulesSharded — deterministic file×rule sweep (#1449)', () => {
    it('issues one shard per changed file that has applicable rules', async () => {
        const { run, calls } = fakeJudge({});
        const res = await judgeKodyRulesSharded({
            changedFiles: [
                file('src/a.ts', '1 +const x: any = 1;'),
                file('src/b.ts', '1 +ok();'),
            ],
            rules: [
                { uuid: 'r1', title: 'no any', rule: 'no any', path: '**/*.ts' },
            ],
            runJudge: run,
        });
        // both files match **/*.ts → 2 shards, no PR shard
        expect(res.shardsRun).toBe(2);
        expect(calls.map((c) => c.filename).sort()).toEqual([
            'src/a.ts',
            'src/b.ts',
        ]);
    });

    it('applies the path filter: a file that matches no rule path is not sharded', async () => {
        const { run, calls } = fakeJudge({});
        const res = await judgeKodyRulesSharded({
            changedFiles: [
                file('src/a.ts', '1 +x'),
                file('docs/readme.md', '1 +hi'),
            ],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res.shardsRun).toBe(1);
        expect(calls[0].filename).toBe('src/a.ts');
    });

    it('resolves the ruleId index to the real uuid and anchors the violation to its file', async () => {
        const { run } = fakeJudge({ 'src/a.ts': [{ ruleId: 1, line: 5 }] });
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '5 +bad')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res.violations).toHaveLength(1);
        expect(res.violations[0].relevantFile).toBe('src/a.ts');
        expect(res.violations[0].ruleUuid).toBe('r1');
        expect(res.violations[0].relevantLinesStart).toBe(5);
    });

    it('maps each index to the corresponding rule when a shard has several rules', async () => {
        const { run } = fakeJudge({
            'src/a.ts': [{ ruleId: 2 }, { ruleId: 1 }],
        });
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [
                { uuid: 'first', title: 't', rule: 'r', path: '**/*.ts' },
                { uuid: 'second', title: 't', rule: 'r', path: '**/*.ts' },
            ],
            runJudge: run,
        });
        expect(res.violations.map((v) => v.ruleUuid).sort()).toEqual([
            'first',
            'second',
        ]);
    });

    it('drops a violation whose ruleId is out of range (hallucinated index)', async () => {
        const { run } = fakeJudge({
            'src/a.ts': [{ ruleId: 1 }, { ruleId: 5 }, { ruleId: 0 }],
        });
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res.violations.map((v) => v.ruleUuid)).toEqual(['r1']);
    });

    // #1170 fallback: if the model reverts to echoing the UUID instead of the
    // index, we still accept an exact match and recover a lightly-corrupted one
    // (edit distance ≤ 2 to exactly one shard rule) rather than dropping it.
    it('accepts a UUID echoed in ruleId, recovering a one-char corruption', async () => {
        const realUuid = '43063446-b519-4acc-9c4d-cc9eb8773a92';
        const corrupted = '43063446-b519-4acc-9c4d-cceb8773a92'; // '9' dropped
        const { run } = fakeJudge({ 'src/a.ts': [{ ruleId: corrupted }] });
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [{ uuid: realUuid, title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res.violations).toHaveLength(1);
        expect(res.violations[0].ruleUuid).toBe(realUuid);
    });

    it('drops an echoed UUID that is ambiguous between two rules', async () => {
        const { run } = fakeJudge({ 'src/a.ts': [{ ruleId: 'id-x' }] });
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [
                { uuid: 'id-a', title: 't', rule: 'r', path: '**/*.ts' },
                { uuid: 'id-b', title: 't', rule: 'r', path: '**/*.ts' },
            ],
            runJudge: run,
        });
        expect(res.violations).toHaveLength(0);
    });

    // A malformed entry (model omitted ruleId, or echoed the old `ruleUuid`
    // key) must be skipped on its own — not throw and take the whole shard's
    // real violations down with it via the per-shard try/catch.
    it('drops a malformed violation (missing ruleId) without discarding the rest of the shard', async () => {
        const run: RunJudge = async () => [
            { suggestionContent: 'no ruleId here' } as any,
            { ruleUuid: 'r1', suggestionContent: 'old key echoed' } as any,
            { ruleId: 1, relevantLinesStart: 3, suggestionContent: 'valid' },
        ];
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '3 +bad')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res.shardsErrored).toBe(0);
        expect(res.violations).toHaveLength(1);
        expect(res.violations[0].ruleUuid).toBe('r1');
    });

    it('runs PR-scope rules in a single whole-PR shard (no relevantFile)', async () => {
        const { run, calls } = fakeJudge({ __PR__: [{ ruleId: 1 }] });
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x'), file('src/b.ts', '1 +y')],
            rules: [
                {
                    uuid: 'pr1',
                    title: 'must have tests',
                    rule: 'every PR needs a test',
                    scope: KodyRulesScope.PULL_REQUEST,
                },
            ],
            runJudge: run,
        });
        // only the PR shard runs (no file-scope rules)
        expect(res.shardsRun).toBe(1);
        expect(calls[0].filename).toBeNull();
        expect(res.violations).toHaveLength(1);
        expect(res.violations[0].ruleUuid).toBe('pr1');
        expect(res.violations[0].relevantFile).toBeUndefined();
    });

    it('counts a shard error without aborting the sweep', async () => {
        let n = 0;
        const run: RunJudge = async ({ filename }) => {
            n++;
            if (filename === 'src/a.ts') throw new Error('llm blew up');
            return [
                { ruleId: 1, suggestionContent: 'x' } as RawShardViolation,
            ];
        };
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x'), file('src/b.ts', '1 +y')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
            concurrency: 1,
        });
        expect(res.shardsRun).toBe(2);
        expect(res.shardsErrored).toBe(1);
        expect(res.violations).toHaveLength(1); // only src/b.ts survived
    });
});
