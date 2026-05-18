/**
 * Manual reproduction: @ai-sdk/openai-compatible does not set
 * `supportsStructuredOutputs: true`, so calls that use
 * `generateText({ output: Output.object(...) })` (and `generateObject`)
 * end up sending `response_format: { type: "json_object" }` to the LLM
 * — vLLM's xgrammar (and the equivalent strict json_schema mode on
 * Moonshot / OpenRouter / OpenAI) is bypassed, and the model falls
 * back to prompt-injected schema extraction.
 *
 * The relevant production call sites — `review-structure-fallback`
 * and `verify-structure-fallback` in
 * libs/code-review/infrastructure/agents/llm/agent-loop.ts, plus
 * `dedup-suggestions` in libs/code-review/pipeline/stages/agent-review.stage.ts
 * — all build their model via `getInternalModel(byokConfig)` or
 * `byokToVercelModel(byokConfig)`, so we exercise the same factory here.
 *
 * Run:
 *   yarn repro:structured-outputs                          # hermetic OpenRouter
 *   yarn repro:structured-outputs --live                   # real OpenRouter / Kimi
 *   yarn repro:structured-outputs --provider google        # hermetic Gemini
 *   yarn repro:structured-outputs --provider google --live # real Gemini
 *
 * Today this script EXITS 1 for `--provider openrouter`: captured body shows
 *   response_format = { type: "json_object" }
 * After the fix it should EXIT 0 with
 *   response_format = { type: "json_schema", json_schema: { name, schema, strict } }
 *
 * For `--provider google` it should EXIT 0 today AND after the fix —
 * `@ai-sdk/google` always emits `generationConfig.responseSchema`, so the
 * structured-output contract is honoured natively without any flag.
 *
 * This file is intentionally NOT named `*.spec.ts`, so Jest's
 * `testMatch` in jest.config.ts ignores it and `yarn test` does not
 * pick it up.
 */

import 'dotenv/config';

import {
    generateText,
    Output,
    jsonSchema,
    type LanguageModel,
} from 'ai';

import {
    byokToVercelModel,
    getInternalModel,
} from '@/code-review/infrastructure/agents/llm/byok-to-vercel';
import { encrypt } from '@/common/utils/crypto';
import { BYOKConfig, BYOKProvider } from '@kodus/kodus-common/llm';

type ProviderChoice = 'openrouter' | 'google';

function parseProvider(): ProviderChoice {
    const idx = process.argv.indexOf('--provider');
    if (idx === -1) return 'openrouter';
    const value = process.argv[idx + 1];
    if (value === 'openrouter' || value === 'google') return value;
    console.error(
        `[repro] Unknown --provider value: ${value}. Use openrouter|google.`,
    );
    process.exit(2);
}

const LIVE = process.argv.includes('--live');
const PROVIDER = parseProvider();

const DEFAULT_MODEL: Record<ProviderChoice, string> = {
    openrouter: 'moonshotai/kimi-k2-thinking',
    google: 'gemini-2.5-flash',
};
const MODEL_ID = process.env.REPRO_MODEL ?? DEFAULT_MODEL[PROVIDER];

function buildByokConfig(apiKey: string): BYOKConfig {
    if (PROVIDER === 'openrouter') {
        return {
            main: {
                provider: BYOKProvider.OPEN_ROUTER,
                apiKey: encrypt(apiKey),
                model: MODEL_ID,
            },
        };
    }
    return {
        main: {
            provider: BYOKProvider.GOOGLE_GEMINI,
            apiKey: encrypt(apiKey),
            model: MODEL_ID,
        },
    };
}

const minimalSchema = jsonSchema({
    type: 'object',
    additionalProperties: false,
    properties: { answer: { type: 'string' } },
    required: ['answer'],
} as any);

function fakeResponseFor(provider: ProviderChoice): {
    body: string;
    headers: Record<string, string>;
} {
    if (provider === 'openrouter') {
        return {
            body: JSON.stringify({
                id: 'chatcmpl-fake',
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: MODEL_ID,
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: '{"answer":"ok"}',
                        },
                        finish_reason: 'stop',
                    },
                ],
                usage: {
                    prompt_tokens: 8,
                    completion_tokens: 4,
                    total_tokens: 12,
                },
            }),
            headers: { 'content-type': 'application/json' },
        };
    }
    return {
        body: JSON.stringify({
            candidates: [
                {
                    content: {
                        role: 'model',
                        parts: [{ text: '{"answer":"ok"}' }],
                    },
                    finishReason: 'STOP',
                    index: 0,
                },
            ],
            usageMetadata: {
                promptTokenCount: 8,
                candidatesTokenCount: 4,
                totalTokenCount: 12,
            },
        }),
        headers: { 'content-type': 'application/json' },
    };
}

interface CapturedRequest {
    url: string;
    body: any;
}

function installInterceptingFetch(): {
    captured: CapturedRequest[];
    restore: () => void;
} {
    const original = globalThis.fetch;
    const captured: CapturedRequest[] = [];
    const fake = fakeResponseFor(PROVIDER);

    globalThis.fetch = (async (input: any, init?: any) => {
        const url =
            typeof input === 'string'
                ? input
                : input instanceof URL
                  ? input.toString()
                  : (input?.url ?? '');
        let body: any = null;
        try {
            body = init?.body ? JSON.parse(init.body as string) : null;
        } catch {
            body = init?.body ?? null;
        }
        captured.push({ url, body });

        if (LIVE) {
            return original(input as any, init);
        }
        return new Response(fake.body, {
            status: 200,
            headers: fake.headers,
        });
    }) as typeof fetch;

    return {
        captured,
        restore: () => {
            globalThis.fetch = original;
        },
    };
}

