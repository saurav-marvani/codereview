/**
 * Classifies severity of code review suggestions using a fixed cheap model.
 *
 * Separated from the agent loop so that:
 * - The agent focuses on finding bugs (doesn't worry about severity)
 * - Severity is always classified using the CLIENT's criteria (v2PromptOverrides)
 * - Classification is consistent regardless of which BYOK model the client uses
 */
import { generateText, Output } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { createLogger } from '@kodus/flow';
import type { CodeReviewConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';

const logger = createLogger('SeverityClassifier');

const DEFAULT_SEVERITY_FLAGS = {
    critical:
        'Application crash/downtime. Data loss/corruption. Security breach. Critical operation failure.',
    high: 'Important functionality broken. Memory leaks causing eventual crash. Performance degradation affecting UX.',
    medium: 'Partially broken functionality. Performance issues in specific scenarios. Incorrect but recoverable data.',
    low: 'Minor performance overhead. Incorrect metrics/logs. Rarely affecting few users. Edge-case issues.',
};

const severityResultSchema = z.object({
    classifications: z.array(
        z.object({
            index: z.number(),
            severity: z.enum(['critical', 'high', 'medium', 'low']),
            reason: z.string(),
        }),
    ),
});

export interface SuggestionForClassification {
    relevantFile: string;
    suggestionContent: string;
    oneSentenceSummary?: string;
    existingCode?: string;
    improvedCode?: string;
}

/**
 * Classify severity for a batch of suggestions using Gemini Flash.
 * Returns a map of index → severity.
 */
export async function classifySeverity(
    suggestions: SuggestionForClassification[],
    severityFlags?: CodeReviewConfig['v2PromptOverrides'],
): Promise<Map<number, string>> {
    if (suggestions.length === 0) return new Map();

    const apiKey =
        process.env.API_GOOGLE_AI_API_KEY ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY;

    if (!apiKey) {
        logger.warn({
            message: 'No Google AI API key for severity classification, defaulting to medium',
            context: 'SeverityClassifier',
        });
        return new Map(suggestions.map((_, i) => [i, 'medium']));
    }

    const flags = severityFlags?.severity?.flags || DEFAULT_SEVERITY_FLAGS;

    const suggestionsText = suggestions
        .map(
            (s, i) =>
                `[${i}] File: ${s.relevantFile}\nIssue: ${s.suggestionContent}\nSummary: ${s.oneSentenceSummary || 'N/A'}`,
        )
        .join('\n\n');

    try {
        const model = createGoogleGenerativeAI({ apiKey })(
            'gemini-3-flash-preview',
        );

        const result: any = await generateText({
            model: model as any,
            output: Output.object({ schema: severityResultSchema }) as any,
            prompt: `Classify the severity of each code review suggestion based on these criteria:

**CRITICAL**: ${flags.critical || DEFAULT_SEVERITY_FLAGS.critical}

**HIGH**: ${flags.high || DEFAULT_SEVERITY_FLAGS.high}

**MEDIUM**: ${flags.medium || DEFAULT_SEVERITY_FLAGS.medium}

**LOW**: ${flags.low || DEFAULT_SEVERITY_FLAGS.low}

Suggestions to classify:

${suggestionsText}

For each suggestion, determine its severity based on the IMPACT described. Consider:
- Race conditions, data corruption, state inconsistency → typically HIGH or CRITICAL
- Security vulnerabilities with real attack vectors → HIGH or CRITICAL
- Missing error handling that causes crashes → HIGH
- Performance issues in hot paths → HIGH
- Edge cases that rarely occur → LOW or MEDIUM`,
        });

        const classifications = new Map<number, string>();
        for (const c of (result.object as any).classifications || []) {
            classifications.set(c.index, c.severity);
        }

        logger.log({
            message: `[SEVERITY] Classified ${classifications.size} suggestions: ${[...classifications.values()].join(', ')}`,
            context: 'SeverityClassifier',
        });

        return classifications;
    } catch (error) {
        logger.error({
            message: '[SEVERITY] Classification failed, defaulting to medium',
            context: 'SeverityClassifier',
            error,
        });
        return new Map(suggestions.map((_, i) => [i, 'medium']));
    }
}
