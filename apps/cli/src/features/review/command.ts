import { Command } from 'commander';
import ora, { type Ora } from 'ora';
import chalk from 'chalk';
import fs from 'fs/promises';
import { gitService } from '../../services/git.service.js';
import { reviewService } from '../../services/review.service.js';
import { authService } from '../../services/auth.service.js';
import { contextService } from '../../services/context.service.js';
import { interactiveUI } from '../../ui/interactive.js';
import {
    showTrialLimitPrompt,
    checkTrialStatus,
} from '../../utils/rate-limit.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import { cliDebug, cliError, cliInfo } from '../../utils/logger.js';
import { createCommandContext } from '../../utils/command-context.js';
import {
    buildAgentErrorEnvelope,
    buildAgentSuccessEnvelope,
    emitAgentEnvelope,
} from '../../utils/command-output.js';
import { normalizeCommandError } from '../../utils/command-errors.js';
import {
    assertStructuredOutputForFields,
    parseFieldList,
} from '../../utils/input-validation.js';
import { applyFieldMask } from '../../utils/field-mask.js';
import { formatReviewOutput } from '../../utils/review-output.js';
import { resolveReviewDiff } from './diff.js';
import { buildReviewErrorHints } from './errors.js';
import { buildNoChangesMessages } from './no-changes.js';
import { validateReviewOptions } from './options.js';
import {
    formatFailOnExitMessage,
    formatTrialCompletionMessage,
    shouldFailReview,
    shouldUseInteractiveReview,
} from './result.js';
import type { GlobalOptions } from '../../types/cli.js';
import type { ReviewResult, TrialReviewResult } from '../../types/review.js';

type ReviewCommandOptions = {
    staged?: boolean;
    commit?: string;
    branch?: string;
    rulesOnly?: boolean;
    fast?: boolean;
    interactive?: boolean;
    fix?: boolean;
    promptOnly?: boolean;
    context?: string;
    failOn?: string;
    fields?: string;
};

export function createReviewCommand(): Command {
    return new Command('review')
        .description(`Analyze modified files for code review

Examples:
  kodus review
  kodus review --staged
  kodus review --branch main
  kodus review src/auth.ts src/config.ts
  kodus review --fail-on error`)
        .argument('[files...]', 'Specific files to analyze')
        .option('-s, --staged', 'Analyze only staged files')
        .option('-c, --commit <sha>', 'Analyze diff from a specific commit')
        .option(
            '-b, --branch <name>',
            'Compare current branch against specified branch (e.g., main)',
        )
        .option(
            '--rules-only',
            'Review using only configured rules (no general suggestions)',
        )
        .option('--fast', 'Fast mode: quicker analysis with lighter checks')
        .option(
            '-i, --interactive',
            'Interactive mode: navigate and apply fixes',
        )
        .option('--fix', 'Automatically apply all fixable issues')
        .option(
            '--prompt-only',
            'Output optimized for AI agents (minimal, structured)',
        )
        .option(
            '--fail-on <severity>',
            'Exit with code 1 if issues meet or exceed severity (info, warning, error, critical)',
        )
        .option('--context <file>', 'Custom context file to include in review')
        .option(
            '--fields <csv>',
            'Select response fields (JSON/agent mode only), e.g. summary,issues.file',
        )
        .action(reviewAction);
}

