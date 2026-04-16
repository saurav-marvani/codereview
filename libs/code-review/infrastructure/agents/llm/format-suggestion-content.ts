import { createLogger } from '@kodus/flow';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { BYOKConfig } from '@kodus/kodus-common/llm';
import { getInternalModel } from './byok-to-vercel';
import { tracedGenerateText as generateText } from './agent-loop';

const logger = createLogger('SuggestionFormatter');

const FORMAT_TIMEOUT_MS = 90_000; // 90s — Gemini Flash can take >30s under load

const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });

export interface SuggestionToFormat {
    suggestionContent: string;
    existingCode?: string;
    improvedCode?: string;
    relevantFile?: string;
    language?: string;
}

export interface FormattedSuggestion {
    suggestionContent: string;
    improvedCode: string;
}

/**
 * Reformat suggestion content from WHAT/WHY/HOW to natural prose,
 * and ensure improvedCode is populated.
 *
 * Uses Gemini Flash (Google API key) or BYOK fallback model.
 * Respects custom writing guidelines if provided.
 */
export async function formatSuggestionContent(
    suggestions: SuggestionToFormat[],
    options?: {
        customWritingGuidelines?: string;
        byokConfig?: BYOKConfig;
        languageResultPrompt?: string;
    },
): Promise<Map<number, FormattedSuggestion>> {
    if (suggestions.length === 0) return new Map();

    // Resolve model: Google API key → BYOK fallback
    const googleKey =
        process.env.API_GOOGLE_AI_API_KEY ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    let model: any;
    if (googleKey) {
        model = createGoogleGenerativeAI({ apiKey: googleKey })(
            'gemini-3-flash-preview',
        );
    } else if (options?.byokConfig) {
        model = getInternalModel(options.byokConfig);
    }

    if (!model) {
        logger.warn({
            message: 'No model available for suggestion formatting, skipping',
            context: 'SuggestionFormatter',
        });
        return new Map();
    }

    const customGuidelines = options?.customWritingGuidelines
        ? `\n\nAdditional writing guidelines from the team:\n${options.customWritingGuidelines}`
        : '';

    let langLabel: string | null = null;
    if (options?.languageResultPrompt) {
        try {
            langLabel = displayNames.of(options.languageResultPrompt) || options.languageResultPrompt;
        } catch {
            langLabel = options.languageResultPrompt;
        }
    }
    const langInstruction = langLabel
        ? `\nIMPORTANT: Write all output in ${langLabel}. Do not fall back to English.`
        : '';

    const suggestionsText = suggestions
        .map(
            (s, i) =>
                `[${i}]\nFile: ${s.relevantFile || 'unknown'}\nLanguage: ${s.language || 'unknown'}\nContent: ${s.suggestionContent}\nExisting code:\n\`\`\`\n${s.existingCode || '(none)'}\n\`\`\`\nImproved code:\n\`\`\`\n${s.improvedCode || '(none)'}\n\`\`\``,
        )
        .join('\n\n---\n\n');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FORMAT_TIMEOUT_MS);

    try {
        const result: any = await generateText({
            model: model as any,
            abortSignal: controller.signal,
            experimental_telemetry: {
                isEnabled: true,
                functionId: 'suggestion-formatter',
            },
            prompt: `You are a code review comment editor. Rewrite each suggestion into clean, natural prose.

Rules:
- Remove labels like "WHAT:", "WHY:", "HOW:", "1.", "2.", "3." from the beginning of sentences.
- Merge the labeled sentences into a single natural paragraph (1-3 sentences).
- Keep every technical detail: function names, file names, variable names, error types, line numbers.
- Do NOT touch existingCode or improvedCode — return them exactly as provided.
${customGuidelines ? `\nThe team has provided custom writing guidelines. Follow them — they take priority over the default rules above.\n${customGuidelines}` : ''}${langInstruction}

Example:
Input: "WHAT: The join method breaks out of the loop when the timeout expires. WHY: This leaves subsequent flusher processes running indefinitely as orphans. HOW: Remove the remaining_time check."
Output: "The join method breaks out of the loop when the timeout expires, leaving subsequent flusher processes running indefinitely as orphans. Remove the remaining_time check."

Respond with ONLY a JSON array:
\`\`\`json
[
  {"index": 0, "suggestionContent": "cleaned text"}
]
\`\`\`

Suggestions to clean:

${suggestionsText}`,
        });

        const text = result.text || '';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (!jsonMatch) {
            logger.warn({
                message: `[FORMATTER] No JSON array in response (${text.length} chars)`,
                context: 'SuggestionFormatter',
            });
            return new Map();
        }

        const parsed = JSON.parse(jsonMatch[0]);
        const formatted = new Map<number, FormattedSuggestion>();

        for (const item of parsed) {
            if (
                typeof item.index === 'number' &&
                typeof item.suggestionContent === 'string'
            ) {
                formatted.set(item.index, {
                    suggestionContent: item.suggestionContent,
                    improvedCode: item.improvedCode || '',
                });
            }
        }

        logger.log({
            message: `[FORMATTER] Formatted ${formatted.size}/${suggestions.length} suggestions`,
            context: 'SuggestionFormatter',
        });

        return formatted;
    } catch (err) {
        logger.warn({
            message: `[FORMATTER] Formatting failed: ${err instanceof Error ? err.message : String(err)}`,
            context: 'SuggestionFormatter',
        });
        return new Map();
    } finally {
        clearTimeout(timeout);
    }
}
