import type { ReviewIssue } from '../types/review.js';

export function groupIssuesByFile(
    issues: ReviewIssue[],
): Map<string, ReviewIssue[]> {
    const grouped = new Map<string, ReviewIssue[]>();

    for (const issue of issues) {
        if (!grouped.has(issue.file)) {
            grouped.set(issue.file, []);
        }
        grouped.get(issue.file)!.push(issue);
    }

    return grouped;
}

export function getFileStats(issues: ReviewIssue[]): {
    critical: number;
    error: number;
    warning: number;
    info: number;
} {
    return {
        critical: issues.filter((i) => i.severity === 'critical').length,
        error: issues.filter((i) => i.severity === 'error').length,
        warning: issues.filter((i) => i.severity === 'warning').length,
        info: issues.filter((i) => i.severity === 'info').length,
    };
}

export function formatCategoryBadge(category: string): string {
    const categoryMap: Record<string, string> = {
        security_vulnerability: 'security',
        performance: 'perf',
        code_quality: 'quality',
        best_practices: 'practices',
        style: 'style',
        bug: 'bug',
        complexity: 'complex',
        maintainability: 'maintain',
    };
    return categoryMap[category] || category;
}

export function generateFixPrompt(
    file: string,
    issues: ReviewIssue[],
): string {
    let prompt = `Fix the following issues in ${file}:\n\n`;

    issues.forEach((issue, index) => {
        prompt += `${index + 1}. ${issue.severity.toUpperCase()} at line ${issue.line}\n`;
        prompt += `   ${issue.message}\n`;

        if (issue.suggestion) {
            prompt += `   Suggestion: ${issue.suggestion}\n`;
        }

        if (issue.recommendation) {
            prompt += `   Recommendation: ${issue.recommendation}\n`;
        }

        prompt += '\n';
    });

    prompt += `Please fix these ${issues.length} issue${issues.length > 1 ? 's' : ''} in ${file}.`;

    return prompt;
}

export function getQuickFixEmptyMessage(): string {
    return 'No auto-fixable issues found. Try `kodus review --interactive` to inspect issues or run `kodus review` to see the full report.';
}
