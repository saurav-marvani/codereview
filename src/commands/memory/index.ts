import { Command } from 'commander';
import { enableAction } from './enable.js';
import { disableAction } from './disable.js';
import { captureAction } from './capture.js';
import { sessionHooksCommand } from './session-hooks/index.js';

export const decisionsCommand = new Command('decisions').description(
    'Session tracking, decision capture, and structured logging',
);

decisionsCommand.addCommand(sessionHooksCommand);

decisionsCommand
    .command('enable')
    .description('Install session tracking and decision capture hooks')
    .option(
        '--agents <agents>',
        'Comma-separated list: claude,cursor,codex',
        'claude,cursor,codex',
    )
    .option(
        '--codex-config <path>',
        'Path to Codex config.toml (default: ~/.codex/config.toml)',
    )
    .action(enableAction);

decisionsCommand
    .command('disable')
    .description('Remove all hooks')
    .action(disableAction);

decisionsCommand
    .command('capture')
    .description('Internal hook command to submit decision capture to API')
    .argument('[payload]', 'Optional payload JSON (used by Codex notify)')
    .requiredOption(
        '--agent <agent>',
        'Agent name: claude-compatible, claude-code, cursor, codex',
    )
    .requiredOption('--event <event>', 'Hook event name')
    .option('--summary <text>', 'Optional summary text')
    .action(captureAction);
