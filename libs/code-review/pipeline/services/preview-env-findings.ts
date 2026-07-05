import { CodeSuggestion, FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { PreviewFinding } from '@libs/sandbox/infrastructure/services/preview-env-agent.service';

/**
 * Pure mapping between the preview-env agent's findings and Kody's
 * CodeSuggestion, so preview findings flow through the SAME downstream
 * (dedup → comments → critical gating) as the normal review. Kept pure and
 * unit-tested; the stage does the I/O.
 */
export const PREVIEW_ENV_LABEL = 'kody_preview_env';

/** Reconstruct a unified diff from the PR's changed files (for the agent). */
export function buildDiffFromChangedFiles(changedFiles: FileChange[] = []): string {
    return changedFiles
        .filter((f) => f?.patch)
        .map((f) => `diff --git a/${f.filename} b/${f.filename}\n--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}`)
        .join('\n');
}

/** Wrap the executed repro as a collapsed proof block for the PR comment. */
export function proofBlock(evidence: string): string {
    const body = (evidence ?? '').slice(0, 6000).trim();
    return `\n\n<details><summary>✅ Reproduced by running the PR in a preview environment</summary>\n\n\`\`\`\n${body}\n\`\`\`\n</details>`;
}

/**
 * Map one preview finding → Partial<CodeSuggestion>. Proof goes into
 * suggestionContent (no evidence field on the comment). label marks provenance
 * so the UI/summary can badge "verified by execution". No improvedCode — these
 * aren't auto-fixable one-liners; empty string keeps the type happy and drops
 * the Apply button.
 */
export function findingToSuggestion(finding: PreviewFinding): Partial<CodeSuggestion> {
    return {
        relevantFile: finding.file,
        language: '',
        suggestionContent: (finding.description ?? '').trim() + proofBlock(finding.evidence),
        oneSentenceSummary: (finding.description ?? '').split('\n')[0].slice(0, 160),
        improvedCode: '',
        relevantLinesStart: 1,
        relevantLinesEnd: 1,
        label: PREVIEW_ENV_LABEL,
        severity: finding.severity,
    };
}

/**
 * Focus filter: when the reviewer set a focus directive, keep only findings
 * that match it — EXCEPT always keep reproduced critical security/data defects
 * (a real breach shouldn't be silenced by a narrow focus). Best-effort keyword
 * match on the directive; the agent already prioritizes focus, this is a
 * belt-and-suspenders filter.
 */
export function applyFocus(findings: PreviewFinding[], focus?: string): PreviewFinding[] {
    if (!focus?.trim()) return findings;
    const terms = focus
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 3);
    if (!terms.length) return findings;
    return findings.filter((f) => {
        if (f.severity === 'critical') return true;
        const hay = `${f.description} ${f.file}`.toLowerCase();
        return terms.some((t) => hay.includes(t));
    });
}

export function findingsToSuggestions(
    findings: PreviewFinding[],
    focus?: string,
): Partial<CodeSuggestion>[] {
    return applyFocus(findings, focus).map(findingToSuggestion);
}