async function reviewAction(
    files: string[],
    options: ReviewCommandOptions,
    cmd: Command,
): Promise<void> {
    const globalOpts = cmd.optsWithGlobals() as GlobalOptions & {
        staged?: boolean;
        commit?: string;
    };
    const ctx = createCommandContext('review', globalOpts);
    const spinner = ora();
    const fields = parseFieldList(options.fields);

    try {
        validateReviewOptions(options);

        assertStructuredOutputForFields({
            fields: options.fields,
            format: globalOpts.format,
            isAgent: ctx.isAgent,
        });

        if (options.promptOnly && !ctx.isAgent) {
            globalOpts.format = 'prompt';
        }

        if (!globalOpts.quiet && !ctx.isAgent) {
            spinner.start(chalk.cyan('Checking authentication...'));
        }

        const isAuthenticated = await authService.isAuthenticated();

        let result: ReviewResult | TrialReviewResult;

        if (isAuthenticated) {
            if (!globalOpts.quiet && !ctx.isAgent) {
                spinner.text = chalk.cyan('Getting file changes...');
            }

            let diff = await getDiff(files, options, globalOpts.verbose);

            if (!diff) {
                await handleNoChanges(
                    ctx,
                    spinner,
                    files,
                    options,
                    globalOpts.verbose,
                    globalOpts.quiet,
                );
                return;
            }

            if (!globalOpts.quiet && !ctx.isAgent) {
                spinner.text = chalk.cyan('Reading project context...');
            }

            if (globalOpts.verbose) {
                cliDebug(chalk.dim('[verbose] Reading project context files...'));
            }

            diff = await contextService.enrichDiffWithContext(
                diff,
                options.context,
                globalOpts.verbose,
            );

            if (!globalOpts.quiet && !ctx.isAgent) {
                spinner.text = chalk.cyan('Analyzing code...');
            }

            if (globalOpts.verbose) {
                reviewService.setVerbose(true);
            }

            result = await reviewService.analyze(
                diff,
                options.rulesOnly,
                options.fast,
                {
                    files: files.length > 0 ? files : undefined,
                    staged: options.staged,
                    commit: options.commit,
                    branch: options.branch,
                    quiet: globalOpts.quiet,
                },
            );
            const modeLabel = options.fast ? ' (fast mode)' : '';
            if (!globalOpts.quiet && !ctx.isAgent) {
                spinner.succeed(chalk.green(`Review complete!${modeLabel}`));
            }
        } else {
            if (!globalOpts.quiet && !ctx.isAgent) {
                spinner.text = chalk.cyan('Running in trial mode...');
            }

            const trialStatus = await checkTrialStatus();

            if (trialStatus.isLimited) {
                spinner.stop();
                showTrialLimitPrompt(trialStatus);
                return;
            }

            if (!globalOpts.quiet && !ctx.isAgent) {
                spinner.text = chalk.cyan('Getting file changes...');
            }

            let diff = await getDiff(files, options, globalOpts.verbose);

            if (!diff) {
                await handleNoChanges(
                    ctx,
                    spinner,
                    files,
                    options,
                    globalOpts.verbose,
                    globalOpts.quiet,
                );
                return;
            }

            if (!globalOpts.quiet && !ctx.isAgent) {
                spinner.text = chalk.cyan('Reading project context...');
            }

            if (globalOpts.verbose) {
                cliDebug(chalk.dim('[verbose] Reading project context files...'));
            }

            diff = await contextService.enrichDiffWithContext(
                diff,
                options.context,
                globalOpts.verbose,
            );

            if (!globalOpts.quiet && !ctx.isAgent) {
                spinner.text = chalk.cyan('Analyzing code (trial mode)...');
            }

            if (globalOpts.verbose) {
                reviewService.setVerbose(true);
            }

            const trialResult = await reviewService.trialAnalyze(diff);
            result = trialResult;
            if (!globalOpts.quiet && !ctx.isAgent) {
                spinner.succeed(
                    chalk.green(formatTrialCompletionMessage(trialResult)),
                );
            }
        }

        if (options.fix) {
            await interactiveUI.runQuickFix(result);

            if (ctx.isAgent) {
                await emitAgentEnvelope(
                    buildAgentSuccessEnvelope(
                        ctx.command,
                        { fixedIssues: true },
                        ctx.startedAt,
                    ),
                    ctx.outputFile,
                );
            }
            return;
        }

        const selectedResult = fields ? applyFieldMask(result, fields) : result;
        const shouldUseInteractive = shouldUseInteractiveReview({
            isAgent: ctx.isAgent,
            interactive: options.interactive,
            output: globalOpts.output,
            format: globalOpts.format,
        });

        if (shouldUseInteractive) {
            await interactiveUI.run(result);
            return;
        }

        if (ctx.isAgent) {
            await emitAgentEnvelope(
                buildAgentSuccessEnvelope(
                    ctx.command,
                    selectedResult,
                    ctx.startedAt,
                ),
                ctx.outputFile,
            );
        } else {
            const output = formatReviewOutput(
                selectedResult as ReviewResult,
                globalOpts.format,
            );

            if (globalOpts.output) {
                await fs.writeFile(globalOpts.output, output, 'utf-8');
                cliInfo(chalk.green(`\nOutput saved to ${globalOpts.output}`));
            } else {
                cliInfo(output);
            }
        }

        if (shouldFailReview(result, options.failOn)) {
            const failMessage = formatFailOnExitMessage(result, options.failOn);
            if (failMessage && !ctx.isAgent) {
                cliInfo(chalk.yellow(failMessage));
            }
            exitWithCode(1);
        }
    } catch (error) {
        const normalized = normalizeCommandError(error);

        if (ctx.isAgent) {
            await emitAgentEnvelope(
                buildAgentErrorEnvelope(
                    ctx.command,
                    {
                        code: normalized.code,
                        message: normalized.message,
                        details: normalized.details,
                    },
                    ctx.startedAt,
                ),
                ctx.outputFile,
            );

            if (normalized.exitCode > 0) {
                exitWithCode(normalized.exitCode);
            }
            return;
        }

        if (!globalOpts.quiet && spinner.isSpinning) {
            spinner.fail(chalk.red('Review failed'));
        }

        if (error instanceof Error) {
            cliError(chalk.red(error.message));
            for (const hint of buildReviewErrorHints(normalized)) {
                cliInfo(chalk.dim(hint));
            }
            if (globalOpts.verbose) {
                cliError(error.stack);
            }
        } else {
            cliError(chalk.red('An unexpected error occurred'));
            if (globalOpts.verbose) {
                cliError(error);
            }
        }
        exitWithCode(normalized.exitCode);
    }
}

