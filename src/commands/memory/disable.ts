import chalk from 'chalk';
import { gitService } from '../../services/git.service.js';
import {
    removeClaudeCompatibleHooks,
    removeCodexNotify,
    resolveCodexConfigPath,
} from './hooks.js';
import { removeSessionHooks } from './session-hooks-install.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import { cliError, cliInfo } from '../../utils/logger.js';

export async function disableAction(): Promise<void> {
    const isRepo = await gitService.isGitRepository();
    if (!isRepo) {
        cliError(chalk.red('Error: Not a git repository.'));
        exitWithCode(1);
    }

    const gitRoot = (await gitService.getGitRoot()).trim();

    const claudeResult = await removeClaudeCompatibleHooks(gitRoot);
    const sessionResult = await removeSessionHooks(gitRoot);
    const codexResult = await removeCodexNotify(resolveCodexConfigPath());

    const captureRemoved = claudeResult.removed;
    const sessionRemoved = sessionResult.removed;

    cliInfo(chalk.green('\u2713 Decision hooks removed.'));
    cliInfo(`  Decision capture hooks: ${captureRemoved ? 'removed' : 'not found'}`);
    cliInfo(`  Session tracking hooks: ${sessionRemoved ? 'removed' : 'not found'}`);
    cliInfo(`  Codex notify: ${codexResult.removed ? 'removed' : 'not found'}`);
}
