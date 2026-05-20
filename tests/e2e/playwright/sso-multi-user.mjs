// SSO multi-user E2E driver — Playwright × droplet.
//
// Validates the 4 SSO sub-flows that customers exercise daily:
//
//   1. Admin can open /organization/sso, see the seeded config, and
//      interact with the form (UI smoke — activation gating ceremony
//      tested at the unit layer).
//   2. Sign-in page recognises an SSO domain and offers
//      "Continue with SSO".
//   3. A Keycloak user that does NOT exist in the Kodus DB completes
//      SSO and lands on /confirm-email (the auto-signup path that
//      creates a status=pending Kodus user).
//   4. A Kodus user with status=removed is rejected at the SAML
//      callback and bounced to /sign-in?reason=removed.
//
// Requires sso_config.active=true on the droplet — the companion
// bootstrap-multi-user.sh flips it via SQL (the create-or-update API
// gate requires a successful /sso-config/test session + verified
// domains, both of which have their own unit coverage and are not
// the subject under test here).
//
// Required env:
//   SSO_E2E_API_URL       https://api.<IP>.sslip.io
//   SSO_E2E_APP_URL       https://app.<IP>.sslip.io
//   SSO_E2E_BASE          <IP>.sslip.io
//   SSO_E2E_ORG_ID        org uuid from provision.sh
//   SSO_E2E_ADMIN_EMAIL   (default: sso-user@kodus-test.com)
//   SSO_E2E_ADMIN_PASSWORD (default: TestSso!2026)
//   SSO_E2E_NEWBIE_EMAIL  (default: newbie-sso@kodus-test.com)
//   SSO_E2E_REMOVED_EMAIL (default: removed-sso@kodus-test.com)
//   SSO_E2E_USER_PASSWORD (default: TestSso!2026, shared by IdP users)
//   SSO_E2E_IGNORE_TLS=1  when Caddy fell back to its internal CA
//   SSO_E2E_HEADLESS=0    for a visible Chromium window
//
// Exits 0 only when ALL 4 sub-flows pass. Prints
// `[sso-multi-user] PASS sub-flow-N: …` per success or
// `[sso-multi-user] FAIL sub-flow-N: …` on the first failure.

import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const {
    SSO_E2E_API_URL,
    SSO_E2E_APP_URL,
    SSO_E2E_BASE,
    SSO_E2E_ORG_ID,
    SSO_E2E_ADMIN_EMAIL = "sso-user@kodus-test.com",
    SSO_E2E_ADMIN_PASSWORD = "TestSso!2026",
    SSO_E2E_NEWBIE_EMAIL = "newbie-sso@kodus-test.com",
    SSO_E2E_REMOVED_EMAIL = "removed-sso@kodus-test.com",
    SSO_E2E_USER_PASSWORD = "TestSso!2026",
    SSO_E2E_IGNORE_TLS,
    SSO_E2E_HEADLESS = "1",
} = process.env;

for (const [k, v] of Object.entries({
    SSO_E2E_API_URL,
    SSO_E2E_APP_URL,
    SSO_E2E_BASE,
    SSO_E2E_ORG_ID,
})) {
    if (!v) {
        console.error(`error: env ${k} is required`);
        process.exit(2);
    }
}

const ignoreTls = SSO_E2E_IGNORE_TLS === "1";
const headless = SSO_E2E_HEADLESS !== "0";

const log = (...a) => console.log("[sso-multi-user]", ...a);
const pass = (sub, msg) => console.log(`[sso-multi-user] PASS sub-flow-${sub}: ${msg}`);
const fail = (sub, msg, extra) => {
    console.error(`[sso-multi-user] FAIL sub-flow-${sub}: ${msg}`);
    if (extra) console.error(extra);
    process.exit(1);
};

const browser = await chromium.launch({
    headless,
    args: ignoreTls ? ["--ignore-certificate-errors"] : [],
});

// Each sub-flow uses a fresh context so cookies/state don't leak.
async function freshContext() {
    return browser.newContext({ ignoreHTTPSErrors: ignoreTls });
}

