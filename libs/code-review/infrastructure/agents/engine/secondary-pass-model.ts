import { createOpenAI } from '@ai-sdk/openai';
import { getInternalModel } from '@libs/code-review/infrastructure/agents/llm/byok-to-vercel';
import type { BYOKConfig } from '@kodus/kodus-common/llm';

/**
 * Model for the review's SECONDARY passes (dedup, severity classification,
 * suggestion formatting) — NOT the main finding-generation pass.
 *
 * These run on one cheap, CONSISTENT platform model rather than the client's
 * main BYOK model, on purpose:
 *   - consistency — severity/formatting must not vary by which model the client
 *     configured (see classify-severity's contract);
 *   - cost — don't burn the client's main-model tokens on utility work;
 *   - resilience — a separate vendor from the main review. gpt-5.4-mini replaced
 *     gemini-3-flash-preview because the Google project can get rate-denied
 *     env-wide, silently failing these passes (see dedup swap, PR #1399).
 *
 * BYOK is only the FALLBACK, for self-hosted envs with no platform OpenAI key.
 */
export const SECONDARY_PASS_MODEL_ID = 'gpt-5.4-mini';

/**
 * Resolve the secondary-pass model:
 *   1. Platform OpenAI key → gpt-5.4-mini (cloud default)
 *   2. else → getInternalModel(byokConfig) (self-hosted / BYOK fallback)
 * Returns null when nothing is configured; callers skip the pass gracefully.
 */
export function resolveSecondaryPassModel(byokConfig?: BYOKConfig): any {
    const openaiKey = process.env.API_OPEN_AI_API_KEY;
    if (openaiKey) {
        return createOpenAI({
            apiKey: openaiKey,
            ...(process.env.API_OPENAI_FORCE_BASE_URL
                ? { baseURL: process.env.API_OPENAI_FORCE_BASE_URL }
                : {}),
        })(SECONDARY_PASS_MODEL_ID);
    }
    return getInternalModel(byokConfig);
}
