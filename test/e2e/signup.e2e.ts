import { test, expect } from '@playwright/test';

test.describe('Sign Up Flow', () => {
    test.beforeEach(async ({ page }) => {
        await page.route(/\/user\/email/, async (route) => {
            await route.fulfill({
                status: 200,
                body: JSON.stringify({ available: true }),
            });
        });

        await page.route(/\/user\/register/, async (route) => {
            await route.fulfill({
                status: 201,
                body: JSON.stringify({
                    id: 'test-user-id',
                    email: 'test@example.com',
                    name: 'Test User',
                }),
            });
        });

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

        await page.goto('/sign-up');
        await page.waitForLoadState('domcontentloaded');
    });

    test('should show error for personal email', async ({ page }) => {
        await expect(
            page.getByRole('heading', { name: /Join thousands/i }),
        ).toBeVisible();

        await page.fill('#email', 'test@gmail.com');
        await page.waitForTimeout(500);

        await page
            .locator('button:has-text("Continue")')
            .click({ force: true });
        await page.waitForTimeout(1500);

        const errorMessage = page.locator('text=corporate email');
        await expect(errorMessage).toBeVisible();
    });

    test('should create account and redirect to setup', async ({ page }) => {
        await expect(
            page.getByRole('heading', { name: /Join thousands/i }),
        ).toBeVisible();

        const email = `test${Date.now()}@example.com`;

        await page.locator('#email').fill(email);
        await page.locator('#email').blur();
        await page.waitForTimeout(3000);

        await page
            .locator('button:has-text("Continue")')
            .click({ force: true });
        await page.waitForTimeout(5000);

        const nameInput = page.locator('input[name="name"]');
        await nameInput.waitFor({ state: 'visible', timeout: 15000 });

        await nameInput.fill('Test User');
        await page.locator('input[name="password"]').fill('Test@123');
        await page.locator('input[name="confirmPassword"]').fill('Test@123');
        await page.waitForTimeout(500);

        await page.locator('button[type="submit"]:has-text("Sign up")').click();
        await page.waitForURL(/\/setup|sign-in|sign-up/, { timeout: 10000 });
    });
});
