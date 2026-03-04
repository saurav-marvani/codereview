/**
 * Feature-extraction prompt for code review safeguard.
 *
 * Instead of asking the LLM to make a keep/discard decision directly,
 * this prompt asks it to extract structured boolean features.
 * Decision logic lives in code (safeguardTriage.service.ts).
 */

export interface SafeguardFeatureSet {
    has_resource_leak: boolean;
    has_inconsistent_contract: boolean;
    has_wrong_algorithm: boolean;
    has_data_exposure: boolean;
    has_missing_error_handling: boolean;
    has_redundant_work_in_loop: boolean;
    requires_assumed_input: boolean;
    requires_assumed_workload: boolean;
    is_quality_opinion: boolean;
    is_anti_pattern_only: boolean;
    targets_unchanged_code: boolean;
    improvedCode_is_correct: boolean;
}

export interface SafeguardFeatureExtractionResult {
    codeSuggestions: Array<{
        id: string;
        features: SafeguardFeatureSet;
    }>;
}

export const STRUCTURAL_DEFECT_FEATURES: (keyof SafeguardFeatureSet)[] = [
    'has_resource_leak',
    'has_inconsistent_contract',
    'has_wrong_algorithm',
    'has_data_exposure',
    'has_missing_error_handling',
    'has_redundant_work_in_loop',
];

export const prompt_codeReviewSafeguard_featureExtraction = (params: {
    languageResultPrompt: string;
}) => {
    const { languageResultPrompt } = params;

    return `You evaluate code review suggestions by extracting structured features. Do NOT decide the action yourself — just extract the features honestly.

For each suggestion, extract these boolean features:

1. **has_resource_leak**: Does the code open a resource (file, connection, stream, statement) without closing it on all paths?
2. **has_inconsistent_contract**: Do different methods in the same class handle the same concern inconsistently? (e.g., some synchronized, some not)
3. **has_wrong_algorithm**: Does the code use a fundamentally wrong algorithm or data structure for its purpose? (e.g., SHA-256 for passwords, HashMap assuming order)
4. **has_data_exposure**: Does the code expose sensitive data (passwords, tokens, hashes) in return values or logs?
5. **has_missing_error_handling**: Does the code ignore a return value or exception from a call that can fail, leading to silent wrong behavior?
6. **has_redundant_work_in_loop**: Does the code perform repeated unnecessary work inside a loop? (e.g., loading a template per iteration)
7. **requires_assumed_input**: Does the issue ONLY manifest if you assume a specific input that no visible caller provides? ("if null is passed", "if attacker sends X")
8. **requires_assumed_workload**: Does the issue ONLY manifest under assumed load conditions? ("under high traffic", "with many concurrent users")
9. **is_quality_opinion**: Is the suggestion about code style, design preferences, testability, function purity, naming, parameter optionality, or "could be better" — WITHOUT identifying a concrete runtime defect? Set to true if: suggesting optional→required or required→optional changes, recommending dependency injection, arguing about code organization, flagging impure functions for testability, or criticizing intentional design decisions (e.g., "you removed feature X" when X was deliberately removed).
10. **is_anti_pattern_only**: Does the suggestion flag a known anti-pattern without showing structural harm in this specific code? Set to true if: the suggestion says "this pattern is bad practice" but cannot demonstrate a concrete failure scenario in the actual running code.
11. **targets_unchanged_code**: Does the suggestion target code NOT modified in the PR diff?
12. **improvedCode_is_correct**: Is the suggested fix syntactically and logically correct?

Output JSON:
\`\`\`json
{
    "codeSuggestions": [
        {
            "id": string,
            "features": {
                "has_resource_leak": boolean,
                "has_inconsistent_contract": boolean,
                "has_wrong_algorithm": boolean,
                "has_data_exposure": boolean,
                "has_missing_error_handling": boolean,
                "has_redundant_work_in_loop": boolean,
                "requires_assumed_input": boolean,
                "requires_assumed_workload": boolean,
                "is_quality_opinion": boolean,
                "is_anti_pattern_only": boolean,
                "targets_unchanged_code": boolean,
                "improvedCode_is_correct": boolean
            }
        }
    ]
}
\`\`\`

**Feature extraction rules:**
- Only set a structural feature to true if you can point to specific lines in the visible code that demonstrate the defect.
- Set speculation features to true if verifying the issue requires imagining callers, inputs, attackers, or workloads not visible in the provided context.
- If a suggestion mentions a real pattern (e.g., "resource leak") but the resource IS properly closed in the visible code, set the structural feature to false.
- Be honest: if unsure, prefer false for structural features and true for speculation features.
- If a suggestion argues "what if caller X doesn't provide Y" or "what if this function fails" WITHOUT showing that X actually fails to provide Y in the visible code, set \`requires_assumed_input\` to true.
- If a suggestion criticizes a deliberate refactoring choice (removing code, changing a schema, replacing one approach with another), set \`is_quality_opinion\` to true — the safeguard should not second-guess intentional design decisions.

Respond in ${languageResultPrompt} for any explanations, but keep feature names in English.

The current date is ${new Date().toLocaleDateString('en-GB')}.`;
};
