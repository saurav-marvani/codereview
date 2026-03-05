import { Injectable } from '@nestjs/common';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Callbacks } from '@langchain/core/callbacks/manager';
import { getAdapter } from './providerAdapters/index';

export enum BYOKProvider {
    OPENAI = 'openai',
    ANTHROPIC = 'anthropic',
    GOOGLE_GEMINI = 'google_gemini',
    GOOGLE_VERTEX = 'google_vertex',
    OPENAI_COMPATIBLE = 'openai_compatible',
    OPEN_ROUTER = 'open_router',
    NOVITA = 'novita',
}

export interface BYOKConfig {
    main: {
        provider: BYOKProvider;
        apiKey: string;
        model: string;
        baseURL?: string;
        disableReasoning?: boolean;
        temperature?: number;
        maxInputTokens?: number;
        maxConcurrentRequests?: number;
        maxOutputTokens?: number;
    };
    fallback?: {
        provider: BYOKProvider;
        apiKey: string;
        model: string;
        baseURL?: string;
        temperature?: number;
        maxInputTokens?: number;
        maxConcurrentRequests?: number;
        maxOutputTokens?: number;
    };
}

@Injectable()
export class BYOKProviderService {
    /**
     * Creates a BYOK provider instance based on configuration
     */
    createBYOKProvider(
        config: BYOKConfig,
        options?: {
            temperature?: number;
            maxTokens?: number;
            callbacks?: Callbacks;
            jsonMode?: boolean;
            maxReasoningTokens?: number;
            reasoningLevel?: 'low' | 'medium' | 'high';
            disableReasoning?: boolean;
        },
    ): BaseChatModel {
        const { provider, apiKey, model, baseURL, disableReasoning } =
            config.main;
        const adapter = getAdapter(provider);

        if (provider === BYOKProvider.OPENAI_COMPATIBLE && !baseURL) {
            throw new Error(
                'baseURL is required for OpenAI Compatible provider',
            );
        }

        const modelInstance = adapter.build({
            model,
            apiKey,
            baseURL:
                provider === BYOKProvider.OPENAI_COMPATIBLE
                    ? baseURL
                    : provider === BYOKProvider.OPEN_ROUTER
                      ? 'https://openrouter.ai/api/v1'
                      : undefined,
            options: {
                temperature: options?.temperature,
                maxTokens: options?.maxTokens,
                jsonMode: options?.jsonMode,
                maxReasoningTokens: options?.maxReasoningTokens,
                reasoningLevel: options?.reasoningLevel,
                // Use config.main.disableReasoning or options.disableReasoning
                disableReasoning: disableReasoning ?? options?.disableReasoning,
                callbacks: options?.callbacks as Callbacks,
            },
        });

        return modelInstance;
    }

    /**
     * Creates a fallback provider if available
     */
    createFallbackProvider(
        config: BYOKConfig,
        options?: {
            temperature?: number;
            maxTokens?: number;
            callbacks?: Callbacks;
            jsonMode?: boolean;
            maxReasoningTokens?: number;
        },
    ): BaseChatModel | null {
        if (!config.fallback) {
            return null;
        }

        // Temporarily replace main config with fallback for creation
        const fallbackConfig: BYOKConfig = {
            main: config.fallback,
        };

        return this.createBYOKProvider(fallbackConfig, options);
    }

    /**
     * Validates if the provider configuration is complete
     */
    validateProviderConfig(providerConfig: {
        region: any;
        projectId: any;
        provider: BYOKProvider;
        apiKey: string;
        model: string;
        baseURL?: string;
    }): { isValid: boolean; errors: string[] } {
        const errors: string[] = [];

        if (!providerConfig.provider) {
            errors.push('Provider is required');
        }

        if (!providerConfig.apiKey) {
            errors.push('API key is required');
        }

        if (!providerConfig.model) {
            errors.push('Model is required');
        }

        // Check provider-specific requirements
        if (
            providerConfig.provider === BYOKProvider.OPENAI_COMPATIBLE &&
            !providerConfig.baseURL
        ) {
            errors.push('baseURL is required for OpenAI Compatible provider');
        }

        if (providerConfig.provider === BYOKProvider.GOOGLE_VERTEX) {
            if (!providerConfig.projectId) {
                errors.push('projectId is required for Google Vertex AI');
            }
            if (!providerConfig.region) {
                errors.push('region is required for Google Vertex AI');
            }
            // Validate if apiKey is valid JSON
            try {
                JSON.parse(providerConfig.apiKey);
            } catch {
                errors.push(
                    'apiKey must be a valid JSON service account key for Google Vertex AI',
                );
            }
        }

        return {
            isValid: errors.length === 0,
            errors,
        };
    }

    /**
     * Gets the display name for a provider
     */
    getProviderDisplayName(provider: BYOKProvider): string {
        const displayNames = {
            [BYOKProvider.OPENAI]: 'OpenAI',
            [BYOKProvider.ANTHROPIC]: 'Anthropic',
            [BYOKProvider.GOOGLE_GEMINI]: 'Google Gemini',
            [BYOKProvider.GOOGLE_VERTEX]: 'Google Vertex',
            [BYOKProvider.OPENAI_COMPATIBLE]: 'OpenAI Compatible',
            [BYOKProvider.OPEN_ROUTER]: 'OpenRouter',
            [BYOKProvider.NOVITA]: 'Novita',
        };

        return displayNames[provider] || provider;
    }
}