// `fetch` against the public API with a bearer token. Used for admin
// actions (PATCH /user/:id) and lookups (GET /team-members).
async function apiCall(token, path, init = {}) {
    const url = `${SSO_E2E_API_URL}${path}`;
    const resp = await fetch(url, {
        ...init,
        headers: {
            ...(init.headers || {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            "Content-Type": "application/json",
        },
        // Node 22 fetch honours NODE_EXTRA_CA_CERTS; with LE-issued
        // certs we don't need to bypass. If the wrapper sets
        // SSO_E2E_IGNORE_TLS=1 the orchestrator script also sets
        // NODE_TLS_REJECT_UNAUTHORIZED=0 before invoking node.
    });
    const text = await resp.text();
    let body;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        body = text;
    }
    return { status: resp.status, body };
}

async function loginAsAdminViaApi() {
    const resp = await apiCall(null, "/auth/login", {
        method: "POST",
        body: JSON.stringify({
            email: SSO_E2E_ADMIN_EMAIL,
            password: SSO_E2E_ADMIN_PASSWORD,
        }),
    });
    if (resp.status !== 200 && resp.status !== 201) {
        throw new Error(`admin login failed: HTTP ${resp.status} ${JSON.stringify(resp.body).slice(0, 200)}`);
    }
    const token = resp.body?.accessToken || resp.body?.data?.accessToken;
    if (!token) throw new Error(`admin login: no accessToken in response`);
    // teamId is needed for /team-members?teamId=. Pull it from the JWT.
    const payload = JSON.parse(
        Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
    );
    return { token, teamId: payload.teamId, organizationId: payload.organizationId, userId: payload.uuid || payload.id };
}

async function findUserUuidByEmail(token, teamId, email) {
    const resp = await apiCall(token, `/team-members?teamId=${encodeURIComponent(teamId)}`);
    if (resp.status !== 200) {
        throw new Error(`GET /team-members HTTP ${resp.status} body=${JSON.stringify(resp.body).slice(0, 200)}`);
    }
    // Response shape varies: { data: [{ user: { uuid, email } }] } or flat array.
    const members =
        (Array.isArray(resp.body) && resp.body) ||
        resp.body?.data ||
        resp.body?.members ||
        resp.body?.teamMembers ||
        [];
    const match = members.find((m) => {
        const e = m?.email || m?.user?.email || m?.userEmail;
        return e && e.toLowerCase() === email.toLowerCase();
    });
    return (
        match?.user?.uuid ||
        match?.userId ||
        match?.uuid ||
        match?.user_uuid ||
        null
    );
}

// -------- sub-flow #1: admin opens /organization/sso (via SSO login) --------
async function subFlow1() {
    log("sub-flow-1: admin signs in via SSO then opens /organization/sso");
    const ctx = await freshContext();
    const page = await ctx.newPage();
    try {
        // With sso_config.active=true, the sign-in form forces SSO
        // even for the admin's own domain — so we drive the SAML
        // round-trip for the admin too. The admin row already exists
        // in Kodus (created by bootstrap-kodus-sso.sh), so the
        // callback just mints a session.
        const landedUrl = await ssoRoundTrip(page, SSO_E2E_ADMIN_EMAIL);
        if (landedUrl.includes("/sign-in") || landedUrl.includes("/confirm-email")) {
            throw new Error(`admin SSO login bounced to ${landedUrl} — expected authenticated landing`);
        }

        await page.goto(`${SSO_E2E_APP_URL}/organization/sso`, { waitUntil: "domcontentloaded" });

        // The SSO Settings page header is the canonical signal. Loose
        // matcher because UI copy may evolve.
        const title = await page.locator("text=/SSO Settings|SAML SSO Configuration/i").first();
        await title.waitFor({ timeout: 20_000 });

        // Enable switch should exist (regardless of state — we just
        // need to confirm the form renders).
        const enableSwitch = page.locator('#enable-sso, [aria-label*="Enable" i]').first();
        await enableSwitch.waitFor({ timeout: 5_000 });

        // Test connection button is the gating CTA — its presence
        // proves the form is interactive.
        const testButton = page.locator('button:has-text("Test connection")').first();
        await testButton.waitFor({ timeout: 5_000 });

        pass("1", `admin /organization/sso renders, switch + Test connection present`);
    } catch (err) {
        await dumpDiagnostics(page, "sub-flow-1");
        fail("1", `admin /organization/sso did not render as expected: ${err.message}`);
    } finally {
        await ctx.close();
    }
}

// -------- sub-flow #2: /sign-in shows "Continue with SSO" --------
async function subFlow2() {
    log("sub-flow-2: sign-in shows 'Continue with SSO' for the seeded domain");
    const ctx = await freshContext();
    const page = await ctx.newPage();
    try {
        await page.goto(`${SSO_E2E_APP_URL}/sign-in`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 20_000 });
        await page.fill('input[type="email"], input[name="email"]', SSO_E2E_ADMIN_EMAIL);
        await page.click('button[type="submit"]');

        // After the email step the form fires ssoCheck. If active=true
        // and the domain matches, step → "sso-choice" and the SSO
        // button appears.
        const ssoButton = page.locator('button:has-text("Continue with SSO")').first();
        await ssoButton.waitFor({ timeout: 15_000 });

        pass("2", `'Continue with SSO' offered for ${SSO_E2E_ADMIN_EMAIL}`);
    } catch (err) {
        await dumpDiagnostics(page, "sub-flow-2");
        fail("2", `'Continue with SSO' did not appear: ${err.message}`);
    } finally {
        await ctx.close();
    }
}

