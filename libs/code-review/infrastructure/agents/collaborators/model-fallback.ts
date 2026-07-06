/**
 * code-review (domain) — provider fallback for the v5 agent loop.
 *
 * The agent harness resolves ONE model and runs; unlike the v2 legacy flow
 * (LangChain `.withFallbacks`), it has no built-in retry against a second
 * provider. This wrapper gives the agent providers the same resilience the org
 * already expects from its BYOK `fallback` config: run the `main` model, and if
 * it fails, retry ONCE against `fallback`.
 *
 * "Fails" means EITHER:
 *   - a thrown provider/API error (e.g. preflight, or an error that escapes the
 *     harness), OR
 *   - a non-throwing FAILURE RESULT. The agent harness is "observable by
 *     construction": a model/provider throw inside the loop is caught and
 *     turned into an error-status result (finishReason 'error') instead of a
 *     bare exception. Verified end-to-end — a bogus main model produced
 *     "0 suggestions, 0 failures" and never threw. So a throw-only check would
 *     silently miss the main failure and never reach the fallback. `isFailure`
 *     detects that swallowed error so the fallback still fires.
 *
 * Budget exhaustion returns finishReason 'timeout' (not 'error'), so callers'
 * `isFailure` must NOT treat it as a failure — retrying a full loop after a
 * 30-min timeout would just double the latency.
 */
import type { AgentModelParams } from '@libs/code-review/infrastructure/agents/collaborators/model-factory';

export interface ProviderFallbackOptions<T> {
    /** Runs the model call for one role. Called at most twice (main, fallback). */
    attempt: (params: AgentModelParams) => Promise<T>;
    main: AgentModelParams;
    /** Null when the org configured no fallback provider. */
    fallback: AgentModelParams | null;
    /**
     * Decide whether a `main` failure should trigger the fallback. Defaults to
     * "always". Callers pass this to suppress fallback on genuine job
     * cancellation (retrying a cancelled review just wastes work). Receives the
     * thrown error, or the failed result when `isFailure` tripped.
     */
    shouldFallback?: (reason: unknown) => boolean;
    /**
     * Detects a non-throwing failure result (the harness swallows model errors
     * into an error-status result). Returning true for the main result triggers
     * the fallback exactly as a thrown error would.
     */
    isFailure?: (result: T) => boolean;
    /** Side-effect hook (logging/telemetry) fired just before the retry.
     *  Receives the thrown error or the failed result. */
    onFallback?: (reason: unknown) => void;
}

/**
 * Run `attempt(main)`; if it throws OR returns a failure result, optionally run
 * `attempt(fallback)` once. When there is no fallback (or `shouldFallback`
 * vetoes), the original error/result is preserved — behavior identical to the
 * pre-fallback code.
 */
export async function runWithProviderFallback<T>(
    opts: ProviderFallbackOptions<T>,
): Promise<T> {
    const fallbackAllowed = (reason: unknown) =>
        !!opts.fallback && (opts.shouldFallback?.(reason) ?? true);

    let mainResult: T;
    try {
        mainResult = await opts.attempt(opts.main);
    } catch (error) {
        if (!fallbackAllowed(error)) {
            throw error;
        }
        opts.onFallback?.(error);
        return opts.attempt(opts.fallback!);
    }

    // Non-throwing failure (harness-swallowed provider error): fall back too.
    if (opts.isFailure?.(mainResult) && fallbackAllowed(mainResult)) {
        opts.onFallback?.(mainResult);
        return opts.attempt(opts.fallback!);
    }

    return mainResult;
}
