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
import { createVertex } from '@ai-sdk/google-vertex';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { BYOKConfig, BYOKProvider } from '@kodus/kodus-common/llm';
import { decrypt } from '@libs/common/utils/crypto';

/**
 * Build a Vercel AI SDK model from a base64-encoded Google Service Account
 * JSON. Mirrors `packages/kodus-common/src/llm/providerAdapters/vertexAdapter.ts`
 * so self-hosted deployments using the same `API_VERTEX_AI_API_KEY` env var
 * format (base64 SA JSON) work on both the v2 engine and the v5 agent.
 *
 * Returns null when the value is not a valid base64-encoded JSON with a
 * `project_id` — the caller should fall back to another provider path.
 */
function vertexModelFromSaJson(
    base64SaJson: string,
    modelId: string,
    locationOverride?: string,
): LanguageModel | null {
    try {
        const decoded = Buffer.from(base64SaJson, 'base64').toString('utf-8');
        const credentials = JSON.parse(decoded) as { project_id?: string };
        if (!credentials?.project_id) return null;
        // Keep this helper pure: the caller is responsible for resolving
        // the region (BYOK config or env var) and passing it as
        // locationOverride. Default to us-central1 when omitted.
        const location = locationOverride?.trim() || 'us-central1';
        return createVertex({
            project: credentials.project_id,
            location,
            googleAuthOptions: { credentials: credentials as any },
        })(modelId);
    } catch {
        return null;
    }
}

const CLAUDE_MODEL_PATTERN = /^claude[-_]/i;
const GEMINI_MODEL_PATTERN = /^gemini[-_]/i;

/**
 * Build a Vercel AI SDK model for Amazon Bedrock.
 *
 * Two auth paths, in priority order:
 *   1. Bearer API key (recommended) — single-token auth, released by AWS
 *      in 2025. `@ai-sdk/amazon-bedrock` accepts it via `apiKey` prop and
 *      takes precedence over any SigV4 config.
 *   2. Static IAM user credentials (SigV4) — legacy path, kept for teams
 *      that haven't migrated to API keys or that prefer IAM policies.
 *
 * Returns a LanguageModel that will emit a clear auth error at call time
 * when credentials are missing — we don't pre-validate here because the
 * test-byok endpoint already catches empty fields before save.
 */
function bedrockModelFromCredentials(
    config: BYOKConfig['main'] | BYOKConfig['fallback'],
    modelId: string,
): LanguageModel {
    const region = config?.awsRegion?.trim() || 'us-east-1';

    if (config?.awsBearerToken?.trim()) {
        return createAmazonBedrock({
            region,
            apiKey: decrypt(config.awsBearerToken),
        })(modelId);
    }

    const accessKeyId = config?.awsAccessKeyId
        ? decrypt(config.awsAccessKeyId)
        : '';
    const secretAccessKey = config?.awsSecretAccessKey
        ? decrypt(config.awsSecretAccessKey)
        : '';
    const sessionToken = config?.awsSessionToken
        ? decrypt(config.awsSessionToken)
        : undefined;

    return createAmazonBedrock({
        region,
        accessKeyId,
        secretAccessKey,
        sessionToken,
    })(modelId);
}

/**
 * When the user sets `API_OPENAI_FORCE_BASE_URL` to a non-native endpoint
 * (OpenRouter, LiteLLM, Azure, DashScope, etc.), the intent is to route
 * through an OpenAI-compatible proxy regardless of the model name prefix.
 * In that case the native SDK auto-detect by model prefix is wrong — the
 * proxy only speaks the OpenAI Chat Completions protocol and the key the
 * user supplied belongs to the proxy, not to Anthropic/Google.
 *
 * Rule:
 *   - empty baseURL                            → native auto-detect is safe
 *   - baseURL contains "api.anthropic.com"     → still Anthropic native (explicit but native)
 *   - any other non-empty baseURL              → force OpenAI-compatible
 *
 * Vertex uses SA JSON auth (no baseURL), so its auto-detect is also gated
 * here: if the user explicitly overrode the URL, they are not going via
 * Vertex even if they have a Vertex key configured.
 */
function isProxyBaseURL(baseURL: string | undefined): boolean {
    if (!baseURL) return false;
    return !/(^|\/\/)api\.anthropic\.com\b/i.test(baseURL);
}

/**
 * Default model config when no BYOK is configured.
 */
