import { describe, expect, it } from 'vitest';
import {
    formatFailOnExitMessage,
    formatTrialCompletionMessage,
    shouldFailReview,
    shouldUseInteractiveReview,
} from '../result.js';
import type { ReviewResult, TrialReviewResult } from '../../../types/review.js';

describe('review result helpers', () => {
    it('uses interactive mode only for terminal human flows', () => {
        expect(
            shouldUseInteractiveReview({
                isAgent: false,
                interactive: true,
                output: undefined,
                format: 'terminal',
            }),
        ).toBe(true);
        expect(
            shouldUseInteractiveReview({
                isAgent: false,
                interactive: false,
                output: undefined,
                format: 'terminal',
            }),
        ).toBe(true);
        expect(
            shouldUseInteractiveReview({
                isAgent: true,
                interactive: true,
                output: undefined,
                format: 'terminal',
            }),
        ).toBe(false);
        expect(
            shouldUseInteractiveReview({
                isAgent: false,
                interactive: false,
                output: '/tmp/out.txt',
                format: 'terminal',
            }),
        ).toBe(false);
    });

    it('detects blocking issues based on fail-on severity', () => {
        const result: ReviewResult = {
            summary: 'Issues',
            issues: [
                {
                    file: 'src/a.ts',
                    line: 1,
                    severity: 'warning',
                    message: 'warn',
                },
                {
                    file: 'src/b.ts',
                    line: 2,
                    severity: 'error',
                    message: 'error',
                },
            ],
            filesAnalyzed: 2,
            duration: 1,
        };

        expect(shouldFailReview(result, 'warning')).toBe(true);
        expect(shouldFailReview(result, 'error')).toBe(true);
        expect(shouldFailReview(result, 'critical')).toBe(false);
        expect(shouldFailReview(result, undefined)).toBe(false);
        expect(formatFailOnExitMessage(result, 'error')).toBe(
            'Exiting with code 1 because 1 issue meets or exceeds `--fail-on error`.',
        );
        expect(formatFailOnExitMessage(result, 'warning')).toBe(
            'Exiting with code 1 because 2 issues meet or exceed `--fail-on warning`.',
        );
        expect(formatFailOnExitMessage(result, 'critical')).toBeNull();
    });

    it('formats trial completion message from trial info or rate limit', () => {
        const trialInfoResult: TrialReviewResult = {
            summary: 'ok',
            issues: [],
            filesAnalyzed: 1,
            duration: 1,
            trialInfo: {
                reviewsUsed: 1,
                reviewsLimit: 5,
                resetsAt: 'tomorrow',
            },
        };
        const rateLimitResult: TrialReviewResult = {
            summary: 'ok',
            issues: [],
            filesAnalyzed: 1,
            duration: 1,
            rateLimit: {
                remaining: 3,
                limit: 5,
            },
        };

        expect(formatTrialCompletionMessage(trialInfoResult)).toBe(
            'Review complete! (Trial: 1/5 reviews today)',
        );
        expect(formatTrialCompletionMessage(rateLimitResult)).toBe(
            'Review complete! (Trial: 2/5 reviews today)',
        );
    });
});
