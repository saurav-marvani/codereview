/**
 * Maps BYOKConfig to a Vercel AI SDK LanguageModel.
 *
 * This adapter converts the Kodus BYOK configuration (provider + apiKey + model)
 * into a Vercel AI SDK model instance that supports native function calling.
 */
import type { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { BYOKConfig, BYOKProvider } from '@kodus/kodus-common/llm';
import { decrypt } from '@libs/common/utils/crypto';

/**
 * Default model config when no BYOK is configured.
 */
const DEFAULT_MODEL = {
    provider: BYOKProvider.GOOGLE_GEMINI,
    model: 'gemini-2.5-pro',
};

/**
 * Convert a BYOKConfig to a Vercel AI SDK LanguageModel.
 *
 * Supports all BYOKProvider types:
 * - OPENAI → @ai-sdk/openai
 * - ANTHROPIC → @ai-sdk/anthropic
 * - GOOGLE_GEMINI → @ai-sdk/google
 * - GOOGLE_VERTEX → @ai-sdk/google-vertex
 * - OPEN_ROUTER → @ai-sdk/openai-compatible (OpenRouter is OpenAI-compatible)
 * - OPENAI_COMPATIBLE → @ai-sdk/openai-compatible
 * - NOVITA → @ai-sdk/openai-compatible
 */
export function byokToVercelModel(
    byokConfig?: BYOKConfig,
    role: 'main' | 'fallback' = 'main',
): LanguageModel {
    const config =
        role === 'fallback' ? byokConfig?.fallback : byokConfig?.main;

    if (!config) {
        // No BYOK — use default with environment API key
        const googleKey =
            process.env.API_GOOGLE_AI_API_KEY ||
            process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
            '';
        return createGoogleGenerativeAI({ apiKey: googleKey })(
            'gemini-2.5-pro',
        );
    }

    const { provider, model, baseURL } = config;
    const apiKey = decrypt(config.apiKey);

    switch (provider) {
        case BYOKProvider.OPENAI:
            return createOpenAI({
                apiKey,
                ...(baseURL ? { baseURL } : {}),
            })(model);

        case BYOKProvider.ANTHROPIC:
            return createAnthropic({
                apiKey,
                ...(baseURL ? { baseURL } : {}),
            })(model);

        case BYOKProvider.GOOGLE_GEMINI:
            return createGoogleGenerativeAI({
                apiKey,
                ...(baseURL ? { baseURL } : {}),
            })(model);

        case BYOKProvider.OPEN_ROUTER:
            return createOpenAICompatible({
                name: 'open-router',
                apiKey,
                baseURL: baseURL || 'https://openrouter.ai/api/v1',
            })(model);

        case BYOKProvider.OPENAI_COMPATIBLE:
            return createOpenAICompatible({
                name: 'openai-compatible',
                apiKey,
                baseURL: baseURL || '',
            })(model);

        case BYOKProvider.NOVITA:
            return createOpenAICompatible({
                name: 'novita',
                apiKey,
                baseURL: baseURL || 'https://api.novita.ai/v3/openai',
            })(model);

        case BYOKProvider.GOOGLE_VERTEX:
            // Vertex requires project/location config, fall back to Gemini
            return createGoogleGenerativeAI({ apiKey })(model);

        default:
            // Unknown provider — try as OpenAI-compatible
            return createOpenAICompatible({
                name: String(provider),
                apiKey,
                baseURL: baseURL || '',
            })(model);
    }
}

/**
 * Extract a human-readable model name from BYOK config.
 */
export function getModelName(byokConfig?: BYOKConfig): string {
    if (!byokConfig?.main) return DEFAULT_MODEL.model;
    return `${byokConfig.main.provider}:${byokConfig.main.model}`;
}

/**
 * Get a cheap/fast model for internal operations (fallback structuring, dedup).
 *
 * Priority order:
 * 1. BYOK fallback/main model (client is paying)
 * 2. Self-hosted configured provider
 * 3. Cloud: OpenAI GPT-4.1-mini (best at structured output) → Gemini 2.5 Flash (fallback)
 */
export function getInternalModel(
    byokConfig?: BYOKConfig,
): LanguageModel | null {
    const envMode = process.env.API_LLM_PROVIDER_MODEL ?? 'auto';

    // If BYOK is configured, use the client's fallback or main model
    if (byokConfig?.fallback) {
        return byokToVercelModel(byokConfig, 'fallback');
    }
    if (byokConfig?.main) {
        return byokToVercelModel(byokConfig, 'main');
    }

    // Self-hosted mode: use the configured provider
    if (envMode !== 'auto') {
        const vertexKey = process.env.API_VERTEX_AI_API_KEY;
        if (vertexKey) {
            try {
                return createGoogleGenerativeAI({ apiKey: vertexKey })(envMode);
            } catch {
                // Fall through
            }
        }

        const openaiKey = process.env.API_OPEN_AI_API_KEY;
        const openaiBaseURL = process.env.API_OPENAI_FORCE_BASE_URL;
        if (openaiKey) {
            return createOpenAICompatible({
                name: 'self-hosted',
                apiKey: openaiKey,
                baseURL: openaiBaseURL || '',
            })(envMode);
        }

        return null;
    }

    // Cloud mode: prefer OpenAI GPT-5-mini (excellent structured output), fall back to Gemini
    const openaiKey = process.env.API_OPEN_AI_API_KEY;
    if (openaiKey) {
        return createOpenAI({ apiKey: openaiKey })('gpt-5.4-mini');
    }

    const googleKey =
        process.env.API_GOOGLE_AI_API_KEY ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    if (!googleKey) return null;

    return createGoogleGenerativeAI({ apiKey: googleKey })('gemini-2.5-flash');
}

export type BYOKLimiterRole = 'main' | 'fallback' | 'internal';

type BYOKProviderSlotConfig = NonNullable<BYOKConfig['main']>;

type QueuedTask<T> = {
    id: number;
    label: string;
    run: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
    started: boolean;
    cancelled: boolean;
    timer?: ReturnType<typeof setTimeout>;
    cleanup?: () => void;
};

const DEFAULT_LIMITER_QUEUE_TIMEOUT_MS = 0;

class BYOKConcurrencyLimiter {
    private readonly queue: Array<QueuedTask<unknown>> = [];
    private activeCount = 0;
    private nextTaskId = 1;

    constructor(
        readonly concurrency: number,
        readonly queueTimeoutMs: number,
    ) {}

    run<T>(
        label: string,
        fn: () => Promise<T>,
        abortSignal?: AbortSignal,
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const task: QueuedTask<T> = {
                id: this.nextTaskId++,
                label,
                run: fn,
                resolve,
                reject,
                started: false,
                cancelled: false,
            };

            const abortQueuedTask = () => {
                if (task.started || task.cancelled) return;
                task.cancelled = true;
                if (task.timer) clearTimeout(task.timer);
                const index = this.queue.findIndex(
                    (item) => item.id === task.id,
                );
                if (index >= 0) {
                    this.queue.splice(index, 1);
                }
                reject(
                    abortSignal?.reason instanceof Error
                        ? abortSignal.reason
                        : new Error(
                              `[BYOK-QUEUE-ABORTED] ${label} was cancelled before acquiring an LLM concurrency slot`,
                          ),
                );
            };

            if (abortSignal) {
                if (abortSignal.aborted) {
                    abortQueuedTask();
                    return;
                }
                abortSignal.addEventListener('abort', abortQueuedTask, {
                    once: true,
                });
                task.cleanup = () =>
                    abortSignal.removeEventListener('abort', abortQueuedTask);
            }

            if (this.queueTimeoutMs > 0) {
                task.timer = setTimeout(() => {
                    if (task.started || task.cancelled) return;
                    task.cancelled = true;
                    task.cleanup?.();
                    const index = this.queue.findIndex(
                        (item) => item.id === task.id,
                    );
                    if (index >= 0) {
                        this.queue.splice(index, 1);
                    }
                    reject(
                        new Error(
                            `[BYOK-QUEUE-TIMEOUT] ${label} waited more than ${Math.round(
                                this.queueTimeoutMs / 1000,
                            )}s for an LLM concurrency slot`,
                        ),
                    );
                }, this.queueTimeoutMs);
            }

            this.queue.push(task as QueuedTask<unknown>);
            this.drain();
        });
    }

    private drain() {
        while (this.activeCount < this.concurrency && this.queue.length > 0) {
            const task = this.queue.shift();
            if (!task || task.cancelled) continue;

            task.started = true;
            if (task.timer) clearTimeout(task.timer);
            task.cleanup?.();
            this.activeCount++;

            Promise.resolve()
                .then(() => task.run())
                .then(
                    (value) => task.resolve(value),
                    (error) => task.reject(error),
                )
                .finally(() => {
                    this.activeCount = Math.max(0, this.activeCount - 1);
                    this.drain();
                });
        }
    }
}