const DEFAULT_MODEL = {
    provider: BYOKProvider.GOOGLE_GEMINI,
    model: 'gemini-3.1-pro-preview-customtools',
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
        // No BYOK — pick the default based on deployment mode.
        // Self-hosted: honor `API_LLM_PROVIDER_MODEL` (+ `API_OPEN_AI_API_KEY` /
        //   `API_OPENAI_FORCE_BASE_URL` / `API_VERTEX_AI_API_KEY`) so the
        //   customer's own keys from .env drive the main model, the same way
        //   `getInternalModel` does for helper calls.
        // Cloud (managed/trial): fall back to Kodus's bundled Gemini default
        //   (`DEFAULT_MODEL.model` → v5 agent-first uses
        //   gemini-3.1-pro-preview-customtools; legacy v2 stays on
        //   gemini-2.5-pro via `LLMModelProvider` enum in llmAnalysis.service).
        const envMode = process.env.API_LLM_PROVIDER_MODEL ?? 'auto';
        if (envMode !== 'auto') {
            // Auto-detect the target provider from the configured model id.
            // Same envs (`API_LLM_PROVIDER_MODEL` + `API_OPEN_AI_API_KEY` +
            // `API_OPENAI_FORCE_BASE_URL` + `API_VERTEX_AI_API_KEY`) work for
            // every supported provider — the prefix of the model name picks
            // the right SDK so tools/auth/protocol match:
            //   gemini-*  → Vertex (SA JSON in API_VERTEX_AI_API_KEY)
            //   claude-*  → Anthropic native Messages API
            //   any other → OpenAI-compatible (OpenAI, Moonshot, z.AI, etc.)
            const isGemini = GEMINI_MODEL_PATTERN.test(envMode);
            const isClaude = CLAUDE_MODEL_PATTERN.test(envMode);
            const openaiKey = process.env.API_OPEN_AI_API_KEY;
            const openaiBaseURL = process.env.API_OPENAI_FORCE_BASE_URL;
            const vertexKey = process.env.API_VERTEX_AI_API_KEY;
            const googleAiStudioKey =
                process.env.API_GOOGLE_AI_API_KEY ||
                process.env.GOOGLE_GENERATIVE_AI_API_KEY;
            const viaProxy = isProxyBaseURL(openaiBaseURL);

            if (isGemini && !viaProxy) {
                // Order of preference:
                //   1. Explicit AI Studio key (API_GOOGLE_AI_API_KEY) — cheap,
                //      free-tier style key the user typed on purpose.
                //   2. Vertex SA JSON (API_VERTEX_AI_API_KEY, base64 encoded)
                //      — enterprise path, matches the v2 VertexAdapter.
                //   3. If API_VERTEX_AI_API_KEY is set but isn't a base64 SA
                //      JSON, treat it as a plain AI Studio key (users often
                //      paste an AIzaSy… key into the Vertex slot because of
                //      the historical env var name).
                if (googleAiStudioKey) {
                    return createGoogleGenerativeAI({
                        apiKey: googleAiStudioKey,
                    })(envMode);
                }
                if (vertexKey) {
                    const vertexModel = vertexModelFromSaJson(
                        vertexKey,
                        envMode,
                        process.env.API_VERTEX_AI_LOCATION,
                    );
                    if (vertexModel) return vertexModel;
                    return createGoogleGenerativeAI({ apiKey: vertexKey })(
                        envMode,
                    );
                }
                // No Google-side key at all — fall through to the cloud
                // Gemini default below.
            }
            if (isClaude && openaiKey && !viaProxy) {
                return createAnthropic({
                    apiKey: openaiKey,
                    // Anthropic SDK defaults to api.anthropic.com/v1 when
                    // baseURL is omitted; forward the env override only
                    // when the user explicitly points at Anthropic.
                    ...(openaiBaseURL ? { baseURL: openaiBaseURL } : {}),
                })(envMode);
            }
            if (openaiKey) {
                return createOpenAICompatible({
                    name: 'self-hosted',
                    apiKey: openaiKey,
                    // `@ai-sdk/openai-compatible` has no default baseURL
                    // (unlike `@ai-sdk/openai`), so an empty value throws
                    // "Invalid URL" on the first request. Default to
                    // api.openai.com to match the legacy v2 getChatGPT
                    // behavior when no custom endpoint is configured.
                    baseURL: openaiBaseURL || 'https://api.openai.com/v1',
                })(envMode);
            }
            // self-hosted mode declared but no usable env key — fall through
            // to the Gemini default so the call still has a model to attach
            // (it'll fail fast on the API call instead of here).
        }

        const googleKey =
            process.env.API_GOOGLE_AI_API_KEY ||
            process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
            '';
        return createGoogleGenerativeAI({ apiKey: googleKey })(
            DEFAULT_MODEL.model,
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

        case BYOKProvider.GOOGLE_VERTEX: {
            // BYOK Vertex keys are stored as base64-encoded Service Account
            // JSON (matching the format used by the v2 VertexAdapter).
            // Use `@ai-sdk/google-vertex` with the SA credentials; only fall
            // back to AI Studio if the value isn't a valid SA JSON (e.g. the
            // user typed a plain AIzaSy... key into the Vertex provider
            // slot — degraded but still usable).
            const vertexModel = vertexModelFromSaJson(
                apiKey,
                model,
                config.vertexLocation,
            );
            if (vertexModel) return vertexModel;
            return createGoogleGenerativeAI({ apiKey })(model);
        }

        case BYOKProvider.AMAZON_BEDROCK: {
            return bedrockModelFromCredentials(config, model);
        }

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
 * Mirrors the fallback logic in `byokToVercelModel` so telemetry/logs
 * reflect the model that will actually be used.
 */
export function getModelName(byokConfig?: BYOKConfig): string {
    if (byokConfig?.main) {
        return `${byokConfig.main.provider}:${byokConfig.main.model}`;
    }

    const envMode = process.env.API_LLM_PROVIDER_MODEL ?? 'auto';
    if (envMode !== 'auto') {
        const isGemini = GEMINI_MODEL_PATTERN.test(envMode);
        const isClaude = CLAUDE_MODEL_PATTERN.test(envMode);
        const openaiBaseURL = process.env.API_OPENAI_FORCE_BASE_URL;
        const viaProxy = isProxyBaseURL(openaiBaseURL);
        const googleAiStudioKey =
            process.env.API_GOOGLE_AI_API_KEY ||
            process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        if (isGemini && !viaProxy) {
            if (googleAiStudioKey) {
                return `google_ai_studio:${envMode}`;
            }
            if (process.env.API_VERTEX_AI_API_KEY) {
                return `google_vertex:${envMode}`;
            }
        }
        if (isClaude && process.env.API_OPEN_AI_API_KEY && !viaProxy) {
            return `anthropic:${envMode}`;
        }
        if (process.env.API_OPEN_AI_API_KEY) {
            return `openai_compatible:${envMode}`;
        }
    }

    return DEFAULT_MODEL.model;
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

    // Self-hosted mode: match byokToVercelModel's provider selection so
    // main and internal calls route through the same SDK.
    if (envMode !== 'auto') {
        const isGemini = GEMINI_MODEL_PATTERN.test(envMode);
        const isClaude = CLAUDE_MODEL_PATTERN.test(envMode);
        const openaiKey = process.env.API_OPEN_AI_API_KEY;
        const openaiBaseURL = process.env.API_OPENAI_FORCE_BASE_URL;
        const vertexKey = process.env.API_VERTEX_AI_API_KEY;
        const googleAiStudioKey =
            process.env.API_GOOGLE_AI_API_KEY ||
            process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        const viaProxy = isProxyBaseURL(openaiBaseURL);

        if (isGemini && !viaProxy) {
            if (googleAiStudioKey) {
                return createGoogleGenerativeAI({ apiKey: googleAiStudioKey })(
                    envMode,
                );
            }
            if (vertexKey) {
                const vertexModel = vertexModelFromSaJson(
                    vertexKey,
                    envMode,
                    process.env.API_VERTEX_AI_LOCATION,
                );
                if (vertexModel) return vertexModel;
                return createGoogleGenerativeAI({ apiKey: vertexKey })(envMode);
            }
        }
        if (isClaude && openaiKey && !viaProxy) {
            return createAnthropic({
                apiKey: openaiKey,
                ...(openaiBaseURL ? { baseURL: openaiBaseURL } : {}),
            })(envMode);
        }
        if (openaiKey) {
            return createOpenAICompatible({
                name: 'self-hosted',
                apiKey: openaiKey,
                baseURL: openaiBaseURL || 'https://api.openai.com/v1',
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

    if (!googleKey) {
        return null;
    }

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

    constructor(readonly concurrency: number) {}

    /**
     * @param queueTimeoutMs Per-task queue wait timeout. When > 0, the task
     *   is rejected with [BYOK-QUEUE-TIMEOUT] if it cannot acquire a slot within
     *   this duration. Pass 0 (or omit) for infinite wait (review callers).
     *   Conversation callers pass 60_000 to fail fast when a review holds the slot.
     */
    run<T>(
        label: string,
        fn: () => Promise<T>,
        abortSignal?: AbortSignal,
        queueTimeoutMs = DEFAULT_LIMITER_QUEUE_TIMEOUT_MS,
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

            if (queueTimeoutMs > 0) {
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
                                queueTimeoutMs / 1000,
                            )}s for an LLM concurrency slot`,
                        ),
                    );
                }, queueTimeoutMs);
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
    if (!limiter || limiter.concurrency !== maxConcurrent) {
        limiter = new BYOKConcurrencyLimiter(maxConcurrent);
        limiterCache.set(cacheKey, limiter);
    }

    return limiter.run(label, fn, params.abortSignal, queueTimeoutMs);
}
