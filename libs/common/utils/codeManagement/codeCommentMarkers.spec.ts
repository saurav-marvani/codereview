/**
 * Unit tests for parseReviewDirective — the free-text steering directive a user
 * appends to a review command (`@kody review focus on the auth logic`). The
 * directive must be captured for real commands, ignored for plain commands and
 * non-commands, and have the `--force` flag and quotes stripped.
 */
import {
    parseReviewDirective,
    isReviewCommand,
} from './codeCommentMarkers';

describe('parseReviewDirective', () => {
    it('captures the trailing directive on a review command', () => {
        expect(parseReviewDirective('@kody review focus on the auth logic')).toBe(
            'focus on the auth logic',
        );
    });

    it('supports the start-review alias', () => {
        expect(
            parseReviewDirective('@kody start-review focus on rate limiting'),
        ).toBe('focus on rate limiting');
    });

    it('returns undefined for a plain review command (no directive)', () => {
        expect(parseReviewDirective('@kody review')).toBeUndefined();
        expect(parseReviewDirective('@kody review   ')).toBeUndefined();
    });

    it('strips a leading --force / force flag before the directive', () => {
        expect(
            parseReviewDirective('@kody review --force focus on security'),
        ).toBe('focus on security');
        expect(parseReviewDirective('@kody review --force')).toBeUndefined();
    });

    it('strips surrounding quotes', () => {
        expect(parseReviewDirective('@kody review "the payment flow"')).toBe(
            'the payment flow',
        );
    });

    it('is case-insensitive on the command head', () => {
        expect(parseReviewDirective('  @kody REVIEW Focus On Caps ')).toBe(
            'Focus On Caps',
        );
    });

    it('uses only the first line of the comment', () => {
        expect(
            parseReviewDirective('@kody review focus on X\nignored second line'),
        ).toBe('focus on X');
    });

    it('returns undefined for non-commands and empty input', () => {
        expect(parseReviewDirective('just a normal comment')).toBeUndefined();
        expect(parseReviewDirective('@kody what do you think?')).toBeUndefined();
        expect(parseReviewDirective('')).toBeUndefined();
        expect(parseReviewDirective(null)).toBeUndefined();
        expect(parseReviewDirective(undefined)).toBeUndefined();
    });

    it('caps the directive length at 500 chars', () => {
        const long = 'x'.repeat(900);
        const got = parseReviewDirective(`@kody review ${long}`);
        expect(got?.length).toBe(500);
    });

    it('never returns a directive when isReviewCommand is false', () => {
        const text = 'please review-code this';
        expect(isReviewCommand(text)).toBe(false);
        expect(parseReviewDirective(text)).toBeUndefined();
    });
});
