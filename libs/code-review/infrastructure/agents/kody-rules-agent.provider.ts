import { Injectable } from '@nestjs/common';
import { PromptRunnerService } from '@kodus/kodus-common/llm';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import {
    BaseCodeReviewAgentProvider,
    ReviewAgentIdentity,
    ReviewAgentInput,
    ReviewAgentOutput,
} from './base-code-review-agent.provider';
import {
    IKodyRule,
    KodyRulesScope,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/**
 * Agent that validates code changes against Kody Rules (team-defined rules).
 *
 * Unlike the bug/security/performance agents that look for general issues,
 * this agent focuses exclusively on checking whether changed code violates
 * the team's custom rules (scope: FILE and PULL_REQUEST, type: STANDARD).
 *
 * Memory rules (type: MEMORY) are handled by the other agents via their
 * system prompts — this agent only handles formal STANDARD rules.
 */
@Injectable()
export class KodyRulesAgentProvider extends BaseCodeReviewAgentProvider {
    constructor(
        promptRunnerService: PromptRunnerService,
        permissionValidationService: PermissionValidationService,
        observabilityService: ObservabilityService,
    ) {
        super(
            promptRunnerService,
            permissionValidationService,
            observabilityService,
        );
    }

    protected getIdentity(): ReviewAgentIdentity {
        return {
            name: 'kodus-rules-review-agent',
            description:
                'Code review agent specialized in validating code changes against ' +
                'team-defined rules and conventions. Investigates code to check ' +
                'compliance with each rule before reporting violations.',
            goal:
                'Check every applicable rule against the changed code. ' +
                'Only report violations you confirmed with evidence from the code.',
            expertise: [
                'Custom team rule validation',
                'Convention compliance checking',
                'Path-based rule filtering',
                'Code pattern matching against examples',
            ],
        };
    }

    protected getCategoryLabel(): string {
        return 'kody_rules';
    }

    // Store rules for injection into system prompt
    private currentRules: string = '';

    /**
     * Override execute to inject rules into the prompt dynamically.
     */
    async execute(
        input: ReviewAgentInput & { kodyRules?: Partial<IKodyRule>[] },
    ): Promise<ReviewAgentOutput> {
        const rules = (input.kodyRules || []).filter(
            (r) => r.type !== KodyRulesType.MEMORY && r.status === 'active',
        );

        if (rules.length === 0) {
            return {
                suggestions: [],
                agentName: this.getIdentity().name,
                turnsUsed: 0,
                durationMs: 0,
            };
        }

        // Store formatted rules — getCategoryPrompt() will include them
        this.currentRules = this.formatKodyRules(rules, input.changedFiles);

        if (!this.currentRules) {
            return {
                suggestions: [],
                agentName: this.getIdentity().name,
                turnsUsed: 0,
                durationMs: 0,
            };
        }

        return super.execute(input);
    }

    /**
     * Override to include the current rules in the category prompt.
     * This places rules inside <Expertise> in the system prompt.
     */
    protected getCategoryPrompt(): string {
        const base = `## Focus: Team Rules & Conventions

You validate code against the team's custom rules listed below. Your ONLY job is to check these rules — do not look for general bugs, security issues, or performance problems.

### How to analyze:
1. **Read each rule carefully**: Understand what the rule requires and what path patterns it applies to.
2. **Check applicability**: Only check a rule if the changed files match its path pattern (if specified).
3. **Investigate with tools**: Use readFile/grep to verify whether the changed code complies with each rule.
4. **Use examples**: If a rule has examples, compare the changed code against them.
5. **Report violations only**: Do NOT report code that correctly follows the rules.

### What to report:
- Code that violates a specific team rule
- Include which rule was violated (by title)
- Include evidence from the code showing the violation

### Skip:
- General bugs, security issues, performance problems (handled by other agents)
- Code that follows the rules correctly
- Rules whose path patterns don't match any changed file`;

        if (this.currentRules) {
            return `${base}\n\n${this.currentRules}`;
        }
        return base;
    }

    /**
     * Override user prompt: send full diffs + PR context.
     * PR-level rules need to see the full picture (e.g., "every PR must have tests").
     * File-level rules benefit from seeing the diff to understand what changed.
     */
    protected buildUserPrompt(input: ReviewAgentInput): string {
        const diffsSection =
            input.changedFiles
                ?.map((file) => {
                    const diff =
                        (file as any).patchWithLinesStr ??
                        (file as any).patch ??
                        '';
                    return `### ${file.filename}\n\`\`\`diff\n${diff}\n\`\`\``;
                })
                .join('\n\n') || 'No changed files provided.';

        const prDescription = input.prBody ? input.prBody : '';
        const prContextSection = input.prTitle
            ? `\n  <PRContext>Title: ${input.prTitle}\nDescription: ${prDescription || '(empty)'}</PRContext>`
            : '';

        return `<ReviewTask>${prContextSection}
  <Diffs>
${diffsSection}
  </Diffs>

  <OutputFormat>
After investigating with tools, respond with ONLY a JSON block.
There are TWO formats depending on the rule scope:

**File-level rule violation** (scope: Per-file) — includes file, lines, and code:
\`\`\`json
{
  "ruleUuid": "uuid-of-the-violated-rule",
  "relevantFile": "path/to/file.ts",
  "language": "typescript",
  "suggestionContent": "Violates rule 'Rule Title': description of violation with evidence",
  "existingCode": "code that violates the rule",
  "improvedCode": "code that follows the rule",
  "oneSentenceSummary": "Brief: violates 'Rule Title'",
  "relevantLinesStart": 10,
  "relevantLinesEnd": 15
}
\`\`\`

**PR-level rule violation** (scope: Pull request level) — NO file, lines, or code:
\`\`\`json
{
  "ruleUuid": "uuid-of-the-violated-rule",
  "suggestionContent": "Violates rule 'Rule Title': description of the PR-level violation",
  "oneSentenceSummary": "Brief: violates 'Rule Title'"
}
\`\`\`

Full response structure:
\`\`\`json
{
  "reasoning": "Summary of which rules you checked and what you found",
  "suggestions": [ ...file-level and/or PR-level violations... ]
}
\`\`\`

IMPORTANT:
- "ruleUuid" MUST be the exact UUID provided for the violated rule. This is required for tracking.
- For PR-level rules, do NOT include "relevantFile", "relevantLinesStart", "relevantLinesEnd", "existingCode", or "improvedCode".
- For file-level rules, ALL fields including file and lines are required.

If no violations found, respond with \`{"reasoning": "Checked all rules, no violations found", "suggestions": []}\`.
  </OutputFormat>

  <Rules>
    <Rule>Check EVERY rule against the diffs and use tools to investigate further if needed.</Rule>
    <Rule>For PR-level rules (e.g., "must have tests", "PR description requirements"), evaluate the PR as a whole — check the PR title, description, and the full list of changed files. Do NOT attach these to a specific file.</Rule>
    <Rule>For file-level rules, check the diff of each applicable file and report with file path and line numbers.</Rule>
    <Rule>If a rule has a Reference file, use readFile to read it and understand the expected pattern before checking.</Rule>
    <Rule>Only report actual violations — not code that follows the rules.</Rule>
    <Rule>Include the rule title in the suggestionContent so the team knows which rule was violated.</Rule>
  </Rules>
</ReviewTask>`;
    }

    /**
     * Format Kody Rules into a structured prompt section.
     * Filters rules by path applicability to changed files.
     */
    private formatKodyRules(
        rules: Partial<IKodyRule>[],
        changedFiles: { filename: string }[],
    ): string {
        const changedPaths = changedFiles.map((f) => f.filename);

        const applicableRules = rules.filter((rule) => {
            // If no path pattern, rule applies to all files
            if (!rule.path) return true;

            // Check if any changed file matches the path pattern
            return changedPaths.some((filePath) =>
                this.matchesPathPattern(filePath, rule.path!),
            );
        });

        if (applicableRules.length === 0) return '';

        const formatted = applicableRules.map((rule, i) => {
            const parts = [
                `### Rule ${i + 1}: ${rule.title}`,
                `**UUID**: \`${rule.uuid}\``,
                `**Description**: ${rule.rule}`,
            ];

            if (rule.path) {
                parts.push(`**Applies to**: files matching \`${rule.path}\``);
            }

            if (rule.scope) {
                parts.push(
                    `**Scope**: ${rule.scope === KodyRulesScope.FILE ? 'Per-file' : 'Pull request level'}`,
                );
            }

            if (rule.examples && rule.examples.length > 0) {
                parts.push('**Examples**:');
                for (const ex of rule.examples) {
                    const label = ex.isCorrect ? 'Correct' : 'Incorrect';
                    parts.push(`- ${label}:\n\`\`\`\n${ex.snippet}\n\`\`\``);
                }
            }

            // External references: tell the agent to use readFile to fetch them
            if (rule.sourcePath) {
                const anchor = rule.sourceAnchor
                    ? ` (section: ${rule.sourceAnchor})`
                    : '';
                parts.push(
                    `**Reference**: \`${rule.sourcePath}\`${anchor} — use readFile to read this file for the full pattern/convention`,
                );
            }

            if (rule.extendedContext?.todo) {
                parts.push(
                    `**Additional context**: ${rule.extendedContext.todo}`,
                );
            }

            return parts.join('\n');
        });

        return `## Team Rules to Validate (${applicableRules.length} rules)\n\nCheck EVERY rule below against the changed code. Report violations only.\n\n${formatted.join('\n\n---\n\n')}`;
    }

    /**
     * Simple path pattern matching.
     * Supports: exact match, glob-like patterns (* and **), directory prefix.
     */
    private matchesPathPattern(filePath: string, pattern: string): boolean {
        // Exact match
        if (filePath === pattern) return true;

        // Directory prefix (e.g., "src/controllers/")
        if (pattern.endsWith('/') && filePath.startsWith(pattern)) return true;

        // Simple glob: convert * to regex
        const regexStr = pattern
            .replace(/\*\*/g, '<<<DOUBLESTAR>>>')
            .replace(/\*/g, '[^/]*')
            .replace(/<<<DOUBLESTAR>>>/g, '.*')
            .replace(/\./g, '\\.');

        try {
            return new RegExp(`^${regexStr}$`).test(filePath);
        } catch {
            // Invalid pattern — treat as prefix match
            return filePath.includes(pattern);
        }
    }
}
