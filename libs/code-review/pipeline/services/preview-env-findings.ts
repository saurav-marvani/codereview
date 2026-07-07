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

/** Wrap the executed repro as a collapsed proof block for the PR comment.
 *  When a run viewer URL is given, a link to the full run (transcript + logs)
 *  is appended so the reviewer can open the whole session from the PR. */
export function proofBlock(evidence: string, runUrl?: string): string {
    const body = (evidence ?? '').slice(0, 6000).trim();
    const link = runUrl ? `\n\n▶ [View the full Kody Runtime run](${runUrl})` : '';
    return `\n\n<details><summary>✅ Reproduced by running the PR in a preview environment</summary>\n\n\`\`\`\n${body}\n\`\`\`\n</details>${link}`;
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
    runUrl?: string,
): Partial<CodeSuggestion> & { postPrLevel?: boolean } {
    const anchor = firstChangedLineForFile(changedFiles, finding.file);
    return {
        relevantFile: finding.file,
        language: '',
        suggestionContent: (finding.description ?? '').trim() + proofBlock(finding.evidence, runUrl),
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
 * Focus STEERS, it never SUPPRESSES. The directive is handed to the agent so it
 * prioritizes what to execute (see the `focus` arg on agent.run) — a keyword
 * filter on the OUTPUT then discards real, reproduced findings whose wording
 * didn't happen to echo the directive's terms. That fired on a live run of a
 * real PR: the agent returned 1 reproduced finding and this filter dropped it to
 * 0 because a prose directive's terms didn't match. So this is now a no-op that
 * returns every finding; the review directive is a hint that only prioritizes,
 * never silences (same contract as the normal reviewer's <ReviewFocus>).
 * Kept as a function (stable signature) so callers/tests don't churn.
 */
export function applyFocus(findings: PreviewFinding[], _focus?: string): PreviewFinding[] {
    return findings;
}

export function findingsToSuggestions(
    findings: PreviewFinding[],
    focus?: string,
    changedFiles: FileChange[] = [],
    runUrl?: string,
): Array<Partial<CodeSuggestion> & { postPrLevel?: boolean }> {
    return applyFocus(findings, focus).map((f) =>
        findingToSuggestion(f, changedFiles, runUrl),
    );
}