// Drive a full SSO login round-trip in `page` for `email`. Returns the
// final URL. Re-usable by sub-flow #3 (newbie) and #4 (removed user).
async function ssoRoundTrip(page, email) {
    await page.goto(`${SSO_E2E_APP_URL}/sign-in`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 20_000 });
    await page.fill('input[type="email"], input[name="email"]', email);
    await page.click('button[type="submit"]');

    await page.locator('button:has-text("Continue with SSO")').first().waitFor({ timeout: 15_000 });
    await page.click('button:has-text("Continue with SSO")');

    // Now on Keycloak. Fill creds and submit.
    await page.waitForSelector('input[name="username"]', { timeout: 30_000 });
    await page.fill('input[name="username"]', email);
    await page.fill('input[name="password"]', SSO_E2E_USER_PASSWORD);

    // Wait for any post-Keycloak URL — final landing is on the app
    // origin and is NOT the intermediate /sso-callback hop.
    await Promise.all([
        page.waitForURL(
            (u) => {
                const s = u.toString();
                return (
                    s.startsWith(`${SSO_E2E_APP_URL}/`) &&
                    !s.includes("/sso-callback")
                );
            },
            { timeout: 60_000 },
        ),
        page.click('button[type="submit"], input[type="submit"]'),
    ]);
    return page.url();
}

// -------- sub-flow #3: new user signup via SSO --------
async function subFlow3() {
    log(`sub-flow-3: newbie ${SSO_E2E_NEWBIE_EMAIL} signs up via SSO`);
    const ctx = await freshContext();
    const page = await ctx.newPage();
    try {
        const finalUrl = await ssoRoundTrip(page, SSO_E2E_NEWBIE_EMAIL);

        // The auto-signup path lands on /confirm-email (the front-end
        // route for status=pending users). Anything else is a
        // regression.
        if (!finalUrl.includes("/confirm-email")) {
            throw new Error(`expected /confirm-email landing, got ${finalUrl}`);
        }
        pass("3", `new SSO user landed on ${new URL(finalUrl).pathname}`);
    } catch (err) {
        await dumpDiagnostics(page, "sub-flow-3");
        fail("3", `new user signup via SSO did not reach /confirm-email: ${err.message}`);
    } finally {
        await ctx.close();
    }
}

// -------- sub-flow #4: removed user is rejected --------
async function subFlow4() {
    log(`sub-flow-4: removed user ${SSO_E2E_REMOVED_EMAIL} is rejected`);
    // Step A: ensure removed-sso has a Kodus DB row. The cheapest
    // way is to run them through the SSO signup once (same as #3).
    // After that the user exists with status=pending — close enough
    // for the admin to flip to status=removed.
    const setupCtx = await freshContext();
    const setupPage = await setupCtx.newPage();
    try {
        await ssoRoundTrip(setupPage, SSO_E2E_REMOVED_EMAIL);
    } catch (err) {
        await setupCtx.close();
        fail("4", `seed: SSO round-trip for removed user failed: ${err.message}`);
    }
    await setupCtx.close();

    // Step B: admin PATCH /user/:id with status=removed.
    let token, teamId;
    try {
        ({ token, teamId } = await loginAsAdminViaApi());
    } catch (err) {
        fail("4", `admin API login for PATCH failed: ${err.message}`);
    }
    let targetUuid;
    try {
        targetUuid = await findUserUuidByEmail(token, teamId, SSO_E2E_REMOVED_EMAIL);
    } catch (err) {
        fail("4", `lookup removed-user uuid failed: ${err.message}`);
    }
    if (!targetUuid) {
        fail("4", `removed-user ${SSO_E2E_REMOVED_EMAIL} not present in /team-members — auto-signup did not create the row?`);
    }
    const patchResp = await apiCall(token, `/user/${targetUuid}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "removed" }),
    });
    if (patchResp.status !== 200 && patchResp.status !== 204) {
        fail("4", `PATCH /user/${targetUuid} status=removed returned HTTP ${patchResp.status}`, JSON.stringify(patchResp.body).slice(0, 200));
    }
    log(`marked ${SSO_E2E_REMOVED_EMAIL} as status=removed`);

    // Step C: fresh SSO login attempt should bounce to
    // /sign-in?reason=removed (or include "removed" somewhere in
    // the URL — the app may use different query keys).
    const ctx = await freshContext();
    const page = await ctx.newPage();
    try {
        const finalUrl = await ssoRoundTrip(page, SSO_E2E_REMOVED_EMAIL);
        const url = finalUrl.toLowerCase();
        const rejected =
            url.includes("removed") ||
            url.includes("inactive") ||
            url.includes("blocked");
        if (!rejected) {
            throw new Error(`expected /sign-in?reason=removed (or similar), got ${finalUrl}`);
        }
        pass("4", `removed user bounced to ${new URL(finalUrl).pathname}${new URL(finalUrl).search}`);
    } catch (err) {
        await dumpDiagnostics(page, "sub-flow-4");
        fail("4", `removed user not rejected: ${err.message}`);
    } finally {
        await ctx.close();
    }
}

async function dumpDiagnostics(page, label) {
    try {
        const ts = Date.now();
        const png = `failure-${label}-${ts}.png`;
        await page.screenshot({ path: png, fullPage: true });
        const html = `failure-${label}-${ts}.html`;
        writeFileSync(html, await page.content());
        console.error(`[sso-multi-user] saved diagnostics: ${png}, ${html} (URL=${page.url()})`);
    } catch {
        /* best-effort */
    }
}

try {
    await subFlow1();
    await subFlow2();
    await subFlow3();
    await subFlow4();
    log("ALL sub-flows passed");
} finally {
    await browser.close();
}
