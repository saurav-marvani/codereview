import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs/promises';
import { reviewService } from '../services/review.service.js';
import { gitService } from '../services/git.service.js';
import { terminalFormatter } from '../formatters/terminal.js';
import { jsonFormatter } from '../formatters/json.js';
import { markdownFormatter } from '../formatters/markdown.js';
import { promptFormatter } from '../formatters/prompt.js';
import { resolveBusinessValidationMode } from './pr.business-validation-mode.js';
import type {
    GlobalOptions,
    OutputFormat,
    ReviewResult,
} from '../types/index.js';
import { exitWithCode } from '../utils/cli-exit.js';
import { cliDebug, cliError, cliInfo } from '../utils/logger.js';

export const prCommand = new Command('pr').description('Pull request commands');

prCommand
    .command('suggestions')
    .description('Fetch suggestions for a pull request')
    .option('--pr-url <url>', 'Pull request URL')
    .option('--pr-number <number>', 'Pull request number')
    .option('--repo-id <id>', 'Repository ID for the pull request')
    .option('--severity <list>', 'Comma-separated severities to include')
    .option('--category <list>', 'Comma-separated categories to include')
    .action(
        async (
            options: {
                prUrl?: string;
                prNumber?: string;
                repoId?: string;
                severity?: string;
                category?: string;
            },
            cmd: Command,
        ) => {
            const globalOpts = cmd.optsWithGlobals() as GlobalOptions;
            const spinner = ora();

            try {
                const prNumber =
                    options.prNumber !== undefined
                        ? Number(options.prNumber)
                        : undefined;

                if (options.prNumber !== undefined && Number.isNaN(prNumber)) {
                    throw new Error('Invalid --pr-number value');
                }

                if (!options.prUrl && !(prNumber && options.repoId)) {
                    cliError(
                        chalk.red(
                            'Provide --pr-url or both --pr-number and --repo-id.',
                        ),
                    );
                    exitWithCode(1);
                }

                const shouldRequestMarkdown =
                    globalOpts.format === 'prompt' ||
                    globalOpts.format === 'markdown';

                if (!globalOpts.quiet) {
                    spinner.start(
                        chalk.cyan('Fetching pull request suggestions...'),
                    );
                }

                const { result, markdown } =
                    await reviewService.getPullRequestSuggestions({
                        prUrl: options.prUrl,
                        prNumber,
                        repositoryId: options.repoId,
                        format: shouldRequestMarkdown ? 'markdown' : undefined,
                        severity: options.severity,
                        category: options.category,
                    });

                if (!globalOpts.quiet) {
                    spinner.succeed(chalk.green('Suggestions fetched'));
                }

                const output =
                    markdown && shouldRequestMarkdown
                        ? markdown
                        : formatOutput(result, globalOpts.format);

                if (globalOpts.output) {
                    await fs.writeFile(globalOpts.output, output, 'utf-8');
                    cliInfo(
                        chalk.green(`\nOutput saved to ${globalOpts.output}`),
                    );
                } else {
                    cliInfo(output);
                }
            } catch (error) {
                if (!globalOpts.quiet) {
                    spinner.fail(
                        chalk.red('Failed to fetch pull request suggestions'),
                    );
                }

                if (error instanceof Error) {
                    cliError(chalk.red(error.message));
                }

                exitWithCode(1);
            }
        },
    );

