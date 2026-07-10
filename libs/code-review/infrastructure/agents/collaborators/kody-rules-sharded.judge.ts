/**
 * Deterministic sharded judge for kody-rules (issue #1449).
 *
 * The agentic KodyRulesAgentProvider under-covers because it lets the LLM
 * decide which files to open inside a turn budget; on large PRs the violating
 * file is never read (measured: gpt-5.4 40%, kimi 58% occurrence-recall).
 *
 * This replaces the traversal with a DETERMINISTIC sweep: code iterates every
 * changed file × its path-applicable rules and issues ONE single-shot LLM call
 * per file with those rules batched in. Coverage becomes a structural guarantee
 * — the model only judges "does this diff violate these rules?", never decides
 * where to look. Validated on the frozen github-cases benchmark: 91-100%
 * occurrence-recall across gpt-5.4 / gpt-5.4-mini / kimi, ~same-or-lower cost.
 *
 * Pure orchestration: the LLM call is injected as `runJudge` so this is
 * unit-testable against replayed diffs without a live model (same contract the
 * evals use). PR-level rules (scope: pull_request) get one whole-PR call.
 *
 * Out of scope here (later phases): the T0 regex compiler, T2 reference-file
 * inlining, hybrid regex+judge, compound-rule decomposition.
 */
import { z } from 'zod';
import { fileMatchesRulePath } from '@libs/common/utils/kody-rules/file-patterns';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    IKodyRule,
    KodyRulesScope,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/**
 * Parser schema for a shard's JSON output. The provider passes this to
 * `.setParser(ParserType.ZOD, shardViolationsSchema)` so a malformed model
 * response is retried/repaired by the runner before it reaches us.
 */
export const shardViolationsSchema = z.object({
    violations: z
        .array(
            z.object({
                ruleUuid: z.string(),
                relevantLinesStart: z.number().optional(),
                relevantLinesEnd: z.number().optional(),
                language: z.string().optional(),
                existingCode: z.string().optional(),
                improvedCode: z.string().optional(),
                suggestionContent: z.string(),
                oneSentenceSummary: z.string().optional(),
            }),
        )
        .default([]),
});

/** One violation the model reports for a (file, rule) pair. */
export interface ShardViolation {
    ruleUuid: string;
    relevantFile?: string;
    relevantLinesStart?: number;
    relevantLinesEnd?: number;
    language?: string;
    suggestionContent: string;
    existingCode?: string;
    improvedCode?: string;
    oneSentenceSummary?: string;
}

/**
 * The injected single-shot LLM call. The provider supplies a closure backed by
 * BYOKPromptRunnerService.builder() (so it runs on the customer's model); tests
 * supply a replay. Returns the parsed violations for this shard, or [] on a
 * parse/LLM miss (the caller counts errors separately).
 */
export type RunJudge = (args: {
    system: string;
    user: string;
    /** file the shard covers, or null for the PR-level shard. */
    filename: string | null;
    /** rule uuids in scope for this shard — used to filter hallucinated ids. */
    ruleUuids: string[];
}) => Promise<ShardViolation[]>;

export interface ShardedJudgeInput {
    changedFiles: FileChange[];
    /** active, non-memory STANDARD rules already resolved for this review. */
    rules: Array<Partial<IKodyRule>>;
    runJudge: RunJudge;
    prTitle?: string;
    prBody?: string;
    /** max concurrent shard calls (BYOK models rate-limit — keep modest). */
    concurrency?: number;
}

export interface ShardedJudgeResult {
    violations: ShardViolation[];
    shardsRun: number;
    shardsErrored: number;
}

// ── prompts (aligned with the validated batched eval prompt) ─────────────────

export const SHARD_SYSTEM_PROMPT = `You check a set of team rules against the diff of a SINGLE file. Report EVERY added line that violates ANY of the listed rules — one entry per (rule, violating line).

Rules of engagement:
- Only flag lines ADDED in this diff (each line is prefixed with its file line number then '+'). Unchanged context lines are NEVER flagged.
- One entry PER violating line PER rule; do not collapse repeats. Downstream dedup folds repeats into one comment.
- Use the EXACT rule uuid from the list. Never invent a uuid; if a real issue matches no listed rule, DROP it.
- If nothing violates, return an empty list.`;

