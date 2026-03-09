import chalk from 'chalk';
import { gitService } from '../../services/git.service.js';
import {
    parseAgents,
    installClaudeCompatibleHooks,
    installCodexNotify,
    resolveCodexConfigPath,
} from './hooks.js';
import { installSessionHooks } from './session-hooks-install.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import { cliError, cliInfo } from '../../utils/logger.js';

interface EnableOptions {
    agents?: string;
    codexConfig?: string;
}

export async function enableAction(options: EnableOptions): Promise<void> {
    const isRepo = await gitService.isGitRepository();
    if (!isRepo) {
        cliError(chalk.red('Error: Not a git repository.'));
        exitWithCode(1);
    }

    const gitRoot = (await gitService.getGitRoot()).trim();

    let agents: Set<string>;
    try {
        agents = parseAgents(options.agents ?? 'claude,cursor,codex');
    } catch (error) {
        cliError(chalk.red((error as Error).message));
        exitWithCode(1);
    }

    const installClaudeCompat = agents.has('claude') || agents.has('cursor');
    const installCodex = agents.has('codex');

    // 1. Decision capture hooks (Claude Code / Cursor)
    let captureStatus = 'skipped';
    if (installClaudeCompat) {
        const result = await installClaudeCompatibleHooks(gitRoot);
        captureStatus = result.changed ? 'installed' : 'already configured';
    }

    // 2. Session tracking hooks (Claude Code / Cursor)
    let sessionStatus = 'skipped';
    if (installClaudeCompat) {
        const result = await installSessionHooks(gitRoot, 'claude-code');
        sessionStatus = result.changed ? 'installed' : 'already configured';
    }

    // 3. Codex notify
    let codexStatus = 'skipped';
    if (installCodex) {
        const codexConfigPath = resolveCodexConfigPath(options.codexConfig);
        const result = await installCodexNotify(codexConfigPath);
        if (result.changed) {
            codexStatus = 'installed';
        } else if (result.skipped) {
            codexStatus = 'skipped (existing notify entry)';
        } else {
            codexStatus = 'already configured';
        }
    }

    // Summary
    cliInfo(chalk.green('\u2713 Decisions enabled for this repository.'));
    cliInfo(`  Decision capture hooks: ${captureStatus}`);
    cliInfo(`  Session tracking hooks: ${sessionStatus}`);
    cliInfo(`  Codex notify: ${codexStatus}`);
}
