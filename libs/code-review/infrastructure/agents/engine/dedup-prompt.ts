/**
 * Shared dedup prompt + schema + model, extracted from
 * `agent-review.stage.ts#deduplicateSuggestions` so production and the
 * `evals/dedup` harness call the SAME prompt — no drift between what ships and
 * what we measure. Behavior-preserving: production imports these and keeps its
 * own group→kept mapping; the eval reuses them to invoke the real dedup decision.
 */

/** JSON schema for the dedup LLM output (groups + unique indices). */
export const DEDUP_SCHEMA = {
    type: 'object',
    properties: {
        groups: {
            type: 'array',
            description:
                'Groups of suggestions. Each group has a representative and its duplicates.',
            items: {
                type: 'object',
                properties: {
                    keep: {
                        type: 'number',
                        description:
                            'Index of the best suggestion to keep as representative',
                    },
                    duplicates: {
                        type: 'array',
                        items: { type: 'number' },
                        description:
                            'Indices of duplicate suggestions (same bug, same or different locations)',
                    },
                },
                required: ['keep', 'duplicates'],
                additionalProperties: false,
            },
        },
        unique: {
            type: 'array',
            items: { type: 'number' },
            description: 'Indices of suggestions that have no duplicates',
        },
    },
    required: ['groups', 'unique'],
    additionalProperties: false,
} as const;

// Content guard: the LLM proposes which suggestions to merge, but only honor a
// merge when the two findings actually describe the same thing. We measure that
// with word-overlap (Jaccard) of summary+fix+content. A low-similarity "duplicate"
// is a DIFFERENT bug the model over-merged (e.g. two distinct issues on
// overlapping lines) — keep it instead of dropping. 0.3 was tuned on the dedup
// eval (39 PRs / 136 goldens): over-merge 3.0→0, no real bug dropped across 6 runs.
export const DEDUP_CONTENT_THRESHOLD = 0.3;

function contentWords(f?: { oneSentenceSummary?: string; improvedCode?: string; suggestionContent?: string }): Set<string> {
    const text = `${f?.oneSentenceSummary || ''} ${f?.improvedCode || ''} ${f?.suggestionContent || ''}`;
    return new Set(text.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) || []);
}

/** Word-overlap (Jaccard) of two findings' text. 0 = nothing in common, 1 = identical. */
export function contentSimilarity(
    a?: { oneSentenceSummary?: string; improvedCode?: string; suggestionContent?: string },
    b?: { oneSentenceSummary?: string; improvedCode?: string; suggestionContent?: string },
): number {
    const A = contentWords(a), B = contentWords(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    return inter / (A.size + B.size - inter);
}

type DedupSuggestionLike = {
    relevantFile?: string;
    relevantLinesStart?: number | string;
    relevantLinesEnd?: number | string;
    label?: string;
    severity?: string;
    oneSentenceSummary?: string;
    suggestionContent?: string;
    improvedCode?: string;
};

/**
 * Build the per-suggestion summary block the dedup model sees. `normalizeSeverity`
 * is injected so production keeps its exact severity normalization; callers that
 * don't need it (the eval) can pass an identity function.
 */
export function buildDedupSummaries(
    suggestions: DedupSuggestionLike[],
    normalizeSeverity: (severity?: string) => string,
): string {
    return suggestions
        .map(
            (s, i) =>
                `[${i}] ${s.relevantFile || 'unknown'}:${s.relevantLinesStart}-${s.relevantLinesEnd} [${s.label || 'unknown'}/${normalizeSeverity(s.severity)}]: ${s.oneSentenceSummary || s.suggestionContent?.substring(0, 200)}${s.improvedCode ? `\n    fix: ${s.improvedCode.substring(0, 100)}` : ''}`,
        )
        .join('\n');
}

/** Full dedup prompt (instructions + the suggestion summaries). */
export function buildDedupPrompt(
    suggestions: DedupSuggestionLike[],
    normalizeSeverity: (severity?: string) => string,
): string {
    const summaries = buildDedupSummaries(suggestions, normalizeSeverity);
    return `You have ${suggestions.length} code review suggestions across multiple files in a PR. Identify duplicates and group them.

BE CONSERVATIVE — when in doubt, do NOT group. Only group when you are highly confident they describe the exact same bug.

There are TWO types of duplicates:

1. **EXACT DUPLICATES** (same bug, same location): Multiple suggestions pointing to the same file and overlapping lines describing the same issue. Keep the one with the most detail, discard the rest.

2. **CROSS-LOCATION DUPLICATES** (same bug pattern, different locations): Suggestions describing the EXACT SAME code pattern/bug but applied in different files (e.g., "forEach with async callback" found in 3 different files, or "missing null check on the same API call" in 2 files). These should be GROUPED — keep the best one as representative, list the others as duplicates.

NOT duplicates (keep both):
- Different bugs in the same file or nearby lines (e.g., "nil pointer" and "missing validation" in the same controller — these are DIFFERENT bugs)
- Different root causes even if they sound similar (e.g., "add nil check" vs "fix typo" — different problems)
- Suggestions about different code even if the description sounds similar

IGNORE the category label (bug/security/performance) when deciding — two agents can independently find the same issue.
Prefer keeping the suggestion with the most detail or clearest fix as the representative.

${summaries}`;
}