async function probeStructuredOutput(
    model: LanguageModel,
): Promise<CapturedRequest | null> {
    const { captured, restore } = installInterceptingFetch();
    try {
        await generateText({
            model: model as any,
            prompt: 'Return any JSON value matching the schema.',
            output: Output.object({ schema: minimalSchema }) as any,
        }).catch((err) => {
            console.warn(
                `[repro] generateText threw (continuing): ${String(
                    (err as any)?.message ?? err,
                )}`,
            );
        });
    } finally {
        restore();
    }
    return captured[0] ?? null;
}

function assert(name: string, cond: boolean, detail: string): boolean {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name} — ${detail}`);
    return cond;
}

function checkStructuredOutputBody(
    provider: ProviderChoice,
    body: any,
): { ok: boolean; summary: string } {
    if (provider === 'openrouter') {
        const rf = body?.response_format;
        const ok =
            rf?.type === 'json_schema' && rf?.json_schema?.schema != null;
        return {
            ok,
            summary: `response_format = ${JSON.stringify(rf ?? null)}`,
        };
    }
    const gc = body?.generationConfig;
    const ok =
        gc?.responseMimeType === 'application/json' &&
        gc?.responseSchema != null;
    return {
        ok,
        summary: `generationConfig.responseMimeType=${JSON.stringify(
            gc?.responseMimeType ?? null,
        )} generationConfig.responseSchema=${
            gc?.responseSchema ? '<set>' : 'null'
        }`,
    };
}

function apiKeyFromEnv(provider: ProviderChoice): string | undefined {
    return provider === 'openrouter'
        ? process.env.API_OPENROUTER_KEY
        : (process.env.API_GOOGLE_AI_API_KEY ??
              process.env.GOOGLE_GENERATIVE_AI_API_KEY);
}

async function main(): Promise<void> {
    if (!process.env.API_CRYPTO_KEY) {
        console.error(
            '[repro] API_CRYPTO_KEY is required (used to encrypt the BYOK apiKey).',
        );
        process.exit(2);
    }
    const apiKey = LIVE ? apiKeyFromEnv(PROVIDER) : 'sk-test-not-a-real-key';
    if (LIVE && !apiKey) {
        const envName =
            PROVIDER === 'openrouter'
                ? 'API_OPENROUTER_KEY'
                : 'API_GOOGLE_AI_API_KEY';
        console.error(`[repro] --live --provider ${PROVIDER} requires ${envName}.`);
        process.exit(2);
    }

    const byok = buildByokConfig(apiKey as string);

    console.log(
        `[repro] mode=${LIVE ? 'live' : 'hermetic'} provider=${PROVIDER} model=${MODEL_ID}`,
    );
    console.log(
        '[repro] Probing structured-output path (mirrors review-structure-fallback).',
    );

    // Mirror agent-loop.ts:4011 / 4288 and agent-review.stage.ts:1145
    // after the fix — those call sites pass { structuredOutputs: true }
    // so the cheap fallback model emits native json_schema.
    const internalModel = getInternalModel(byok, { structuredOutputs: true });
    if (!internalModel) {
        console.error('[repro] getInternalModel returned null.');
        process.exit(2);
    }

    const captured = await probeStructuredOutput(internalModel);
    if (!captured) {
        console.error('[repro] No outgoing request was captured.');
        process.exit(2);
    }

    console.log('[repro] Outgoing URL:', captured.url);
    const check = checkStructuredOutputBody(PROVIDER, captured.body);
    console.log('[repro]', check.summary);

    const expectation =
        PROVIDER === 'openrouter'
            ? 'expected response_format.type === "json_schema" with a populated json_schema.schema so vLLM xgrammar / OpenAI Structured Outputs constrains the response (the current SDK default emits "json_object" without a schema, which vLLM cannot constrain)'
            : 'expected generationConfig.responseMimeType === "application/json" and a populated responseSchema — @ai-sdk/google handles this natively without any flag';

    const passedPrimary = assert(
        `getInternalModel structured-output path (${PROVIDER}) emits native schema`,
        check.ok,
        expectation,
    );

    // Bonus: confirm the agentic tool-loop path is NOT emitting a
    // structured-output schema (today and after the fix). The proposed
    // fix is scoped per-call so the tool loop stays unchanged.
    console.log(
        '\n[repro] Probing agentic tool-loop path (no Output.object).',
    );
    const mainModel = byokToVercelModel(byok, 'main');
    const { captured: capturedTool, restore } = installInterceptingFetch();
    try {
        await generateText({
            model: mainModel as any,
            prompt: 'Say hi.',
        }).catch((err) =>
            console.warn(
                `[repro] tool-loop probe threw (continuing): ${String(
                    (err as any)?.message ?? err,
                )}`,
            ),
        );
    } finally {
        restore();
    }
    const toolBody = capturedTool[0]?.body;
    if (PROVIDER === 'openrouter') {
        console.log(
            '[repro] tool-loop response_format =',
            JSON.stringify(toolBody?.response_format ?? null),
        );
    } else {
        console.log(
            '[repro] tool-loop generationConfig.responseSchema =',
            toolBody?.generationConfig?.responseSchema ? '<set>' : 'null',
        );
    }
    const toolOk =
        PROVIDER === 'openrouter'
            ? toolBody?.response_format == null ||
              toolBody?.response_format?.type !== 'json_schema'
            : toolBody?.generationConfig?.responseSchema == null;
    const passedTool = assert(
        'agentic tool-loop path keeps structured-output schema unset',
        toolOk,
        'must stay unchanged so existing tool-call behaviour is not regressed by the structured-output fix',
    );

    process.exit(passedPrimary && passedTool ? 0 : 1);
}

main().catch((err) => {
    console.error('[repro] crashed:', err);
    process.exit(2);
});
