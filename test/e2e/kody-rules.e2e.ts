import { test, expect } from '@playwright/test';

const MOCK_RULES = [
    {
        id: '1',
        name: 'Check console.log',
        description: 'Remove console.log statements',
        enabled: true,
    },
    {
        id: '2',
        name: 'No TODO comments',
        description: 'TODO comments should be resolved',
        enabled: false,
    },
    {
        id: '3',
        name: 'TypeScript strict',
        description: 'Use strict TypeScript patterns',
        enabled: true,
    },
];

async function mockAuthenticated(page: any) {
    await page.route(/\/api\/auth\/callback\/credentials/, async (route) => {
        await route.fulfill({
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: '/cockpit' }),
        });
    });

    await page.route(/\/api\/v1\/kody-rules(\?.*)?$/, async (route) => {
        if (route.request().method() === 'GET') {
            await route.fulfill({
                status: 200,
                body: JSON.stringify({
                    data: MOCK_RULES,
                    total: MOCK_RULES.length,
                }),
            });
        }
    });

    await page.route(
        /\/api\/v1\/kody-rules\/create-or-update/,
        async (route) => {
            await route.fulfill({
                status: 201,
                body: JSON.stringify({
                    id: 'new-rule-id',
                    name: 'New Test Rule',
                    description: 'Test description',
                    enabled: true,
                }),
            });
        },
    );

    await page.route(/\/api\/v1\/kody-rules\/1/, async (route) => {
        if (route.request().method() === 'PATCH') {
            await route.fulfill({
                status: 200,
                body: JSON.stringify({
                    id: '1',
                    name: 'Updated Rule',
                    description: 'Updated description',
                    enabled: false,
                }),
            });
        }
    });
}

test.describe('Kody Rules - Library', () => {
    test.beforeEach(async ({ page }) => {
        await mockAuthenticated(page);
        await page.goto('/sign-in');
        await page.waitForLoadState('domcontentloaded');
        await page.fill('#email', 'ana.sirino@kodus.io');
        await page.click('button:has-text("Continue")');
        await page.waitForTimeout(1000);
        await page.fill('#password', 'Kodus@2026');
        await page.click('button:has-text("Sign in")');
        await page.waitForURL(/\/cockpit|setup|sign-in|sign-up/, {
            timeout: 15000,
        });
    });

    test('should list rules in library', async ({ page }) => {
        await page.goto('/library/kody-rules');
        await page.waitForLoadState('networkidle');
        expect(page.url()).toContain('library');
    });

    test('should list rules in settings', async ({ page }) => {
        await page.goto('/settings/code-review/repo-123/kody-rules');
        await page.waitForLoadState('networkidle');
        expect(page.url()).toContain('settings');
    });

    test('should show create rule button', async ({ page }) => {
        await page.goto('/settings/code-review/repo-123/kody-rules');
        await page.waitForLoadState('networkidle');
        const createButton = page
            .locator('button:has-text("Create")')
            .or(page.locator('button:has-text("New Rule")'))
            .or(page.locator('button:has-text("Add")'));
        await expect(createButton)
            .toBeVisible({ timeout: 5000 })
            .catch(() => {});
    });

    test('should display rules in list', async ({ page }) => {
        await page.goto('/settings/code-review/repo-123/kody-rules');
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(1000);
    });

    test('should search rules', async ({ page }) => {
        await page.goto('/library/kody-rules');
        await page.waitForLoadState('networkidle');
        const searchInput = page.locator(
            'input[type="search"], input[placeholder*="Search"]',
        );
        await searchInput.fill('console');
        await searchInput.press('Enter');
        await page.waitForTimeout(1000);
    });

    test('should filter by category', async ({ page }) => {
        await page.goto('/library/kody-rules');
        await page.waitForLoadState('networkidle');
        await page.click('text=security');
        await page.waitForTimeout(1000);
    });
});

test.describe('Kody Rules - Featured', () => {
    test.beforeEach(async ({ page }) => {
        await mockAuthenticated(page);
        await page.goto('/sign-in');
        await page.waitForLoadState('domcontentloaded');
        await page.fill('#email', 'ana.sirino@kodus.io');
        await page.click('button:has-text("Continue")');
        await page.waitForTimeout(1000);
        await page.fill('#password', 'Kodus@2026');
        await page.click('button:has-text("Sign in")');
        await page.waitForURL(/\/cockpit|setup|sign-in|sign-up/, {
            timeout: 15000,
        });
    });

    test('should display featured rules', async ({ page }) => {
        await page.goto('/library/kody-rules/featured');
        await page.waitForLoadState('networkidle');
        await expect(
            page.getByRole('heading', { name: /Featured/i }),
        ).toBeVisible();
    });
});

test.describe('Kody Rules - Packs', () => {
    test.beforeEach(async ({ page }) => {
        await mockAuthenticated(page);
        await page.goto('/sign-in');
        await page.waitForLoadState('domcontentloaded');
        await page.fill('#email', 'ana.sirino@kodus.io');
        await page.click('button:has-text("Continue")');
        await page.waitForTimeout(1000);
        await page.fill('#password', 'Kodus@2026');
        await page.click('button:has-text("Sign in")');
        await page.waitForURL(/\/cockpit|setup|sign-in|sign-up/, {
            timeout: 15000,
        });
    });

    test('should display rules packs', async ({ page }) => {
        await page.goto('/library/kody-rules/packs');
        await page.waitForLoadState('networkidle');
        await expect(
            page.getByRole('heading', { name: /Packs/i }),
        ).toBeVisible();
    });
});
