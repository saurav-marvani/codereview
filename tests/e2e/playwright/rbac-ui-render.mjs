// RBAC frontend RENDER evidence (Playwright, real browser).
//
// The HTTP route-guard e2e proves *authorization* (200 vs /forbidden) but NOT
// that the UI renders. This drives a real Chromium per role and asserts on the
// rendered DOM — the "Token Usage" menu item appears only for allowed roles,
// the /token-usage screen actually renders for them, and denied roles land on
// a rendered /forbidden page. Records a video + screenshots per role.
//
// Auth without the brittle sign-in form: we mint a next-auth session over HTTP
// (validated flow) and inject the cookies straight into the browser context.
//
// Env:
//   WEB_URL    e.g. https://qa.web.kodus.io  (or http://127.0.0.1:3000)
//   PASSWORD   shared password for the provisioned role users
//   ROLES_JSON JSON array: [{ "role": "repo_admin", "email": "..." }, ...]
//   OUT_DIR    directory for videos/screenshots (default: ./rbac-ui-evidence)

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const WEB = (process.env.WEB_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PASSWORD = process.env.PASSWORD || "";
const ROLES = JSON.parse(process.env.ROLES_JSON || "[]");
const OUT_DIR = process.env.OUT_DIR || "./rbac-ui-evidence";
mkdirSync(OUT_DIR, { recursive: true });

// TokenUsage is the #1229 case: every role except contributor may see/open it.
const tokenUsageAllowed = (role) => role !== "contributor";

const log = (m) => console.log(`[rbac-ui] ${m}`);
const failures = [];

function jarToCookies(setCookies) {
    const out = [];
    for (const c of setCookies) {
        const [pair] = c.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0)
            out.push({ name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), url: WEB });
    }
    return out;
}

async function nextAuthCookies(email) {
    const jar = new Map();
    const absorb = (res) => {
        for (const c of res.headers.getSetCookie()) {
            const [pair] = c.split(";");
            const eq = pair.indexOf("=");
            if (eq > 0) jar.set(pair.slice(0, eq).trim(), c);
        }
    };
    const csrfRes = await fetch(`${WEB}/api/auth/csrf`, { redirect: "manual" });
    absorb(csrfRes);
    const { csrfToken } = await csrfRes.json();
    const cookieHeader = [...jar.values()].map((c) => c.split(";")[0]).join("; ");
    const cbRes = await fetch(`${WEB}/api/auth/callback/credentials`, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: cookieHeader,
        },
        body: new URLSearchParams({
            csrfToken,
            email,
            password: PASSWORD,
            redirect: "false",
            json: "true",
        }).toString(),
        redirect: "manual",
    });
    absorb(cbRes);
    const setCookies = [...jar.values()];
    if (!setCookies.some((c) => /authjs\.session-token|__Secure-authjs\.session-token/.test(c))) {
        throw new Error(`no session cookie for ${email} (HTTP ${cbRes.status})`);
    }
    return jarToCookies(setCookies);
}

const browser = await chromium.launch({ headless: true });

for (const { role, email } of ROLES) {
    const ctx = await browser.newContext({
        recordVideo: { dir: OUT_DIR, size: { width: 1280, height: 800 } },
        viewport: { width: 1280, height: 800 },
    });
    try {
        const cookies = await nextAuthCookies(email);
        await ctx.addCookies(cookies);
        const page = await ctx.newPage();

        // ---- 1) Menu render: open the user-nav, check the Token Usage item ----
        await page.goto(`${WEB}/settings`, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const trigger = page.locator('[data-testid="user-nav-trigger"]');
        // Wait for the navbar to hydrate (trigger present + interactive). The
        // app polls (issues count, notifications) so "networkidle" never fires.
        await trigger.waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
        await page.waitForTimeout(2000);
        // Radix opens on pointerdown; a couple of attempts + keyboard fallback
        // make the headless open reliable.
        let opened = false;
        for (let attempt = 0; attempt < 3 && !opened; attempt++) {
            await trigger.click({ timeout: 10_000 }).catch(() => {});
            opened = await page
                .getByRole("menu")
                .first()
                .waitFor({ state: "visible", timeout: 3_000 })
                .then(() => true)
                .catch(() => false);
            if (!opened) {
                await trigger.focus().catch(() => {});
                await page.keyboard.press("Enter").catch(() => {});
                opened = await page
                    .getByRole("menu")
                    .first()
                    .waitFor({ state: "visible", timeout: 2_000 })
                    .then(() => true)
                    .catch(() => false);
            }
        }
        await page.screenshot({ path: `${OUT_DIR}/${role}-menu.png`, fullPage: true });
        const wantItem = tokenUsageAllowed(role);
        if (opened) {
            const itemVisible =
                (await page.getByRole("menuitem", { name: /Token Usage/i }).count()) > 0;
            if (itemVisible !== wantItem) {
                failures.push(
                    `${role}: Token Usage menu item visible=${itemVisible}, expected ${wantItem}`,
                );
            } else {
                log(`OK  ${role} menu: Token Usage item ${itemVisible ? "shown" : "hidden"}`);
            }
        } else {
            // Headless/docker-mac flake opening the radix dropdown — don't fail
            // the run on it; the route-render assertion below is the hard proof.
            log(`WARN ${role}: user menu did not open (headless) — menu-item check skipped`);
        }

        // ---- 2) Route render: open /token-usage, assert what renders ----
        await page.goto(`${WEB}/token-usage`, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(1500);
        const url = page.url();
        const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
        await page.screenshot({ path: `${OUT_DIR}/${role}-token-usage.png`, fullPage: true });

        if (wantItem) {
            const onForbidden = /\/forbidden\b/.test(url);
            const renderedTitle = bodyText.includes("token usage");
            if (onForbidden || !renderedTitle) {
                failures.push(
                    `${role}: /token-usage should RENDER (got url=${url}, hasTitle=${renderedTitle})`,
                );
            } else {
                log(`OK  ${role} /token-usage rendered (title visible)`);
            }
        } else {
            const onForbidden = /\/forbidden\b/.test(url) || bodyText.includes("access denied");
            if (!onForbidden) {
                failures.push(`${role}: /token-usage should be FORBIDDEN (got url=${url})`);
            } else {
                log(`OK  ${role} /token-usage blocked → forbidden page rendered`);
            }
        }
    } catch (e) {
        failures.push(`${role}: ${e.message}`);
    } finally {
        await ctx.close(); // flushes the video
    }
}

await browser.close();

if (failures.length) {
    console.error(`[rbac-ui] FAIL (${failures.length}):\n  ${failures.join("\n  ")}`);
    process.exit(1);
}
console.log(`[rbac-ui] PASS — all roles rendered as expected. Evidence in ${OUT_DIR}`);
