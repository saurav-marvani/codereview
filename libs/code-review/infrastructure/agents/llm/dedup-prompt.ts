/**
 * Shared dedup prompt + schema + model, extracted from
 * `agent-review.stage.ts#deduplicateSuggestions` so production and the
 * `evals/dedup` harness call the SAME prompt — no drift between what ships and
 * what we measure. Behavior-preserving: production imports these and keeps its
 * own group→kept mapping; the eval reuses them to invoke the real dedup decision.
 */

// Production dedup model. Swapped off gemini-3-flash for resilience: the Google
// project can get rate-denied env-wide (silently disabling dedup). gpt-5.4-mini
// is quality-equivalent on the dedup eval (within run-to-run noise) and on a
// separate vendor. Provider in agent-review.stage.ts must match (OpenAI).
export const DEDUP_MODEL_ID = 'gpt-5.4-mini';

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
