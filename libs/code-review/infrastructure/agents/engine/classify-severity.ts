/**
 * Classifies severity of code review suggestions using a fixed cheap model.
 *
 * Separated from the agent loop so that:
 * - The agent focuses on finding bugs (doesn't worry about severity)
 * - Severity is always classified using the CLIENT's criteria (v2PromptOverrides)
 * - Classification is consistent regardless of which BYOK model the client uses
 */
import { createLogger } from '@libs/core/log/logger';
import type { BYOKConfig } from '@kodus/kodus-common/llm';
import type { CodeReviewConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { resolveSecondaryPassModel } from './secondary-pass-model';
import { tracedGenerateText as generateText } from '@libs/llm/llm-call';
import { buildLangfuseTelemetry } from '@libs/core/log/langfuse';

const logger = createLogger('SeverityClassifier');

const DEFAULT_SEVERITY_FLAGS = {
    critical:
        'Application crash/downtime. Data loss/corruption. Security breach. Critical operation failure.',
    high: 'Important functionality broken. Memory leaks causing eventual crash. Performance degradation affecting UX.',
    medium: 'Partially broken functionality. Performance issues in specific scenarios. Incorrect but recoverable data.',
    low: 'Minor performance overhead. Incorrect metrics/logs. Rarely affecting few users. Edge-case issues.',
};

export interface SuggestionForClassification {
    relevantFile: string;
    suggestionContent: string;
    oneSentenceSummary?: string;
    existingCode?: string;
    improvedCode?: string;
}

/**
 * Classify severity for a batch of suggestions.
 *
 * Model resolution (via resolveSecondaryPassModel, same as dedup):
 * 1. Platform OpenAI key → gpt-5.4-mini (consistent, cheap — severity must not
 *    vary by the client's BYOK model)
 * 2. else → getInternalModel(byokConfig) (self-hosted / BYOK fallback)
 * 3. No model available → default everything to 'medium'
 */
export async function classifySeverity(
    suggestions: SuggestionForClassification[],
    severityFlags?: CodeReviewConfig['v2PromptOverrides'],
    byokConfig?: BYOKConfig,
): Promise<Map<number, string>> {
    if (suggestions.length === 0) return new Map();

    const model = resolveSecondaryPassModel(byokConfig);

    if (!model) {
        logger.warn({
            message:
                'No model available for severity classification, defaulting to medium',
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
        const result: any = await generateText({
            model: model as any,
            experimental_telemetry: buildLangfuseTelemetry(
                'severity-classifier',
            ),
            prompt: `Classify the severity of each code review suggestion based on these criteria:

**CRITICAL**: ${flags.critical || DEFAULT_SEVERITY_FLAGS.critical}

**HIGH**: ${flags.high || DEFAULT_SEVERITY_FLAGS.high}

**MEDIUM**: ${flags.medium || DEFAULT_SEVERITY_FLAGS.medium}

**LOW**: ${flags.low || DEFAULT_SEVERITY_FLAGS.low}

Suggestions to classify:

${suggestionsText}

Respond with ONLY a JSON object:
\`\`\`json
{"classifications": [{"index": 0, "severity": "high", "reason": "brief reason"}]}
\`\`\``,
        });

        const text = result.text || '';
        const jsonMatch = text.match(/\{[\s\S]*"classifications"[\s\S]*\}/);
        if (!jsonMatch) {
            logger.warn({
                message: `[SEVERITY] No JSON in response (${text.length} chars)`,
                context: 'SeverityClassifier',
            });
            return new Map(suggestions.map((_, i) => [i, 'medium']));
        }

        const parsed = JSON.parse(jsonMatch[0]);
        const classifications = new Map<number, string>();
        for (const c of parsed.classifications || []) {
            if (typeof c.index === 'number' && typeof c.severity === 'string') {
                classifications.set(c.index, c.severity.toLowerCase());
            }
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
