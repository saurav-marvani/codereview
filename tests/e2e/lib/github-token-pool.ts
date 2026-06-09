/**
 * GitHub e2e token pool.
 *
 * GitHub's rate limits — both the 5k/h primary budget and (worse for us) the
 * per-account *secondary* limits on content creation (branches/PRs/comments) —
 * are charged PER ACCOUNT. The matrix runs ~dozens of GitHub cells through a
 * single bot token, so one account's budget is the ceiling for the whole run;
 * when it trips we get `HTTP 403` / opaque `items is not iterable` failures.
 *
 * Spreading the cells across several bot accounts multiplies both budgets
 * linearly. This module just resolves the available tokens; the runner does
 * the round-robin assignment per GitHub cell.
 *
 * Sources, in priority order:
 *   1. `GH_TEST_TOKENS` — a single secret holding a comma/space/newline list
 *      (easiest to manage as one secret).
 *   2. `GH_TEST_TOKEN` + `GH_TEST_TOKEN_2..N` — the base token plus numbered
 *      siblings, one per extra bot account.
 *
 * Always backward compatible: with only `GH_TEST_TOKEN` set, the pool is a
 * single token and behaviour is identical to before.
 */

const MAX_NUMBERED = 9;

function dedupe(tokens: string[]): string[] {
    return [...new Set(tokens.map((t) => t.trim()).filter(Boolean))];
}

export function githubTokenPool(
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    const list = env.GH_TEST_TOKENS?.split(/[\s,]+/);
    if (list && dedupe(list).length > 0) {
        return dedupe(list);
    }

    const numbered: string[] = [];
    if (env.GH_TEST_TOKEN) numbered.push(env.GH_TEST_TOKEN);
    for (let i = 2; i <= MAX_NUMBERED; i++) {
        const v = env[`GH_TEST_TOKEN_${i}`];
        if (v) numbered.push(v);
    }
    return dedupe(numbered);
}

export interface GithubTokenAssignment {
    /** The token to use, or undefined when no pool is configured (caller
     *  falls back to the provider's own requireEnv("GH_TEST_TOKEN")). */
    token: string | undefined;
    /** 1-based slot for logging (0 when the pool is empty). */
    slot: number;
    /** Pool size — `size > 1` is the only case worth logging. */
    size: number;
}

/**
 * Round-robin picker over the pool. Returns the next assignment (token + slot)
 * each call, so the runner can both use the token and log WHICH account it
 * rotated to (the slot, never the secret).
 */
export function makeGithubTokenPicker(
    env: NodeJS.ProcessEnv = process.env,
): () => GithubTokenAssignment {
    const pool = githubTokenPool(env);
    let i = 0;
    return () => {
        if (!pool.length) return { token: undefined, slot: 0, size: 0 };
        const slot = i++ % pool.length;
        return { token: pool[slot], slot: slot + 1, size: pool.length };
    };
}
