import { CodeSuggestion, FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { PreviewFinding } from '@libs/sandbox/infrastructure/services/preview-env-agent.service';

/**
 * Pure mapping between the preview-env agent's findings and Kody's
 * CodeSuggestion, so preview findings flow through the SAME downstream
 * (dedup → comments → critical gating) as the normal review. Kept pure and
 * unit-tested; the stage does the I/O.
 */
export const PREVIEW_ENV_LABEL = 'kody_runtime';

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
 * The line number of the first ADDED line of `file` in the PR diff (RIGHT
 * side), parsed from the unified patch. Runtime findings carry no line (the
 * agent finds bugs by EXECUTION, not by pointing at a diff line), so anchoring
 * to line 1 made GitHub 422 the inline comment every time (line 1 is almost
 * never in the diff). Anchoring to a real changed line of the file makes the
 * comment postable. Returns null when the file isn't in the diff (or has no
 * added line) — the caller then posts it PR-level instead of dropping it.
 */
export function firstChangedLineForFile(
    changedFiles: FileChange[] = [],
    file?: string,
): number | null {
    const patch = changedFiles.find((f) => f?.filename === file)?.patch;
    if (!patch) return null;
    let newLine = 0;
    for (const raw of patch.split('\n')) {
        const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunk) {
            newLine = parseInt(hunk[1], 10);
            continue;
        }
        if (raw.startsWith('+') && !raw.startsWith('+++')) return newLine; // first added line
        if (raw.startsWith('-') || raw.startsWith('---')) continue; // removals don't advance RIGHT
        newLine++; // context line
    }
    return null;
}

/**
 * Map one preview finding → Partial<CodeSuggestion>. Proof goes into
 * suggestionContent (no evidence field on the comment). label marks provenance
 * so the UI/summary can badge "verified by execution". No improvedCode — these
 * aren't auto-fixable one-liners; empty string keeps the type happy and drops
 * the Apply button. Anchored to a real changed line of the finding's file so
 * the inline comment doesn't 422 (see firstChangedLineForFile); when the file
 * isn't in the diff, `postPrLevel` tells the stage to post it PR-level.
 */
export function findingToSuggestion(
    finding: PreviewFinding,
    changedFiles: FileChange[] = [],
): Partial<CodeSuggestion> & { postPrLevel?: boolean } {
    const anchor = firstChangedLineForFile(changedFiles, finding.file);
    return {
        relevantFile: finding.file,
        language: '',
        suggestionContent: (finding.description ?? '').trim() + proofBlock(finding.evidence),
        oneSentenceSummary: (finding.description ?? '').split('\n')[0].slice(0, 160),
        improvedCode: '',
        relevantLinesStart: anchor ?? 1,
        relevantLinesEnd: anchor ?? 1,
        label: PREVIEW_ENV_LABEL,
        severity: finding.severity,
        // No changed line to attach to → the stage posts this PR-level so the
        // executed finding is never silently lost to a 422.
        postPrLevel: anchor == null,
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
    changedFiles: FileChange[] = [],
): Array<Partial<CodeSuggestion> & { postPrLevel?: boolean }> {
    return applyFocus(findings, focus).map((f) =>
        findingToSuggestion(f, changedFiles),
    );
}