export const SHARD_PR_SYSTEM_PROMPT = `You evaluate PULL-REQUEST-level team rules against a PR's metadata (title, description, and the list of changed files). Judge the PR as a whole. Use the EXACT rule uuid from the list; never invent one. Return only real violations.`;

function ruleBlock(rules: Array<Partial<IKodyRule>>): string {
    return rules
        .map((r) => {
            const parts = [
                `- uuid: ${r.uuid}`,
                `  title: ${r.title}`,
                `  description: ${r.rule}`,
            ];
            if (r.examples?.length) {
                parts.push(`  examples:`);
                for (const ex of r.examples) {
                    const label = ex.isCorrect ? 'correct' : 'incorrect';
                    parts.push(`    - ${label}: ${JSON.stringify(ex.snippet)}`);
                }
            }
            return parts.join('\n');
        })
        .join('\n');
}

function fileShardUser(
    file: FileChange,
    rules: Array<Partial<IKodyRule>>,
): string {
    const diff = (file as any).patchWithLinesStr ?? file.patch ?? '';
    return [
        `<Rules>`,
        ruleBlock(rules),
        `</Rules>`,
        ``,
        `<File path="${file.filename}">`,
        `Each diff line is prefixed with its file line number; '+' marks a line ADDED by this PR.`,
        '```diff',
        diff,
        '```',
        `</File>`,
        ``,
        `Return ONLY JSON:`,
        `{"violations":[{"ruleUuid":"<uuid>","relevantLinesStart":<line>,"relevantLinesEnd":<line>,"existingCode":"<offending code>","suggestionContent":"WHAT/WHY/HOW","oneSentenceSummary":"<short>"}]}`,
    ].join('\n');
}

function prShardUser(
    files: FileChange[],
    rules: Array<Partial<IKodyRule>>,
    prTitle?: string,
    prBody?: string,
): string {
    return [
        `<Rules>`,
        ruleBlock(rules),
        `</Rules>`,
        ``,
        `<PR title=${JSON.stringify(prTitle || '')}>`,
        `Description: ${prBody ? prBody.slice(0, 1000) : '(empty)'}`,
        `Changed files (${files.length}):`,
        ...files.map((f) => `- ${f.filename}`),
        `</PR>`,
        ``,
        `Return ONLY JSON: {"violations":[{"ruleUuid":"<uuid>","suggestionContent":"WHAT/WHY","oneSentenceSummary":"<short>"}]}`,
    ].join('\n');
}

// ── path filtering (mirrors KodyRulesAgentProvider.matchesPathPattern) ───────
import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';

export function ruleAppliesToFile(filePath: string, pattern?: string): boolean {
    if (!pattern) return true;
    // Shared helper: rule paths may be several comma-joined globs — see
    // fileMatchesRulePath for why matching the joined string is a bug.
    return fileMatchesRulePath(filePath, pattern);
}

function matchesPathPattern(filePath: string, pattern: string): boolean {
    return ruleAppliesToFile(filePath, pattern);
}

function rulesForFile(
    file: FileChange,
    rules: Array<Partial<IKodyRule>>,
): Array<Partial<IKodyRule>> {
    return rules.filter(
        (r) => !r.path || matchesPathPattern(file.filename, r.path),
    );
}

const isPrLevel = (r: Partial<IKodyRule>) =>
    r.scope === KodyRulesScope.PULL_REQUEST;

async function mapLimit<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const out = new Array<R>(items.length);
    let i = 0;
    await Promise.all(
        Array.from(
            { length: Math.min(Math.max(1, limit), items.length || 1) },
            async () => {
                while (i < items.length) {
                    const idx = i++;
                    out[idx] = await fn(items[idx]);
                }
            },
        ),
    );
    return out;
}