async function handleNoChanges(
    ctx: ReturnType<typeof createCommandContext>,
    spinner: Ora,
    files: string[],
    options: Pick<ReviewCommandOptions, 'branch' | 'commit' | 'staged'>,
    verbose = false,
    quiet = false,
): Promise<void> {
    if (ctx.isAgent) {
        await emitAgentEnvelope(
            buildAgentErrorEnvelope(
                ctx.command,
                {
                    code: 'NO_CHANGES',
                    message: 'No changes to review',
                },
                ctx.startedAt,
            ),
            ctx.outputFile,
        );
        return;
    }

    if (!quiet) {
        spinner.fail(chalk.yellow('No changes to review'));
        for (const message of buildNoChangesMessages(files, options)) {
            cliInfo(chalk.dim(message));
        }
    }

    if (verbose) {
        cliDebug(chalk.dim('[verbose] Checked scopes:'));
        cliDebug(
            chalk.dim(
                `  - Specific files: ${files.length > 0 ? files.join(', ') : 'none'}`,
            ),
        );
        cliDebug(
            chalk.dim(`  - Branch comparison: ${options.branch || 'none'}`),
        );
        cliDebug(chalk.dim(`  - Commit: ${options.commit || 'none'}`));
        cliDebug(
            chalk.dim(`  - Staged only: ${options.staged ? 'yes' : 'no'}`),
        );
        cliDebug(
            chalk.dim(
                `  - Default: ${!files.length && !options.branch && !options.commit && !options.staged ? 'working tree (staged + unstaged)' : 'no'}`,
            ),
        );
    }
}

async function getDiff(
    files: string[],
    options: Pick<ReviewCommandOptions, 'staged' | 'commit' | 'branch'>,
    verbose?: boolean,
): Promise<string> {
    const result = await resolveReviewDiff({
        files,
        options,
        verbose,
        git: gitService,
    });

    result.verboseMessages.forEach((message) => {
        cliDebug(chalk.dim(message));
    });

    return result.diff;
}

export const reviewCommand = createReviewCommand();
