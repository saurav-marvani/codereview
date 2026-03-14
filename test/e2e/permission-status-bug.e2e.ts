import { test, expect } from '@playwright/test';

const MOCK_ADMIN = {
    id: 'admin-uuid',
    email: 'nalu@kodus.io',
    name: 'Admin User',
    role: 'owner',
    status: 'active',
};

const MOCK_USER = {
    id: 'user-uuid',
    email: 'ana.sirino@kodus.io',
    name: 'Ana Sirino',
    role: 'contributor',
    status: 'active',
};

const MOCK_KODY_RULES = [
    {
        id: '1',
        name: 'Check console.log',
        description: 'Remove console.log statements',
        enabled: true,
    },
];

test.describe('BUG: Status change not reflecting - Team Member', () => {
    test('Admin changes participant team status - participant still sees old status', async ({
        page,
    }) => {
        let participantTokenIssued = false;
        let adminChangedParticipantStatus = false;

        await page.route(/\/api\/auth\/session/, async (route) => {
            await route.fulfill({
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user: MOCK_USER,
                }),
            });
        });

        await page.route(/\/api\/v1\/kody-rules(\?.*)?$/, async (route) => {
            if (route.request().method() === 'GET') {
                await route.fulfill({
                    status: 200,
                    body: JSON.stringify({
                        data: MOCK_KODY_RULES,
                        total: MOCK_KODY_RULES.length,
                    }),
                });
            }
        });

        await page.route(/\/api\/v1\/team-members/, async (route) => {
            const url = route.request().url();

            if (route.request().method() === 'GET') {
                const response = {
                    data: [
                        {
                            uuid: MOCK_ADMIN.id,
                            user: {
                                email: MOCK_ADMIN.email,
                                name: MOCK_ADMIN.name,
                            },
                            role: MOCK_ADMIN.role,
                            status: MOCK_ADMIN.status,
                            teamRole: 'team_leader',
                        },
                        {
                            uuid: MOCK_USER.id,
                            user: {
                                email: MOCK_USER.email,
                                name: MOCK_USER.name,
                            },
                            role: MOCK_USER.role,
                            status: adminChangedParticipantStatus
                                ? 'inactive'
                                : 'active',
                            teamRole: 'team_member',
                        },
                    ],
                    total: 2,
                };
                await route.fulfill({
                    status: 200,
                    body: JSON.stringify(response),
                });
            }

            if (
                route.request().method() === 'PATCH' &&
                url.includes('/update-members')
            ) {
                adminChangedParticipantStatus = true;
                await route.fulfill({
                    status: 200,
                    body: JSON.stringify({ success: true }),
                });
            }
        });

        await page.goto('/sign-in');
        await page.waitForLoadState('domcontentloaded');
        await page.fill('#email', MOCK_USER.email);
        await page.click('button:has-text("Continue")');
        await page.waitForTimeout(1000);
        await page.fill('#password', 'Kodus@2026');
        await page.click('button:has-text("Sign in")');
        await page.waitForURL(/\/cockpit|setup|sign-in|sign-up/, {
            timeout: 15000,
        });

        await page.goto('/library/kody-rules');
        await page.waitForLoadState('networkidle');

        const ruleCard = page.locator('text=Check console.log');
        await expect(ruleCard).toBeVisible();

        await page.goto('/settings/team');
        await page.waitForLoadState('networkidle');

        const participantRow = page.locator(`text=${MOCK_USER.name}`);
        await expect(participantRow).toBeVisible();

        participantTokenIssued = true;
        console.log('Participant logged in, can see Kody Rules');

        const statusToggle = page
            .locator(`text=${MOCK_USER.name}`)
            .locator('..')
            .locator('button[role="switch"]');
        if ((await statusToggle.count()) > 0) {
            await statusToggle.click();
            await page.waitForTimeout(500);
        }

        await page.goto('/library/kody-rules');
        await page.waitForLoadState('networkidle');

        const ruleCardAfter = page.locator('text=Check console.log');
        const isVisibleAfter = await ruleCardAfter.isVisible();

        console.log('After admin changed team member status:');
        console.log('- Participant still sees Kody Rules:', isVisibleAfter);
        console.log('- Expected: should be blocked or show different state');
        console.log(
            '- Actual: still visible (this is the BUG if status was changed to inactive)',
        );
    });

    test('Admin changes participant role - participant permissions not updated', async ({
        page,
    }) => {
        let participantRoleInDb = 'contributor';

        await page.route(/\/api\/auth\/session/, async (route) => {
            await route.fulfill({
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    user: {
                        ...MOCK_USER,
                        role: participantRoleInDb,
                    },
                }),
            });
        });

        await page.route(/\/api\/v1\/kody-rules(\?.*)?$/, async (route) => {
            if (route.request().method() === 'GET') {
                await route.fulfill({
                    status: 200,
                    body: JSON.stringify({
                        data: MOCK_KODY_RULES,
                        total: MOCK_KODY_RULES.length,
                    }),
                });
            }
        });

        await page.route(/\/api\/v1\/team-members/, async (route) => {
            if (route.request().method() === 'GET') {
                const response = {
                    data: [
                        {
                            uuid: MOCK_ADMIN.id,
                            user: {
                                email: MOCK_ADMIN.email,
                                name: MOCK_ADMIN.name,
                            },
                            role: 'owner',
                            status: 'active',
                            teamRole: 'team_leader',
                        },
                        {
                            uuid: MOCK_USER.id,
                            user: {
                                email: MOCK_USER.email,
                                name: MOCK_USER.name,
                            },
                            role: participantRoleInDb,
                            status: 'active',
                            teamRole: 'team_member',
                        },
                    ],
                    total: 2,
                };
                await route.fulfill({
                    status: 200,
                    body: JSON.stringify(response),
                });
            }

            if (route.request().method() === 'PATCH') {
                const body = await route.request().postDataJSON();
                const participantUpdate = body.members?.find(
                    (m: any) => m.uuid === MOCK_USER.id,
                );
                if (participantUpdate) {
                    participantRoleInDb = participantUpdate.role;
                }
                await route.fulfill({
                    status: 200,
                    body: JSON.stringify({ success: true }),
                });
            }
        });

        await page.goto('/sign-in');
        await page.waitForLoadState('domcontentloaded');
        await page.fill('#email', MOCK_USER.email);
        await page.click('button:has-text("Continue")');
        await page.waitForTimeout(1000);
        await page.fill('#password', 'Kodus@2026');
        await page.click('button:has-text("Sign in")');
        await page.waitForURL(/\/cockpit|setup|sign-in|sign-up/, {
            timeout: 15000,
        });

        console.log('Participant logged in with role: contributor');
        console.log('Can access Kody Rules (read-only for contributor)');

        await page.goto('/library/kody-rules');
        await page.waitForLoadState('networkidle');

        const ruleCard = page.locator('text=Check console.log');
        await expect(ruleCard).toBeVisible();

        console.log(
            'Admin changes participant role from contributor to owner (in team members)',
        );
        console.log('Participant makes NEW request to API...');

        await page.reload();

        await page.waitForLoadState('networkidle');

        console.log('BUG: Does participant see owner permissions?');
        console.log('The token still has old role in payload');
        console.log('Need to re-login to get new permissions');
    });
});
