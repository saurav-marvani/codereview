import { input, password, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import ora from 'ora';
import { authService } from '../../services/auth.service.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import { cliError, cliInfo } from '../../utils/logger.js';

interface LoginOptions {
    email?: string;
    password?: string;
}

export async function loginAction(options: LoginOptions): Promise<void> {
    const spinner = ora();

    try {
        const isAuthenticated = await authService.isAuthenticated();

        if (isAuthenticated && !options.email) {
            const credentials = await authService.getCredentials();
            const email = credentials?.user?.email;
            cliInfo(
                chalk.yellow(
                    email
                        ? `\nAlready logged in as ${email}`
                        : '\nAlready authenticated with team key',
                ),
            );

            const shouldRelogin = await confirm({
                message: email
                    ? 'Do you want to login with a different account?'
                    : 'Do you want to login with an account instead?',
                default: false,
            });

            if (!shouldRelogin) {
                return;
            }
        }

        let email = options.email;
        let pwd = options.password;

        if (!email) {
            email = await input({
                message: 'Email:',
                validate: (value) => {
                    if (!value || !value.includes('@')) {
                        return 'Please enter a valid email';
                    }
                    return true;
                },
            });
        }

        if (!pwd) {
            pwd = await password({
                message: 'Password:',
                mask: '*',
                validate: (value) => {
                    if (!value || value.length < 6) {
                        return 'Password must be at least 6 characters';
                    }
                    return true;
                },
            });
        }

        spinner.start(chalk.blue('Logging in...'));

        await authService.login(email!, pwd!);

        spinner.succeed(chalk.green(`Logged in as ${email}`));
    } catch (error) {
        // Check if user cancelled prompt (Ctrl+C throws Error)
        if (error instanceof Error && error.message.includes('force closed')) {
            cliInfo(chalk.yellow('\nOperation cancelled'));
            return;
        }

        spinner.fail(chalk.red('Login failed'));

        if (error instanceof Error) {
            cliError(chalk.red(error.message));
        }
        exitWithCode(1);
    }
}
