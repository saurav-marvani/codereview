import {
    judgeKodyRulesSharded,
    shardViolationsSchema,
    RunJudge,
    ShardViolation,
} from './kody-rules-sharded.judge';
import { KodyRulesScope } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

// The one genuinely-new runtime risk in the wired provider is the ZOD schema
// (passed to PromptRunnerService.builder().setParser(ParserType.ZOD, ...))
// parsing the model's JSON. The builder/run chain itself is generic infra used
// by every agent. These pin the schema contract against realistic responses.
describe('shardViolationsSchema — model JSON parsing', () => {
    it('parses a well-formed file-level response', () => {
        const r = shardViolationsSchema.parse({
            violations: [
                {
                    ruleUuid: 'no-console',
                    relevantLinesStart: 42,
                    relevantLinesEnd: 42,
                    existingCode: 'console.log(x)',
                    suggestionContent: 'WHAT/WHY/HOW',
                    oneSentenceSummary: 'no console',
                },
            ],
        });
        expect(r.violations).toHaveLength(1);
        expect(r.violations[0].ruleUuid).toBe('no-console');
    });

    it('parses a PR-level response with no line fields', () => {
        const r = shardViolationsSchema.parse({
            violations: [{ ruleUuid: 'pr1', suggestionContent: 'needs a test' }],
        });
        expect(r.violations[0].relevantLinesStart).toBeUndefined();
    });

    it('defaults to an empty array when the model returns {} or empty', () => {
        expect(shardViolationsSchema.parse({}).violations).toEqual([]);
        expect(
            shardViolationsSchema.parse({ violations: [] }).violations,
        ).toEqual([]);
    });

    it('rejects a violation missing the required ruleUuid/suggestionContent', () => {
        expect(() =>
            shardViolationsSchema.parse({ violations: [{ relevantLinesStart: 1 }] }),
        ).toThrow();
    });
});

const file = (filename: string, patch: string): any => ({
    filename,
    patchWithLinesStr: patch,
    patch,
});

// A fake runJudge that returns a canned violation for a given (file, ruleUuid)
// pair. Lets us assert the deterministic orchestration without a live model.
function fakeJudge(
    hits: Record<string, Array<{ ruleUuid: string; line?: number }>>,
): { run: RunJudge; calls: Array<{ filename: string | null; ruleUuids: string[] }> } {
    const calls: Array<{ filename: string | null; ruleUuids: string[] }> = [];
    const run: RunJudge = async ({ filename, ruleUuids }) => {
        calls.push({ filename, ruleUuids });
        const key = filename ?? '__PR__';
        return (hits[key] || []).map(
            (h): ShardViolation => ({
                ruleUuid: h.ruleUuid,
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
            rules: [{ uuid: 'r1', title: 'no any', rule: 'no any', path: '**/*.ts' }],
            runJudge: run,
        });
        // both files match **/*.ts → 2 shards, no PR shard
        expect(res.shardsRun).toBe(2);
        expect(calls.map((c) => c.filename).sort()).toEqual(['src/a.ts', 'src/b.ts']);
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

    it('anchors every file-scope violation to its file and preserves ruleUuid', async () => {
        const { run } = fakeJudge({ 'src/a.ts': [{ ruleUuid: 'r1', line: 5 }] });
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

    it('drops violations with an invented ruleUuid not in the shard', async () => {
        const { run } = fakeJudge({
            'src/a.ts': [{ ruleUuid: 'r1' }, { ruleUuid: 'HALLUCINATED' }],
        });
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res.violations.map((v) => v.ruleUuid)).toEqual(['r1']);
    });

    // #1170: the LLM occasionally drops/transposes a character while echoing a
    // 36-char UUID. Recover the intended rule instead of silently dropping the
    // (otherwise correct) violation — same edit-distance recovery the mapper uses.
    it('recovers a file-scope violation whose ruleUuid the LLM corrupted by one char', async () => {
        // exactly the corruption observed in #1170: the '9' in "cc9eb" dropped
        const realUuid = '43063446-b519-4acc-9c4d-cc9eb8773a92';
        const corrupted = '43063446-b519-4acc-9c4d-cceb8773a92';
        const { run } = fakeJudge({ 'src/a.ts': [{ ruleUuid: corrupted, line: 7 }] });
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '7 +bad')],
            rules: [{ uuid: realUuid, title: 't', rule: 'r', path: '**/*.ts' }],
            runJudge: run,
        });
        expect(res.violations).toHaveLength(1);
        expect(res.violations[0].ruleUuid).toBe(realUuid);
        expect(res.violations[0].relevantFile).toBe('src/a.ts');
    });

    it('recovers a corrupted ruleUuid on the PR-scope shard too', async () => {
        const realUuid = '9f8e7d6c-5432-10ba-fedc-0987654321ba';
        const corrupted = '9f8e7d6c-5432-10ba-fedc-098765431ba'; // one digit dropped
        const { run } = fakeJudge({ __PR__: [{ ruleUuid: corrupted }] });
        const res = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +x')],
            rules: [
                {
                    uuid: realUuid,
                    title: 'must have tests',
                    rule: 'every PR needs a test',
                    scope: KodyRulesScope.PULL_REQUEST,
                },
            ],
            runJudge: run,
        });
        expect(res.violations).toHaveLength(1);
        expect(res.violations[0].ruleUuid).toBe(realUuid);
    });

    it('still drops a corrupted ruleUuid that is ambiguous between two rules', async () => {
        // "id-a"/"id-b" differ only in the last char, so a "id-x" that is
        // distance 1 from BOTH is ambiguous → dropped, not guessed.
        const { run } = fakeJudge({ 'src/a.ts': [{ ruleUuid: 'id-x' }] });
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

    it('runs PR-scope rules in a single whole-PR shard (no relevantFile)', async () => {
        const { run, calls } = fakeJudge({ __PR__: [{ ruleUuid: 'pr1' }] });
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
            return [{ ruleUuid: 'r1', suggestionContent: 'x' } as ShardViolation];
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
