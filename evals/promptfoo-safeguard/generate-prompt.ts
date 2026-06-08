#!/usr/bin/env npx ts-node

/**
 * Regenerates the safeguard prompt JSON from the codebase.
 * Run this after changing the safeguard prompt.
 *
 * Usage: pnpm run eval:safeguard:generate-prompt
 */

import * as fs from 'fs';
import * as path from 'path';
import {
    prompt_codeReviewSafeguard_system,
    SAFEGUARD_CROSS_FILE_CONTEXT_PREAMBLE,
} from '../../libs/common/utils/langchainCommon/prompts/codeReviewSafeguard';

const systemPrompt = prompt_codeReviewSafeguard_system({
    languageResultPrompt: 'en-US',
});

// User prompt mirrors preparePrefixChainForCache from llmAnalysis.service.ts
const userPrompt = `## Context

<fileContent>
    {{fileContent}}
</fileContent>

<codeDiff>
    {{patchWithLinesStr}}
</codeDiff>

<filePath>
    {{filePath}}
</filePath>

<suggestionsContext>
{{suggestionsContext}}
</suggestionsContext>

{{codebaseContext}}`;

const prompt = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
];

const outputPath = path.join(__dirname, 'generated-prompt.json');
fs.writeFileSync(outputPath, JSON.stringify(prompt, null, 2));

console.log(`Prompt generated: ${outputPath}`);
console.log(`System prompt length: ${systemPrompt.length} chars`);
