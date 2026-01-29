import { api } from './api/index.js';
import { authService } from './auth.service.js';
import { gitService } from './git.service.js';
import { getTrialIdentifier } from '../utils/rate-limit.js';
import { loadConfig } from '../utils/config.js';
import { CLI_VERSION } from '../constants.js';
import chalk from 'chalk';
import type { ReviewConfig, ReviewResult, TrialReviewResult, PullRequestSuggestionsResponse, ReviewIssue, ApiFileSuggestion, ApiPrLevelSuggestion, ApiSuggestionsObject, Severity } from '../types/index.js';

class ReviewService {
  private verbose: boolean = false;

  setVerbose(verbose: boolean): void {
    this.verbose = verbose;
  }

  async analyze(
    diff: string,
    rulesOnly?: boolean,
    fast?: boolean,
    options?: { files?: string[]; staged?: boolean; commit?: string; branch?: string }
  ): Promise<ReviewResult> {
    const token = await authService.getValidToken();

    if (this.verbose) {
      console.log(chalk.dim(`[verbose] Review config: rulesOnly=${!!rulesOnly}, fast=${!!fast}`));
      console.log(chalk.dim(`[verbose] Diff size: ${diff.length} characters`));
    }

    const reviewConfig: ReviewConfig = {
      rulesOnly,
      fast,
    };

    if (!fast) {
      reviewConfig.files = await gitService.getFullFileContents(
        options?.files,
        {
          staged: options?.staged,
          commit: options?.commit,
          branch: options?.branch,
        }
      );
      
      if (this.verbose) {
        console.log(chalk.dim(`[verbose] Full file contents: ${reviewConfig.files?.length || 0} file(s)`));
        if (reviewConfig.files && reviewConfig.files.length > 0) {
          reviewConfig.files.forEach(f => {
            console.log(chalk.dim(`[verbose]   - ${f.path}: ${f.content.length} chars, status=${f.status}`));
          });
        }
      }
    }

    const teamConfig = await loadConfig();
    const isTeamKey = token.startsWith('kodus_');

    if (isTeamKey && teamConfig) {
      const gitInfo = await gitService.getGitInfo();
      const inferredPlatform = gitInfo.remote
        ? gitService.inferPlatform(gitInfo.remote)
        : undefined;

      if (this.verbose) {
        console.log(chalk.dim('[verbose] Using team key with metrics'));
        console.log(chalk.dim(`[verbose] Git info: branch=${gitInfo.branch}, remote=${gitInfo.remote}`));
        console.log(chalk.dim('[verbose] Sending to API:'));
        console.log(chalk.dim(`[verbose]   - diff length: ${diff.length} chars`));
        console.log(chalk.dim(`[verbose]   - config: ${JSON.stringify(reviewConfig)}`));
      }

      const result = await api.review.analyzeWithMetrics(
        diff,
        token,
        reviewConfig,
        {
          userEmail: gitInfo.userEmail,
          gitRemote: gitInfo.remote || undefined,
          branch: gitInfo.branch,
          commitSha: gitInfo.commitSha,
          inferredPlatform,
          cliVersion: CLI_VERSION,
        }
      );

      if (this.verbose) {
        console.log(chalk.dim('[verbose] API response:'));
        console.log(chalk.dim(`[verbose]   - summary: ${result.summary}`));
        console.log(chalk.dim(`[verbose]   - issues: ${result.issues?.length ?? 0}`));
        console.log(chalk.dim(`[verbose]   - filesAnalyzed: ${result.filesAnalyzed}`));
      }

      return result;
    }

    if (this.verbose) {
      console.log(chalk.dim('[verbose] Using personal token (no metrics)'));
    }

    if (this.verbose) {
      console.log(chalk.dim('[verbose] Sending to API:'));
      console.log(chalk.dim(`[verbose]   - diff length: ${diff.length} chars`));
      console.log(chalk.dim(`[verbose]   - config: ${JSON.stringify(reviewConfig)}`));
    }

    const result = await api.review.analyze(diff, token, reviewConfig);

    if (this.verbose) {
      console.log(chalk.dim('[verbose] API response:'));
      console.log(chalk.dim(`[verbose]   - summary: ${result.summary}`));
      console.log(chalk.dim(`[verbose]   - issues: ${result.issues?.length ?? 0}`));
      console.log(chalk.dim(`[verbose]   - filesAnalyzed: ${result.filesAnalyzed}`));
    }

    return result;
  }

