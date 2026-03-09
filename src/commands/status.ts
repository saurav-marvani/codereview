import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { gitService } from '../services/git.service.js';
import { loadConfig } from '../utils/config.js';
import { loadCredentials } from '../utils/credentials.js';
import { listBundledSkills } from '../utils/skills.js';
import { cliInfo } from '../utils/logger.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

const KODUS_HOOK_MARKER = '# kodus-hook';
const DECISIONS_CAPTURE_COMMAND_PREFIX = 'kodus decisions capture';
const CODEX_NOTIFY_LINE =
    'notify = ["kodus", "decisions", "capture", "--agent", "codex", "--event", "stop"]';
const CODEX_NOTIFY_LINE_LEGACY =
    'notify = ["kodus", "decisions", "capture", "--agent", "codex", "--event", "agent-turn-complete"]';

interface RepoStatus {
    label: string;
    root: string | null;
}

async function getAuthModeLabel(): Promise<string> {
    const teamConfig = await loadConfig();
    if (teamConfig?.teamKey) {
        return 'team key';
    }

    const credentials = await loadCredentials();
    if (credentials?.accessToken || credentials?.refreshToken) {
        return 'logged in';
    }

    return 'trial';
}

async function getRepositoryStatus(): Promise<RepoStatus> {
    const isRepo = await gitService.isGitRepository();
    if (!isRepo) {
        return { label: 'not a git repository', root: null };
    }

    const root = (await gitService.getGitRoot()).trim();
    let branch = 'unknown';
    try {
        branch = (await gitService.getCurrentBranch()).trim();
    } catch {
        // Detached HEAD or unavailable branch. Keep fallback.
    }

    const shortRoot = root.startsWith(os.homedir())
        ? `~${root.slice(os.homedir().length)}`
        : root;
    return { label: `${shortRoot} (${branch})`, root };
}

async function getPrePushHookStatus(repoRoot: string | null): Promise<string> {
    if (!repoRoot) {
        return 'n/a';
    }

    const hookPath = path.join(repoRoot, '.git', 'hooks', 'pre-push');
    try {
        const content = await fs.readFile(hookPath, 'utf-8');
        if (content.includes(KODUS_HOOK_MARKER)) {
            return 'installed';
        }
        return 'installed (external)';
    } catch {
        return 'not installed';
    }
}

async function getDecisionHooksStatus(
    repoRoot: string | null,
): Promise<string> {
    const configured: string[] = [];

    if (repoRoot) {
        try {
            const claudeSettings = await fs.readFile(
                path.join(repoRoot, '.claude', 'settings.json'),
                'utf-8',
            );
            if (claudeSettings.includes(DECISIONS_CAPTURE_COMMAND_PREFIX)) {
                configured.push('claude/cursor');
            }
        } catch {
            // Not configured.
        }

    }

    try {
        const codexConfig = await fs.readFile(
            path.join(os.homedir(), '.codex', 'config.toml'),
            'utf-8',
        );
        if (
            codexConfig.includes(CODEX_NOTIFY_LINE) ||
            codexConfig.includes(CODEX_NOTIFY_LINE_LEGACY)
        ) {
            configured.push('codex');
        }
    } catch {
        // Not configured.
    }

    return configured.length > 0 ? configured.join(', ') : 'not configured';
}

export const statusCommand = new Command('status')
    .description('Show consolidated Kodus status')
    .action(async () => {
        const [authMode, repository, skills] = await Promise.all([
            getAuthModeLabel(),
            getRepositoryStatus(),
            listBundledSkills(),
        ]);

        const [hookStatus, decisionsStatus] = await Promise.all([
            getPrePushHookStatus(repository.root),
            getDecisionHooksStatus(repository.root),
        ]);

        cliInfo(chalk.bold('Kodus Status'));
        cliInfo('');
        cliInfo(`${chalk.dim('Version:')} ${pkg.version}`);
        cliInfo(`${chalk.dim('Auth:')} ${authMode}`);
        cliInfo(`${chalk.dim('Repository:')} ${repository.label}`);
        cliInfo(`${chalk.dim('Pre-push hook:')} ${hookStatus}`);
        cliInfo(`${chalk.dim('Decision hooks:')} ${decisionsStatus}`);
        cliInfo(`${chalk.dim('Bundled skills:')} ${skills.length}`);
    });
