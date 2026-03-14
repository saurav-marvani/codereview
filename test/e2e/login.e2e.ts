import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
    test.beforeEach(async ({ page }) => {
        await page.route(
            /\/api\/auth\/callback\/credentials/,
            async (route) => {
                await route.fulfill({
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ url: '/setup' }),
                });
            },
        );

        await page.goto('/sign-in');
        await page.waitForLoadState('domcontentloaded');
    });

    test('should to load page login', async ({ page }) => {
        await expect(page.locator('#email')).toBeVisible();
        await expect(
            page.getByRole('button', { name: 'Continue' }),
        ).toBeVisible();
    });

    test('should order password after valid email', async ({ page }) => {
        await page.fill('#email', 'ana.sirino@kodus.io');
        await page.click('button:has-text("Continue")');

        await expect(page.locator('#password')).toBeVisible();
        await expect(
            page.getByRole('button', { name: 'Sign in', exact: true }),
        ).toBeVisible();
    });

    test('should show options of login with github', async ({ page }) => {
        await expect(
            page.getByRole('button', { name: 'Sign in with Github' }),
        ).toBeVisible();
    });

    test('should login and redirect to setup', async ({ page }) => {
        await page.fill('#email', 'ana.sirino@kodus.io');
        await page.click('button:has-text("Continue")');

        await expect(page.locator('#password')).toBeVisible();

        await page.fill('#password', 'Kodus@2026');
        await page.click('button:has-text("Sign in")');

        await page.waitForURL(/\/setup|sign-in|sign-up/, { timeout: 10000 });
    });
});
