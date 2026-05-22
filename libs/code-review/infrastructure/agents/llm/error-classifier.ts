/**
 * Canonical categories for LLM/provider errors surfaced during a code review.
 *
 * Why canonical instead of raw provider errors: callers (AgentReviewStage,
 * UI dashboards, end-review message) need to react to error meaning, not
 * provider-specific strings. The 4 BYOK provider families return errors in
 * different shapes — this enum is the agnostic contract.
 *
 * Terminal categories (AUTH_INVALID / QUOTA_EXCEEDED / MODEL_NOT_FOUND)
 * mean the review cannot succeed without user action — caller may short-
 * circuit remaining stages. TRANSIENT/RATE_LIMIT means "retry-worthy".
 */
export enum ReviewErrorCategory {
    AUTH_INVALID = 'AUTH_INVALID',
    QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
    RATE_LIMIT = 'RATE_LIMIT',
    MODEL_NOT_FOUND = 'MODEL_NOT_FOUND',
    CONTEXT_OVERFLOW = 'CONTEXT_OVERFLOW',
    TRANSIENT = 'TRANSIENT',
    UNKNOWN = 'UNKNOWN',
}

export interface ClassifiedErrorInfo {
    category: ReviewErrorCategory;
    provider?: string;
    rawMessage: string;
    httpStatus?: number;
    /** Short, human-readable message safe to surface to the end user. */
    friendlyMessage: string;
}

const CLASSIFICATION_KEY = Symbol('reviewErrorClassification');

/**
 * Attach classification metadata to an Error so downstream catch blocks
 * (e.g. AgentReviewStage iterating `result.failures`) can read it without
 * re-classifying. The property is non-enumerable so it doesn't leak into
 * JSON.stringify or span recordings.
 */
export function attachClassification<T extends object>(
    err: T,
    info: ClassifiedErrorInfo,
): T {
    try {
        Object.defineProperty(err, CLASSIFICATION_KEY, {
            value: info,
            enumerable: false,
            writable: false,
            configurable: true,
        });
    } catch {
        // Frozen errors — silently ignore; getClassification will reclassify if needed.
    }
    return err;
}

export function getClassification(
    err: unknown,
): ClassifiedErrorInfo | undefined {
    if (!err || typeof err !== 'object') return undefined;
    return (err as Record<symbol, ClassifiedErrorInfo | undefined>)[
        CLASSIFICATION_KEY
    ];
}

/**
 * Classify a raw provider error into the canonical category.
 *
 * Order matters: HTTP status code first (most reliable across providers),
 * then known error-code/message substrings as fallback.
 *
 * Pure function — does not mutate the input.
 */
export function classifyLLMError(
    err: unknown,
    provider?: string,
): ClassifiedErrorInfo {
    const rawMessage =
        err instanceof Error ? err.message : String(err ?? 'unknown');
    const lower = rawMessage.toLowerCase();
    const httpStatus = extractHttpStatus(err);

    let category = matchByHttpStatus(httpStatus, lower);
    if (category === ReviewErrorCategory.UNKNOWN) {
        category = matchByMessage(lower);
    }

    return {
        category,
        provider,
        rawMessage,
        httpStatus,
        friendlyMessage: buildFriendlyMessage(category, provider),
    };
}

/**
 * Returns true for categories where retrying without user intervention is
 * pointless: the user must fix billing/auth/config first.
 */
export function isTerminalCategory(category: ReviewErrorCategory): boolean {
    return (
        category === ReviewErrorCategory.AUTH_INVALID ||
        category === ReviewErrorCategory.QUOTA_EXCEEDED ||
        category === ReviewErrorCategory.MODEL_NOT_FOUND
    );
}

function extractHttpStatus(err: unknown): number | undefined {
    if (!err || typeof err !== 'object') return undefined;
    const e = err as {
        status?: number;
        statusCode?: number;
        response?: { status?: number };
        cause?: { status?: number; statusCode?: number };
    };
    return (
        e.status ??
        e.statusCode ??
        e.response?.status ??
        e.cause?.status ??
        e.cause?.statusCode ??
        undefined
    );
}

