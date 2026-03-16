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
    const config = role === 'fallback' ? byokConfig?.fallback : byokConfig?.main;

    if (!config) {
        // No BYOK — use default
        return createGoogleGenerativeAI()('gemini-2.5-pro');
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
export function getInternalModel(byokConfig?: BYOKConfig): LanguageModel | null {
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
        return createOpenAI({ apiKey: openaiKey })('gpt-5-mini');
    }

    const googleKey =
        process.env.API_GOOGLE_AI_API_KEY ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    if (!googleKey) return null;

    return createGoogleGenerativeAI({ apiKey: googleKey })(
        'gemini-2.5-flash',
    );
}