  async getPullRequestSuggestions(params: { prUrl?: string; prNumber?: number; repositoryId?: string; format?: 'markdown'; severity?: string; category?: string }): Promise<{ result: ReviewResult; markdown?: string }> {
    if (!params.prUrl && !(params.prNumber && params.repositoryId)) {
      throw new Error('Provide prUrl or prNumber with repositoryId to fetch pull request suggestions.');
    }

    const token = await authService.getValidToken();
    const response = await api.review.getPullRequestSuggestions(token, params);
    return {
      result: this.normalizeSuggestionsResponse(response),
      markdown: response.markdown,
    };
  }

  async trialAnalyze(diff: string): Promise<TrialReviewResult> {
    const fingerprint = await getTrialIdentifier();

    if (this.verbose) {
      console.log(chalk.dim('[verbose] Running trial analyze'));
      console.log(chalk.dim(`[verbose] Diff size: ${diff.length} characters`));
      // Show diff preview
      const preview = diff.substring(0, 300);
      console.log(chalk.dim(`[verbose] Diff preview:\n${preview}${diff.length > 300 ? '\n... (truncated)' : ''}`));
    }

    const result = await api.review.trialAnalyze(diff, fingerprint);

    if (this.verbose) {
      console.log(chalk.dim('[verbose] Trial API response:'));
      console.log(chalk.dim(`[verbose]   - summary: ${result.summary}`));
      console.log(chalk.dim(`[verbose]   - issues: ${result.issues?.length ?? 0}`));
      console.log(chalk.dim(`[verbose]   - filesAnalyzed: ${result.filesAnalyzed}`));
    }

    return result;
  }

  normalizeSuggestionsResponse(response: PullRequestSuggestionsResponse): ReviewResult {
    let issues: ReviewIssue[] = [];

    if (Array.isArray(response.issues)) {
      issues = response.issues;
    } else if (Array.isArray(response.suggestions)) {
      issues = response.suggestions;
    } else if (response.suggestions && typeof response.suggestions === 'object') {
      const suggestionsObj = response.suggestions as ApiSuggestionsObject;
      issues = [
        ...this.mapFileSuggestions(suggestionsObj.files ?? []),
        ...this.mapPrLevelSuggestions(suggestionsObj.prLevel ?? []),
      ];
    }

    return {
      summary: response.summary ?? 'Pull request suggestions',
      issues,
      filesAnalyzed: response.filesAnalyzed ?? new Set(issues.map(i => i.file)).size,
      duration: response.duration ?? 0,
    };
  }

  mapFileSuggestions(files: ApiFileSuggestion[]): ReviewIssue[] {
    return files.map((s) => ({
      file: s.filePath ?? s.relevantFile,
      line: s.relevantLinesStart ?? 1,
      endLine: s.relevantLinesEnd,
      severity: this.normalizeSeverity(s.severity),
      message: s.suggestionContent,
      suggestion: s.oneSentenceSummary,
      ruleId: s.label,
    }));
  }

  mapPrLevelSuggestions(prLevel: ApiPrLevelSuggestion[]): ReviewIssue[] {
    return prLevel.map((s) => ({
      file: 'PR',
      line: 0,
      severity: this.normalizeSeverity(s.severity),
      message: s.suggestionContent,
      suggestion: s.oneSentenceSummary,
      ruleId: s.label,
    }));
  }

  normalizeSeverity(severity?: string): Severity {
    if (!severity) return 'info';
    const s = severity.toLowerCase();
    if (s === 'critical') return 'critical';
    if (s === 'high' || s === 'error') return 'error';
    if (s === 'medium' || s === 'warning') return 'warning';
    return 'info';
  }
}

export const reviewService = new ReviewService();
