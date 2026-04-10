import { Injectable } from '@nestjs/common';
import {
    FileChange,
    CodeSuggestion,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    CliReviewInput,
    CliReviewResponse,
    CliReviewIssue,
} from '@libs/cli-review/domain/types/cli-review.types';
import { convertToUnifiedDiffWithLineNumbers } from '@libs/common/utils/patch';
import { createLogger } from '@kodus/flow';
import * as crypto from 'crypto';

@Injectable()
export class CliInputConverter {
    private readonly logger = createLogger(CliInputConverter.name);
    /**
     * Converts CLI input to FileChange[] for pipeline processing
     */
    convertToFileChanges(input: CliReviewInput): FileChange[] {
        const isFastMode = input.config?.fast === true || !input.config?.files;

        if (isFastMode) {
            // Fast mode: Only diff provided, parse files from unified diff
            return this.parseFilesFromDiff(input.diff);
        } else {
            // Normal mode: Full file content provided
            return this.convertFromFilesList(input.config.files || []);
        }
    }

    /**
     * Parse files from unified diff (fast mode)
     * Extracts individual file changes from a unified diff string
     */
    private parseFilesFromDiff(unifiedDiff: string): FileChange[] {
        const files: FileChange[] = [];

        // Remove context section markers (CLI enrichment)
        const cleanedDiff = this.removeContextSections(unifiedDiff);

        // Split by file (diff --git markers)
        const diffBlocks = cleanedDiff
            .split(/(?=diff --git)/g)
            .filter((b) => b.trim());

        for (const block of diffBlocks) {
            try {
                const filename = this.extractFilename(block);
                if (!filename) continue;

                const { additions, deletions } = this.countChanges(block);
                const status = this.detectFileStatus(block);

                files.push({
                    filename,
                    patch: block,
                    patchWithLinesStr: convertToUnifiedDiffWithLineNumbers(
                        block,
                        {
                            filename,
                        },
                    ),
                    status,
                    additions,
                    deletions,
                    changes: additions + deletions,
                    sha: this.generateCliSha(filename),
                    content: null,
                    blob_url: '',
                    raw_url: '',
                    contents_url: '',
                    fileContent: undefined, // No file content in fast mode
                });
            } catch (error) {
                this.logger.error({
                    message: 'Failed to parse diff block',
                    context: CliInputConverter.name,
                    error:
                        error instanceof Error
                            ? error
                            : new Error(String(error)),
                    metadata: {
                        blockSnippet: block.substring(0, 200),
                    },
                });
                continue;
            }
        }

        return files;
    }

    /**
     * Convert from files list (normal mode with full content)
     */
    private convertFromFilesList(
        files: CliReviewInput['config']['files'],
    ): FileChange[] {
        return files.map((file) => ({
            filename: file.path,
            patch: file.diff,
            patchWithLinesStr: convertToUnifiedDiffWithLineNumbers(file.diff, {
                filename: file.path,
            }),
            status: file.status as any,
            additions: this.countAdditions(file.diff),
            deletions: this.countDeletions(file.diff),
            changes:
                this.countAdditions(file.diff) + this.countDeletions(file.diff),
            sha: this.generateCliSha(file.path),
            content: null,
            blob_url: '',
            raw_url: '',
            contents_url: '',
            fileContent: file.content, // ← CRITICAL: This feeds HEAVY_MODE in LLM
        }));
    }

    /**
     * Convert pipeline output to CLI response format
     */
    convertToCliResponse(
        validSuggestions: Partial<CodeSuggestion>[],
        filesAnalyzed: number,
        startTime: number,
    ): CliReviewResponse {
        const issues: CliReviewIssue[] = validSuggestions.map((suggestion) => ({
            file: suggestion.relevantFile || '',
            line: suggestion.relevantLinesStart || 0,
            endLine: suggestion.relevantLinesEnd,
            severity: this.mapSeverity(suggestion.severity),
            category: this.mapCategory(suggestion.label),
            message: suggestion.suggestionContent || '',
            suggestion: suggestion.improvedCode,
            recommendation: (suggestion as any).recommendation,
            ruleId: suggestion.brokenKodyRulesIds?.[0],
            fixable: false, // TODO: Implement fix detection based on improvedCode
        }));

        const duration = Date.now() - startTime;
        const summary = this.generateSummary(issues, filesAnalyzed);

        return {
            summary,
            issues,
            filesAnalyzed,
            duration,
        };
    }