const limiterCache = new Map<string, BYOKConcurrencyLimiter>();

function getLimiterConfig(
    byokConfig?: BYOKConfig,
    role: BYOKLimiterRole = 'main',
): BYOKProviderSlotConfig | undefined {
    if (!byokConfig) return undefined;

    switch (role) {
        case 'fallback':
            return byokConfig.fallback;
        case 'internal':
            return byokConfig.fallback ?? byokConfig.main;
        case 'main':
        default:
            return byokConfig.main;
    }
}

function buildLimiterCacheKey(params: {
    byokConfig?: BYOKConfig;
    organizationId?: string;
    role?: BYOKLimiterRole;
}): string | null {
    const role = params.role ?? 'main';
    const config = getLimiterConfig(params.byokConfig, role);
    if (!config) return null;

    const organizationScope = params.organizationId || 'global';
    return [
        organizationScope,
        config.provider,
        config.apiKey,
        config.baseURL || '',
        config.model,
    ].join('::');
}

/**
 * Runs a task through a BYOK concurrency limiter scoped by organization + provider account.
 *
 * The limiter is shared across main/internal/fallback calls when they hit the same
 * provider account, because upstream concurrency limits are account-wide rather than
 * call-type-specific.
 */
export function runWithBYOKLimiter<T>(
    params: {
        byokConfig?: BYOKConfig;
        organizationId?: string;
        role?: BYOKLimiterRole;
        queueTimeoutMs?: number;
        abortSignal?: AbortSignal;
    },
    fn: () => Promise<T>,
    label = 'llm-call',
): Promise<T> {
    const role = params.role ?? 'main';
    const config = getLimiterConfig(params.byokConfig, role);
    const maxConcurrent = config?.maxConcurrentRequests;

    if (!maxConcurrent || maxConcurrent <= 0) {
        return fn();
    }

    const cacheKey = buildLimiterCacheKey(params);
    if (!cacheKey) {
        return fn();
    }

    const queueTimeoutMs =
        params.queueTimeoutMs ?? DEFAULT_LIMITER_QUEUE_TIMEOUT_MS;
    let limiter = limiterCache.get(cacheKey);
    if (
        !limiter ||
        limiter.concurrency !== maxConcurrent ||
        limiter.queueTimeoutMs !== queueTimeoutMs
    ) {
        limiter = new BYOKConcurrencyLimiter(maxConcurrent, queueTimeoutMs);
        limiterCache.set(cacheKey, limiter);
    }

    return limiter.run(label, fn, params.abortSignal);
}
