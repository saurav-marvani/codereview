/**
 * Loads the pre-generated safeguard prompt from JSON.
 *
 * To regenerate the prompt after codebase changes, run:
 *   pnpm run eval:safeguard:generate-prompt
 */

const fs = require('fs');
const path = require('path');

const promptPath = path.join(__dirname, 'generated-prompt.json');
const prompt = JSON.parse(fs.readFileSync(promptPath, 'utf8'));

// Promptfoo expects a function that returns the prompt string
module.exports = function(context) {
    return JSON.stringify(prompt);
};