    // ===== Helper Methods =====

    /**
     * Remove context sections added by CLI (.cursorrules, claude.md, etc)
     */
    private removeContextSections(diff: string): string {
        // Remove sections like "=== Cursor Rules ===" etc
        const cleaned = diff.replace(
            /^===\s+[^\n]+\s+===[\s\S]*?(?=^diff\s+--git|$)/gm,
            '',
        );
        return cleaned.trim();
    }

    /**
     * Extract filename from diff block
     */
    private extractFilename(diffBlock: string): string | null {
        // Try +++ b/ format first (most common)
        let match = diffBlock.match(/\+\+\+ b\/(.+)/);
        if (match) return match[1].trim();

        // Try diff --git format
        match = diffBlock.match(/diff --git a\/(.+) b\//);
        if (match) return match[1].trim();

        return null;
    }

    /**
     * Count additions and deletions in a diff
     */
    private countChanges(diff: string): {
        additions: number;
        deletions: number;
    } {
        const lines = diff.split('\n');
        let additions = 0;
        let deletions = 0;

        for (const line of lines) {
            if (line.startsWith('+') && !line.startsWith('+++')) {
                additions++;
            } else if (line.startsWith('-') && !line.startsWith('---')) {
                deletions++;
            }
        }

        return { additions, deletions };
    }

    private countAdditions(diff: string): number {
        return this.countChanges(diff).additions;
    }

    private countDeletions(diff: string): number {
        return this.countChanges(diff).deletions;
    }

    /**
     * Detect file status from diff markers
     */
    private detectFileStatus(diffBlock: string): FileChange['status'] {
        if (diffBlock.includes('new file mode')) return 'added';
        if (diffBlock.includes('deleted file mode')) return 'removed';
        if (diffBlock.includes('rename from')) return 'renamed';
        return 'modified';
    }

    /**
     * Generate a SHA for CLI-generated file changes
     */
    private generateCliSha(filename: string): string {
        return crypto
            .createHash('sha256')
            .update(`cli-${filename}-${Date.now()}`)
            .digest('hex')
            .substring(0, 40);
    }

    /**
     * Normalize severity to standard values (low | medium | high | critical)
     */
    private mapSeverity(severity: string | undefined): string {
        const normalized = severity?.toLowerCase() || 'medium';
        const validSeverities = ['low', 'medium', 'high', 'critical'];

        return validSeverities.includes(normalized) ? normalized : 'medium';
    }

    /**
     * Map internal category/label to CLI category
     */
    private mapCategory(label: string | undefined): string | undefined {
        const categoryMap: Record<string, string> = {
            security_vulnerability: 'security_vulnerability',
            security: 'security_vulnerability',
            performance: 'performance',
            code_quality: 'code_quality',
            best_practices: 'best_practices',
            style: 'style',
            bug: 'bug',
            complexity: 'complexity',
            maintainability: 'maintainability',
        };

        if (!label) return undefined;
        return categoryMap[label.toLowerCase()] || label;
    }

    /**
     * Generate summary message based on issues found
     */
    private generateSummary(
        issues: CliReviewIssue[],
        filesAnalyzed: number,
    ): string {
        if (issues.length === 0) {
            return `No issues found in ${filesAnalyzed} file(s)`;
        }

        const criticalCount = issues.filter(
            (i) => i.severity === 'critical',
        ).length;
        const errorCount = issues.filter((i) => i.severity === 'error').length;
        const warningCount = issues.filter(
            (i) => i.severity === 'warning',
        ).length;

        const parts: string[] = [];

        if (criticalCount > 0) {
            parts.push(`${criticalCount} critical`);
        }
        if (errorCount > 0) {
            parts.push(`${errorCount} error${errorCount > 1 ? 's' : ''}`);
        }
        if (warningCount > 0) {
            parts.push(`${warningCount} warning${warningCount > 1 ? 's' : ''}`);
        }

        const severitySummary =
            parts.length > 0 ? ` (${parts.join(', ')})` : '';

        return `Found ${issues.length} issue${issues.length > 1 ? 's' : ''} in ${filesAnalyzed} file${filesAnalyzed > 1 ? 's' : ''}${severitySummary}`;
    }
}
