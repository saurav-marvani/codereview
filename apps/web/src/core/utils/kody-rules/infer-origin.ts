/**
 * Classifies a Kody rule's origin for UI display.
 *
 * The backend persists rules produced by several different flows but they all
 * share the same shape. To show meaningful badges (instead of a blanket
 * "Auto-sync" label) we infer the origin from the combination of `origin`
 * and `sourcePath`:
 *
 *   - "Kody-generated": rule was proposed by the LLM-based generator (originally
 *     created with `origin === "generated"`, pending user approval).
 *   - "Auto-sync": rule was imported from a recognised IDE rule file such as
 *     `.cursorrules`, `.cursor/rules/**.mdc`, `CLAUDE.md`, etc.
 *   - "Onboard": rule was persisted by the fast-sync onboarding flow which
 *     analyses arbitrary repo files (package.json, esbuild.config.js, etc).
 *   - "manual": hand-authored in the web UI.
 */
export type InferredRuleOrigin =
    | "Auto-sync"
    | "Onboard"
    | "Kody-generated"
    | "manual";

// Keep the key names the badge uses verbatim as the classifier output so the
// two never drift. Each key IS the badge label (except "manual" which hides).

// Recognises the file-path shapes that can ONLY come from the IDE-rule sync
// flow (i.e. the list in libs/common/utils/kody-rules/file-patterns.ts).
// Kept as a small regex list so it works standalone in the browser bundle
// without pulling in picomatch.
const IDE_RULE_SOURCE_PATTERNS: RegExp[] = [
    /(?:^|\/)\.cursorrules$/,
    /(?:^|\/)\.cursor\/rules\//,
    /(?:^|\/)\.github\/copilot-instructions\.md$/,
    /(?:^|\/)\.github\/instructions\//,
    /(?:^|\/)\.agents?\.md$/,
    /(?:^|\/)CLAUDE\.md$/,
    /(?:^|\/)\.claude\//,
    /(?:^|\/)\.windsurfrules$/,
    /(?:^|\/)\.sourcegraph\//,
    /(?:^|\/)\.opencode\.json$/,
    /(?:^|\/)\.aider\.conf\.yml$/,
    /(?:^|\/)\.aiderignore$/,
    /(?:^|\/)\.rules\//,
    /(?:^|\/)\.kody\/rules\//,
    /(?:^|\/)docs\/coding-standards\//,
];

export function isIdeRuleSource(
    sourcePath: string | null | undefined,
): boolean {
    if (!sourcePath) return false;
    return IDE_RULE_SOURCE_PATTERNS.some((pattern) => pattern.test(sourcePath));
}

export function inferRuleOrigin(rule: {
    sourcePath?: string | null;
    origin?: string | null;
}): InferredRuleOrigin {
    if (rule?.origin === "generated") return "Kody-generated";
    if (!rule?.sourcePath) return "manual";
    if (isIdeRuleSource(rule.sourcePath)) return "Auto-sync";
    return "Onboard";
}
