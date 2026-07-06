import { PreviewFinding } from '@libs/sandbox/infrastructure/services/preview-env-agent.service';
import {
    PREVIEW_ENV_LABEL,
    applyFocus,
    buildDiffFromChangedFiles,
    findingToSuggestion,
    findingsToSuggestions,
    firstChangedLineForFile,
    proofBlock,
} from './preview-env-findings';

const f = (over: Partial<PreviewFinding> = {}): PreviewFinding => ({
    description: 'Price tampering: server trusts client-sent price',
    evidence: '$ curl ... price=0.01 -> accepted',
    file: 'src/Web/Pages/Basket/Index.cshtml.cs',
    severity: 'critical',
    ...over,
});

describe('preview-env findings mapping', () => {
    it('buildDiffFromChangedFiles emits a unified diff, skipping files with no patch', () => {
        const diff = buildDiffFromChangedFiles([
            { filename: 'a.ts', patch: '@@ -1 +1 @@\n-x\n+y' } as any,
            { filename: 'no-patch.ts' } as any,
        ]);
        expect(diff).toContain('diff --git a/a.ts b/a.ts');
        expect(diff).toContain('+y');
        expect(diff).not.toContain('no-patch.ts');
    });

    it('proofBlock wraps evidence in a collapsed details block', () => {
        const b = proofBlock('$ ran\noutput');
        expect(b).toContain('<details>');
        expect(b).toContain('Reproduced by running');
        expect(b).toContain('$ ran');
    });

    it('findingToSuggestion maps fields + label + embeds proof', () => {
        const s = findingToSuggestion(f());
        expect(s.relevantFile).toBe('src/Web/Pages/Basket/Index.cshtml.cs');
        expect(s.severity).toBe('critical');
        expect(s.label).toBe(PREVIEW_ENV_LABEL);
        expect(s.suggestionContent).toContain('Price tampering');
        expect(s.suggestionContent).toContain('<details>');
        expect(s.improvedCode).toBe(''); // not auto-fixable → no Apply button
    });

    describe('anchor / 422 fix', () => {
        it('firstChangedLineForFile returns the first ADDED line (RIGHT side) of the file', () => {
            // hunk starts at new-line 78; two context lines (78,79) then the add at 80
            const changed = [
                {
                    filename: 'server/queries/link.queries.js',
                    patch: '@@ -76,4 +78,4 @@\n ctx1\n ctx2\n-  query.count("* as count");\n+  query.count("*");',
                } as any,
            ];
            expect(
                firstChangedLineForFile(changed, 'server/queries/link.queries.js'),
            ).toBe(80);
        });

        it('returns null when the file is not in the diff (or has no add)', () => {
            expect(firstChangedLineForFile([], 'x.js')).toBeNull();
            expect(
                firstChangedLineForFile(
                    [{ filename: 'x.js', patch: '@@ -1 +0,0 @@\n-gone' } as any],
                    'x.js',
                ),
            ).toBeNull();
        });

        it('on-diff finding anchors to the changed line (no more line-1 → no 422)', () => {
            const changed = [
                {
                    filename: 'db.js',
                    patch: '@@ -10,2 +10,2 @@\n ctx\n+  changed();',
                } as any,
            ];
            const s = findingToSuggestion(f({ file: 'db.js' }), changed);
            expect(s.relevantLinesStart).toBe(11);
            expect(s.relevantLinesEnd).toBe(11);
            expect(s.postPrLevel).toBe(false);
        });

        it('off-diff finding falls back to PR-level (postPrLevel) instead of line 1', () => {
            const s = findingToSuggestion(f({ file: 'not-in-diff.js' }), [
                { filename: 'other.js', patch: '@@ -1 +1 @@\n-a\n+b' } as any,
            ]);
            expect(s.postPrLevel).toBe(true);
            expect(s.relevantLinesStart).toBe(1); // marker for the PR-level path
        });
    });

    describe('applyFocus steers, never suppresses', () => {
        const findings = [
            f({ severity: 'medium', description: 'database count is wrong', file: 'db.js' }),
            f({ severity: 'low', description: 'styling spacing off', file: 'style.css' }),
            f({ severity: 'critical', description: 'SSRF reachable', file: 'net.js' }),
        ];
        it('returns EVERY finding even when a directive is set (no output filtering)', () => {
            // regression: a prose directive whose terms don't echo a finding's
            // wording must NOT drop that finding (fired live on a real PR).
            const kept = applyFocus(findings, 'the token cost pricing math').map((x) => x.file);
            expect(kept).toEqual(['db.js', 'style.css', 'net.js']);
        });
        it('no focus → all findings pass', () => {
            expect(applyFocus(findings, undefined)).toHaveLength(3);
            expect(applyFocus(findings, '   ')).toHaveLength(3);
        });
    });

    it('findingsToSuggestions maps ALL findings regardless of directive', () => {
        const out = findingsToSuggestions(
            [f({ severity: 'low', description: 'perf', file: 'p.js' }), f()],
            'security', // directive present, but nothing is suppressed
        );
        expect(out).toHaveLength(2);
        expect(out.every((s) => s.label === PREVIEW_ENV_LABEL)).toBe(true);
    });
});