prCommand
    .command('business-validation')
    .alias('business-rules-validation')
    .description(
        'Run business rules validation for a pull request or local diff',
    )
    .argument(
        '[files...]',
        'Specific files to include in local diff mode',
    )
    .option('--pr-url <url>', 'Pull request URL')
    .option('--pr-number <number>', 'Pull request number')
    .option(
        '--repo-id <id>',
        'Repository ID (required with --pr-number if --repo is not provided)',
    )
    .option(
        '--repo <name>',
        'Repository full name/slug (required with --pr-number if --repo-id is not provided)',
    )
    .option('--task-url <url>', 'Task URL to append to the validation command')
    .option('--task-id <id>', 'Task ID or issue key (e.g. KC-1441) to append')
    .option(
        '-s, --staged',
        'Use only staged changes when running in local diff mode',
    )
    .option(
        '-c, --commit <sha>',
        'Use diff from a specific commit when running in local diff mode',
    )
    .option(
        '-b, --branch <name>',
        'Compare current branch against a base branch in local diff mode',
    )
    .option('--dry-run', 'Print payload without executing the API call', false)
    .action(
        async (
            files: string[],
            options: {
                prUrl?: string;
                prNumber?: string;
                repoId?: string;
                repo?: string;
                taskUrl?: string;
                taskId?: string;
                staged?: boolean;
                commit?: string;
                branch?: string;
                dryRun?: boolean;
            },
            cmd: Command,
        ) => {
            const spinner = ora();
            const globalOpts = cmd.optsWithGlobals() as GlobalOptions;

            try {
                const prNumber =
                    options.prNumber !== undefined
                        ? Number(options.prNumber)
                        : undefined;

                if (options.prNumber !== undefined && Number.isNaN(prNumber)) {
                    throw new Error('Invalid --pr-number value');
                }

                const mode = resolveBusinessValidationMode({
                    files,
                    prUrl: options.prUrl,
                    prNumber,
                    repoId: options.repoId,
                    repo: options.repo,
                    taskUrl: options.taskUrl,
                    taskId: options.taskId,
                    staged: options.staged,
                    commit: options.commit,
                    branch: options.branch,
                });

                let diff: string | undefined;
                let repository = options.repo;

                if (mode.mode === 'local_diff') {
                    diff = await getLocalDiffForBusinessValidation(
                        files ?? [],
                        options,
                        globalOpts.verbose,
                    );

                    if (!diff.trim()) {
                        throw new Error(
                            'No local changes found for the selected scope. Stage files or pick another scope (--branch/--commit/[files]).',
                        );
                    }

                    if (!options.repo && !options.repoId) {
                        const orgRepo = await gitService.extractOrgRepo();
                        if (orgRepo) {
                            repository = `${orgRepo.org}/${orgRepo.repo}`;
                        }
                    }
                }

                const payload = {
                    prUrl: mode.mode === 'pull_request' ? options.prUrl : undefined,
                    prNumber:
                        mode.mode === 'pull_request' ? prNumber : undefined,
                    repositoryId: options.repoId,
                    repository,
                    taskUrl: options.taskUrl,
                    taskId: options.taskId,
                    diff,
                };

                if (options.dryRun) {
                    cliInfo(
                        chalk.cyan(
                            'Dry run mode. Payload that would be sent to /cli/business-validation:',
                        ),
                    );
                    cliInfo(JSON.stringify(payload, null, 2));
                    return;
                }

                if (!globalOpts.quiet) {
                    spinner.start(chalk.cyan('Running business validation...'));
                }

                const response = await reviewService.triggerBusinessValidation({
                    ...payload,
                });

                if (!globalOpts.quiet) {
                    spinner.succeed(
                        chalk.green('Business validation completed.'),
                    );
                }
                cliInfo(
                    chalk.dim(
                        `Mode: ${response.mode === 'pull_request' ? 'pull request' : 'local diff'}`,
                    ),
                );
                if (
                    response.mode === 'pull_request' &&
                    response.prNumber !== undefined
                ) {
                    const repositoryLabel = response.repositoryName
                        ? ` (${response.repositoryName})`
                        : '';
                    cliInfo(
                        chalk.dim(
                            `PR: #${response.prNumber}${repositoryLabel}`,
                        ),
                    );
                } else if (response.repositoryName) {
                    cliInfo(
                        chalk.dim(`Repository: ${response.repositoryName}`),
                    );
                }
                if (response.taskReference) {
                    cliInfo(chalk.dim(`Task: ${response.taskReference}`));
                }
                cliInfo(chalk.dim(`Command: ${response.command}`));
                cliInfo('');
                cliInfo(response.result);
            } catch (error) {
                if (!globalOpts.quiet) {
                    spinner.fail(
                        chalk.red('Failed to trigger business validation'),
                    );
                }

                if (error instanceof Error) {
                    cliError(chalk.red(error.message));
                }

                exitWithCode(1);
            }
        },
    );

async function getLocalDiffForBusinessValidation(
    files: string[],
    options: { staged?: boolean; commit?: string; branch?: string },
    verbose?: boolean,
): Promise<string> {
    gitService.setVerbose(!!verbose);

    if (files.length > 0) {
        if (verbose) {
            cliDebug(
                chalk.dim(
                    `[verbose] Getting local diff for specific files: ${files.join(', ')}`,
                ),
            );
        }
        return gitService.getDiffForFiles(files);
    }

    if (options.branch) {
        if (verbose) {
            cliDebug(
                chalk.dim(
                    `[verbose] Getting local diff for branch: ${options.branch}`,
                ),
            );
        }
        return gitService.getDiffForBranch(options.branch);
    }

    if (options.commit) {
        if (verbose) {
            cliDebug(
                chalk.dim(
                    `[verbose] Getting local diff for commit: ${options.commit}`,
                ),
            );
        }
        return gitService.getDiffForCommit(options.commit);
    }

    if (options.staged) {
        if (verbose) {
            cliDebug(chalk.dim('[verbose] Getting local staged diff'));
        }
        return gitService.getStagedDiff();
    }

    throw new Error(
        'No local diff scope provided. Use --staged, --branch, --commit, or [files].',
    );
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
