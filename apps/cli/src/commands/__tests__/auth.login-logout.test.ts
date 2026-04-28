import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const spinnerInstances: Array<{
    start: ReturnType<typeof vi.fn>;
    succeed: ReturnType<typeof vi.fn>;
    fail: ReturnType<typeof vi.fn>;
    text: string;
}> = [];

vi.mock('ora', () => ({
    default: vi.fn(() => {
        const spinner = {
            start: vi.fn(),
            succeed: vi.fn(),
            fail: vi.fn(),
            text: '',
        };
        spinnerInstances.push(spinner);
        return spinner;
    }),
}));

vi.mock('../../services/auth.service.js', () => ({
    authService: {
        isAuthenticated: vi.fn(),
        getCredentials: vi.fn(),
        login: vi.fn(),
        logout: vi.fn(),
    },
}));

vi.mock('@inquirer/prompts', () => ({
    input: vi.fn(),
    password: vi.fn(),
    confirm: vi.fn(),
}));

import * as prompts from '@inquirer/prompts';
import { authService } from '../../services/auth.service.js';
import { loginAction } from '../auth/login.js';
import { logoutAction } from '../auth/logout.js';
import { CliExitError } from '../../utils/cli-exit.js';

const mockAuthService = vi.mocked(authService);
const mockInput = vi.mocked(prompts.input);
const mockPassword = vi.mocked(prompts.password);
const mockConfirm = vi.mocked(prompts.confirm);

describe('auth login command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        spinnerInstances.length = 0;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('logs in with provided email/password without prompts', async () => {
        mockAuthService.isAuthenticated.mockResolvedValue(false);
        mockAuthService.login.mockResolvedValue(undefined);

        await loginAction({ email: 'test@example.com', password: 'secret123' });

        expect(mockInput).not.toHaveBeenCalled();
        expect(mockPassword).not.toHaveBeenCalled();
        expect(mockAuthService.login).toHaveBeenCalledWith(
            'test@example.com',
            'secret123',
        );
        expect(spinnerInstances[0]?.start).toHaveBeenCalled();
        expect(spinnerInstances[0]?.succeed).toHaveBeenCalled();
    });

    it('prompts for email/password if not provided', async () => {
        mockAuthService.isAuthenticated.mockResolvedValue(false);
        mockAuthService.login.mockResolvedValue(undefined);

        // Mock user input
        mockInput.mockResolvedValueOnce('interactive@example.com');
        mockPassword.mockResolvedValueOnce('interactivePass');

        await loginAction({});

        expect(mockInput).toHaveBeenCalled();
        expect(mockPassword).toHaveBeenCalled();
        expect(mockAuthService.login).toHaveBeenCalledWith(
            'interactive@example.com',
            'interactivePass',
        );
    });

    it('does not re-login when user cancels account switch', async () => {
        mockAuthService.isAuthenticated.mockResolvedValue(true);
        mockAuthService.getCredentials.mockResolvedValue({
            accessToken: 'token',
            refreshToken: 'refresh',
            expiresAt: Date.now() + 1000 * 60 * 60,
            user: { id: 'u1', email: 'old@example.com', orgs: [] },
        } as any);

        // User says "No" to re-login
        mockConfirm.mockResolvedValue(false);

        await loginAction({});

        expect(mockConfirm).toHaveBeenCalled();
        expect(mockAuthService.login).not.toHaveBeenCalled();
    });

    it('exits with code 1 when login fails', async () => {
        const errorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        mockAuthService.isAuthenticated.mockResolvedValue(false);
        mockAuthService.login.mockRejectedValue(new Error('bad credentials'));

        await expect(
            loginAction({ email: 'test@example.com', password: 'wrong' }),
        ).rejects.toMatchObject({
            name: 'CliExitError',
            exitCode: 1,
        } satisfies Partial<CliExitError>);
        expect(errorSpy).toHaveBeenCalled();
    });
});

describe('auth logout command', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        spinnerInstances.length = 0;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('prints not authenticated when there is no session', async () => {
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        mockAuthService.isAuthenticated.mockResolvedValue(false);

        await logoutAction();

        expect(mockAuthService.logout).not.toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledWith(
            expect.stringContaining('Not authenticated.'),
        );
    });

    it('logs out when authenticated', async () => {
        mockAuthService.isAuthenticated.mockResolvedValue(true);
        mockAuthService.logout.mockResolvedValue(undefined);

        await logoutAction();

        expect(mockAuthService.logout).toHaveBeenCalledTimes(1);
        expect(spinnerInstances[0]?.start).toHaveBeenCalled();
        expect(spinnerInstances[0]?.succeed).toHaveBeenCalled();
    });

    it('exits with code 1 when logout fails', async () => {
        const errorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        mockAuthService.isAuthenticated.mockResolvedValue(true);
        mockAuthService.logout.mockRejectedValue(new Error('network'));

        await expect(logoutAction()).rejects.toMatchObject({
            name: 'CliExitError',
            exitCode: 1,
        } satisfies Partial<CliExitError>);
        expect(errorSpy).toHaveBeenCalled();
    });
});