/**
 * T2 reference-inline (pure): for each rule that points at a repo file
 * (`sourcePath`), fetch that file via the injected `read` and append its
 * content to the rule text so the judge sees the full convention. Deterministic
 * (code follows `sourcePath`; the model never decides what to open). Missing
 * file / read error / no sandbox all degrade to the rule text alone — never
 * worse than not having the reference. Extracted here (not on the provider) so
 * it is unit-testable without the provider's heavy import graph.
 */
export async function inlineRuleReferences(
    rules: Array<Partial<IKodyRule>>,
    read:
        | ((path: string, start: number, end: number) => Promise<string>)
        | undefined,
    logger?: { warn: (entry: any) => void },
    maxRefChars = 6000,
): Promise<Array<Partial<IKodyRule>>> {
    if (!read) return rules;
    return Promise.all(
        rules.map(async (rule) => {
            const sourcePath = rule.sourcePath?.trim();
            if (!sourcePath) return rule;
            try {
                const content = await read(sourcePath, 1, 100000);
                if (!content || content.trim().length === 0) return rule;
                const anchor = rule.sourceAnchor
                    ? ` (section: ${rule.sourceAnchor})`
                    : '';
                return {
                    ...rule,
                    rule: `${rule.rule}\n\n[Authoritative convention referenced by this rule — from \`${sourcePath}\`${anchor}]:\n${content.slice(0, maxRefChars)}`,
                };
            } catch (err) {
                logger?.warn({
                    message: `kody-rules reference load failed for ${sourcePath} (rule ${rule.uuid}); judging without it`,
                    metadata: { ruleUuid: rule.uuid, sourcePath, err },
                });
                return rule;
            }
        }),
    );
}

/**
 * Run the deterministic file×rule sweep. File-scope rules → one call per file
 * with its applicable rules; PR-scope rules → one whole-PR call. Returns all
 * violations with their ruleUuid preserved (downstream mapping fills
 * brokenKodyRulesIds and reconciles the uuid).
 */
export async function judgeKodyRulesSharded(
    input: ShardedJudgeInput,
): Promise<ShardedJudgeResult> {
    const { changedFiles, rules, runJudge, prTitle, prBody } = input;
    const concurrency = input.concurrency ?? 4;

    const fileRules = rules.filter((r) => !isPrLevel(r));
    const prRules = rules.filter(isPrLevel);

    let shardsRun = 0;
    let shardsErrored = 0;
    const violations: ShardViolation[] = [];

    // ── file-scope shards: one per changed file that has applicable rules ────
    const fileShards = changedFiles
        .map((file) => ({ file, applicable: rulesForFile(file, fileRules) }))
        .filter((s) => s.applicable.length > 0);

    const perFile = await mapLimit(
        fileShards,
        concurrency,
        async ({ file, applicable }) => {
            shardsRun++;
            const ruleUuids = applicable.map((r) => r.uuid!).filter(Boolean);
            try {
                const vs = await runJudge({
                    system: SHARD_SYSTEM_PROMPT,
                    user: fileShardUser(file, applicable),
                    filename: file.filename,
                    ruleUuids,
                });
                // anchor + scope every violation to this file, drop invented uuids
                const known = new Set(ruleUuids);
                return vs
                    .filter((v) => known.has(v.ruleUuid))
                    .map((v) => ({ ...v, relevantFile: file.filename }));
            } catch {
                shardsErrored++;
                return [] as ShardViolation[];
            }
        },
    );
    for (const vs of perFile) violations.push(...vs);

    // ── PR-scope shard: one call over the whole PR ──────────────────────────
    if (prRules.length > 0) {
        shardsRun++;
        const ruleUuids = prRules.map((r) => r.uuid!).filter(Boolean);
        try {
            const vs = await runJudge({
                system: SHARD_PR_SYSTEM_PROMPT,
                user: prShardUser(changedFiles, prRules, prTitle, prBody),
                filename: null,
                ruleUuids,
            });
            const known = new Set(ruleUuids);
            // PR-level violations carry no relevantFile by design
            for (const v of vs) if (known.has(v.ruleUuid)) violations.push(v);
        } catch {
            shardsErrored++;
        }
    }

    return { violations, shardsRun, shardsErrored };
}
