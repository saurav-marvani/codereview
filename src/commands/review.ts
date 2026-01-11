import { Command } from 'commander';
import ora from 'ora';
import chalk from 'chalk';
import { gitService } from '../services/git.service.js';
import { reviewService } from '../services/review.service.js';
import { authService } from '../services/auth.service.js';
import { contextService } from '../services/context.service.js';
import { telemetryService } from '../services/telemetry.service.js';
import { terminalFormatter } from '../formatters/terminal.js';
import { jsonFormatter } from '../formatters/json.js';
import { markdownFormatter } from '../formatters/markdown.js';
import { promptFormatter } from '../formatters/prompt.js';
import { interactiveUI } from '../ui/interactive.js';
import { fixService } from '../services/fix.service.js';
import { showTrialLimitPrompt, checkTrialStatus } from '../utils/rate-limit.js';
import type { GlobalOptions, OutputFormat, ReviewResult, TrialReviewResult } from '../types/index.js';
import fs from 'fs/promises';

export const reviewCommand = new Command('review')
  .description('Analyze modified files for code review')
  .argument('[files...]', 'Specific files to analyze')
  .option('-s, --staged', 'Analyze only staged files')
  .option('-c, --commit <sha>', 'Analyze diff from a specific commit')
  .option('-b, --branch <name>', 'Compare current branch against specified branch (e.g., main)')
  .option('--rules-only', 'Review using only configured rules (no general suggestions)')
  .option('--fast', 'Fast mode: quicker analysis with lighter checks')
  .option('-i, --interactive', 'Interactive mode: navigate and apply fixes')
  .option('--fix', 'Automatically apply all fixable issues')
  .option('--prompt-only', 'Output optimized for AI agents (minimal, structured)')
  .option('--context <file>', 'Custom context file to include in review')
  .action(async (files: string[], options: { staged?: boolean; commit?: string; branch?: string; rulesOnly?: boolean; fast?: boolean; interactive?: boolean; fix?: boolean; promptOnly?: boolean; context?: string }, cmd: Command) => {
    const globalOpts = cmd.optsWithGlobals() as GlobalOptions & { staged?: boolean; commit?: string };
    const spinner = ora();

    try {
      const isAuthenticated = await authService.isAuthenticated();
      const startTime = Date.now();

      // Track review started
      telemetryService.track('review_started', {
        is_authenticated: isAuthenticated,
        staged: options.staged || false,
        has_commit: !!options.commit,
        has_files: files && files.length > 0,
        rules_only: options.rulesOnly || false,
        fast: options.fast || false,
        interactive: options.interactive || false,
        fix: options.fix || false,
        prompt_only: options.promptOnly || false,
        has_context: !!options.context,
        format: globalOpts.format,
      });

      // Override format if --prompt-only is set
      if (options.promptOnly) {
        globalOpts.format = 'prompt';
      }

      if (!globalOpts.quiet) {
        spinner.start(chalk.cyan('Checking authentication...'));
      }

      let result: ReviewResult | TrialReviewResult;

      if (isAuthenticated) {
        let config;

        try {
          if (!globalOpts.quiet) {
            spinner.text = chalk.cyan('Fetching configuration from platform...');
          }
          config = await reviewService.getConfig(globalOpts.org, globalOpts.repo);
        } catch (error) {
          // Config endpoint não existe ou falhou - usar config padrão
          config = {
            language: 'en',
            severity: 'warning' as const,
            rules: {
              security: true,
              performance: true,
              style: true,
              bestPractices: true,
            },
            ignore: [],
            llmProvider: 'kodus' as const,
          };
        }

        if (!globalOpts.quiet) {
          spinner.text = chalk.cyan('Getting file changes...');
        }

        let diff = await getDiff(files, options);

        if (!diff) {
          spinner.fail(chalk.yellow('No changes to review'));
          return;
        }

        // Enrich with project context
        if (!globalOpts.quiet) {
          spinner.text = chalk.cyan('Reading project context...');
        }

        diff = await contextService.enrichDiffWithContext(diff, options.context);

        if (!globalOpts.quiet) {
          spinner.text = chalk.cyan('Analyzing code...');
        }

        result = await reviewService.analyze(diff, config, options.rulesOnly, options.fast, {
          files: files && files.length > 0 ? files : undefined,
          staged: options.staged,
          commit: options.commit,
          branch: options.branch,
        });
        const modeLabel = options.fast ? ' (fast mode)' : '';
        spinner.succeed(chalk.green(`Review complete!${modeLabel}`));
      } else {
        if (!globalOpts.quiet) {
          spinner.text = chalk.cyan('Running in trial mode...');
        }

        const trialStatus = await checkTrialStatus();

        if (trialStatus.isLimited) {
          spinner.stop();
          showTrialLimitPrompt(trialStatus);
          return;
        }

        if (!globalOpts.quiet) {
          spinner.text = chalk.cyan('Getting file changes...');
        }

        let diff = await getDiff(files, options);

        if (!diff) {
          spinner.fail(chalk.yellow('No changes to review'));
          return;
        }

        // Enrich with project context
        if (!globalOpts.quiet) {
          spinner.text = chalk.cyan('Reading project context...');
        }

        diff = await contextService.enrichDiffWithContext(diff, options.context);

        if (!globalOpts.quiet) {
          spinner.text = chalk.cyan('Analyzing code (trial mode)...');
        }

        result = await reviewService.trialAnalyze(diff);
        spinner.succeed(chalk.green(`Review complete! (Trial: ${(result as TrialReviewResult).trialInfo.reviewsUsed}/${(result as TrialReviewResult).trialInfo.reviewsLimit} reviews today)`));
      }

      // Track review completed
      const duration = Date.now() - startTime;
      telemetryService.track('review_completed', {
        is_authenticated: isAuthenticated,
        files_analyzed: result.filesAnalyzed,
        issues_found: result.issues.length,
        critical_issues: result.issues.filter(i => i.severity === 'critical').length,
        error_issues: result.issues.filter(i => i.severity === 'error').length,
        warning_issues: result.issues.filter(i => i.severity === 'warning').length,
        fixable_issues: result.issues.filter(i => i.fixable).length,
        duration_ms: duration,
        mode: options.interactive ? 'interactive' : options.fix ? 'fix' : 'normal',
        format: globalOpts.format,
      });

      // Handle fix mode
      if (options.fix) {
        await interactiveUI.runQuickFix(result);
        telemetryService.track('fix_mode_used');
        return;
      }

      // Handle interactive mode (now default if no output format specified)
      const shouldUseInteractive = options.interactive || (!globalOpts.output && globalOpts.format === 'terminal');

      if (shouldUseInteractive) {
        await interactiveUI.run(result);
        telemetryService.track('interactive_mode_used');
        return;
      }

      // Regular output (only when --format or --output is specified)
      const output = formatOutput(result, globalOpts.format);

      if (globalOpts.output) {
        await fs.writeFile(globalOpts.output, output, 'utf-8');
        console.log(chalk.green(`\nOutput saved to ${globalOpts.output}`));
      } else if (globalOpts.format === 'terminal') {
        console.log(output);
      } else {
        console.log(output);
      }

    } catch (error) {
      spinner.fail(chalk.red('Review failed'));

      // Track review failed
      telemetryService.track('review_failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      if (error instanceof Error) {
        console.error(chalk.red(error.message));
        if (globalOpts.verbose) {
          console.error(error.stack);
        }
      } else {
        console.error(chalk.red('An unexpected error occurred'));
        if (globalOpts.verbose) {
          console.error(error);
        }
      }
      process.exit(1);
    }
  });

async function getDiff(files: string[], options: { staged?: boolean; commit?: string; branch?: string }): Promise<string> {
  if (files && files.length > 0) {
    return gitService.getDiffForFiles(files);
  }

  if (options.branch) {
    return gitService.getDiffForBranch(options.branch);
  }

  if (options.commit) {
    return gitService.getDiffForCommit(options.commit);
  }

  if (options.staged) {
    return gitService.getStagedDiff();
  }

  return gitService.getWorkingTreeDiff();
}

function formatOutput(result: ReviewResult, format: OutputFormat): string {
  switch (format) {
    case 'json':
      return jsonFormatter.format(result);
    case 'markdown':
      return markdownFormatter.format(result);
    case 'prompt':
      return promptFormatter.format(result);
    case 'terminal':
    default:
      return terminalFormatter.format(result);
  }
}

