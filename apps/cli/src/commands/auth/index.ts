import { Command } from 'commander';
import { loginAction } from './login.js';
import { logoutAction } from './logout.js';
import { statusAction } from './status.js';
import { tokenAction } from './token.js';
import { teamKeyAction, teamStatusAction } from './team-key.js';

export const authCommand = new Command('auth').description(
    'Authentication commands',
);

authCommand
    .command('login')
    .description('Login with email and password')
    .option('-e, --email <email>', 'Email address')
    .option('-p, --password <password>', 'Password')
    .action(loginAction);

authCommand
    .command('logout')
    .description('Remove local authentication (login and team key)')
    .action(logoutAction);

authCommand
    .command('status')
    .description('Show authentication status and usage limits')
    .action(statusAction);

authCommand
    .command('token')
    .description('Generate a token for CI/CD')
    .action(tokenAction);

authCommand
    .command('team-key')
    .description('Authenticate using team API key')
    .requiredOption('--key <key>', 'Team API key from Kodus dashboard')
    .action(teamKeyAction);

authCommand
    .command('team-status')
    .description('Show team authentication status')
    .action(teamStatusAction);