function matchByHttpStatus(
    status: number | undefined,
    lowerMessage: string,
): ReviewErrorCategory {
    if (status === undefined) return ReviewErrorCategory.UNKNOWN;
    if (status === 401 || status === 403) {
        return ReviewErrorCategory.AUTH_INVALID;
    }
    if (status === 402) {
        return ReviewErrorCategory.QUOTA_EXCEEDED;
    }
    if (status === 429) {
        // 429 is ambiguous: rate limit OR billing quota. Disambiguate via message.
        return looksLikeQuota(lowerMessage)
            ? ReviewErrorCategory.QUOTA_EXCEEDED
            : ReviewErrorCategory.RATE_LIMIT;
    }
    if (status === 404) {
        // Most provider 404s on the inference endpoint are model-not-found.
        return ReviewErrorCategory.MODEL_NOT_FOUND;
    }
    if (status >= 500 && status < 600) {
        return ReviewErrorCategory.TRANSIENT;
    }
    return ReviewErrorCategory.UNKNOWN;
}

function looksLikeQuota(lower: string): boolean {
    return (
        lower.includes('quota') ||
        lower.includes('credit') ||
        lower.includes('billing') ||
        lower.includes('payment')
    );
}

function matchByMessage(lower: string): ReviewErrorCategory {
    if (
        lower.includes('insufficient_quota') ||
        lower.includes('insufficient quota') ||
        lower.includes('credit_balance_too_low') ||
        lower.includes('insufficient credits') ||
        lower.includes('quota exceeded') ||
        lower.includes('billing') ||
        lower.includes('payment required')
    ) {
        return ReviewErrorCategory.QUOTA_EXCEEDED;
    }
    if (
        lower.includes('invalid_api_key') ||
        lower.includes('invalid api key') ||
        lower.includes('incorrect api key') ||
        lower.includes('unauthorized') ||
        lower.includes('authentication failed') ||
        lower.includes('permission_denied')
    ) {
        return ReviewErrorCategory.AUTH_INVALID;
    }
    if (
        lower.includes('rate_limit') ||
        lower.includes('rate limit') ||
        lower.includes('too many requests')
    ) {
        return ReviewErrorCategory.RATE_LIMIT;
    }
    if (
        lower.includes('model_not_found') ||
        lower.includes('model not found') ||
        lower.includes('no such model') ||
        lower.includes('does not exist')
    ) {
        return ReviewErrorCategory.MODEL_NOT_FOUND;
    }
    if (
        lower.includes('context length') ||
        lower.includes('context_length') ||
        lower.includes('maximum context') ||
        lower.includes('token limit') ||
        lower.includes('too many tokens')
    ) {
        return ReviewErrorCategory.CONTEXT_OVERFLOW;
    }
    if (
        lower.includes('econnreset') ||
        lower.includes('etimedout') ||
        lower.includes('socket hang up') ||
        lower.includes('network error') ||
        lower.includes('fetch failed') ||
        lower.includes('timeout') ||
        lower.includes('aborted')
    ) {
        return ReviewErrorCategory.TRANSIENT;
    }
    return ReviewErrorCategory.UNKNOWN;
}

function buildFriendlyMessage(
    category: ReviewErrorCategory,
    provider?: string,
): string {
    const providerLabel = provider ? ` (${provider})` : '';
    switch (category) {
        case ReviewErrorCategory.AUTH_INVALID:
            return `The configured API key${providerLabel} appears invalid or lacks permission. Check the key in your settings.`;
        case ReviewErrorCategory.QUOTA_EXCEEDED:
            return `The configured API key${providerLabel} is out of credits or has hit its billing limit. Top up the account or adjust the plan.`;
        case ReviewErrorCategory.RATE_LIMIT:
            return `Rate limit reached on the provider${providerLabel}. Try again in a few minutes.`;
        case ReviewErrorCategory.MODEL_NOT_FOUND:
            return `The configured model is not available on the provider${providerLabel}. Verify the model name in your settings.`;
        case ReviewErrorCategory.CONTEXT_OVERFLOW:
            return `The PR exceeded the maximum context size accepted by the model${providerLabel}.`;
        case ReviewErrorCategory.TRANSIENT:
            return `Transient error reaching the provider${providerLabel}. Try again.`;
        default:
            return `Unexpected error while running the code review${providerLabel}.`;
    }
}
