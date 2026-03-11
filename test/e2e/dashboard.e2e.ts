import { test, expect } from '@playwright/test';

test.describe.skip('Dashboard (requires API)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/cockpit');
        await page.waitForLoadState('domcontentloaded');
    });

    test('should load dashboard', async ({ page }) => {
        await expect(page).toHaveURL(/\/cockpit/);
    });

    test('should display cockpit dashboard', async ({ page }) => {
        await expect(
            page.getByRole('heading', { name: /Dashboard/i }),
        ).toBeVisible();
    });
});
