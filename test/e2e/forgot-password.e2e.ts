import { test, expect } from '@playwright/test';

test.describe('Forgot Password', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/forgot-password');
        await page.waitForLoadState('domcontentloaded');
    });

    test('should load forgot password page', async ({ page }) => {
        await expect(
            page.getByRole('button', { name: /Reset Password/i }),
        ).toBeVisible();
        await expect(
            page.getByRole('link', { name: /Back to Log in/i }),
        ).toBeVisible();
    });

    test('should navigate back to sign in', async ({ page }) => {
        await page.click('text=Back to Log in');
        await page.waitForURL(/\/sign-in/);
    });
});

test.describe('Confirm Email', () => {
    test.skip('requires authentication state', async ({ page }) => {
        await page.goto('/confirm-email');
        await page.waitForLoadState('domcontentloaded');
    });
});

test.describe('Invite', () => {
    test.skip('requires valid invite token', async ({ page }) => {
        await page.goto('/invite/test-invite-id');
        await page.waitForLoadState('domcontentloaded');
    });
});
