import { PreviewFinding } from '@libs/sandbox/infrastructure/services/preview-env-agent.service';
import {
    PREVIEW_ENV_LABEL,
    applyFocus,
    buildDiffFromChangedFiles,
    findingToSuggestion,
    findingsToSuggestions,
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

    describe('applyFocus', () => {
        const findings = [
            f({ severity: 'medium', description: 'database count is wrong', file: 'db.js' }),
            f({ severity: 'medium', description: 'styling spacing off', file: 'style.css' }),
            f({ severity: 'critical', description: 'SSRF reachable', file: 'net.js' }),
        ];
        it('keeps only findings matching the focus terms', () => {
            const kept = applyFocus(findings, 'database queries').map((x) => x.file);
            expect(kept).toContain('db.js'); // matches 'database'
            expect(kept).not.toContain('style.css'); // no focus term
        });
        it('always keeps reproduced critical defects regardless of focus', () => {
            const kept = applyFocus(findings, 'styling appearance').map((x) => x.file);
            expect(kept).toContain('net.js'); // critical SSRF survives a narrow focus
            expect(kept).toContain('style.css'); // matches 'styling'
        });
        it('no focus → all findings pass', () => {
            expect(applyFocus(findings, undefined)).toHaveLength(3);
            expect(applyFocus(findings, '   ')).toHaveLength(3);
        });
    });

    it('findingsToSuggestions applies focus then maps', () => {
        const out = findingsToSuggestions(
            [f({ severity: 'low', description: 'perf', file: 'p.js' }), f()],
            'security',
        );
        // 'p.js' (low, no security term) dropped; critical price-tampering kept
        expect(out).toHaveLength(1);
        expect(out[0].label).toBe(PREVIEW_ENV_LABEL);
    });
});
