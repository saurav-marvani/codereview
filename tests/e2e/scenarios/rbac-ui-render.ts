import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { RBAC_PASSWORD, setupRbacOrg } from "../lib/rbac-provision.js";
import type { RunContext, Scenario } from "../lib/types.js";

// ---------------------------------------------------------------------------
// RBAC frontend RENDER evidence (real browser).
//
// The route-guard e2e (rbac-frontend-routes) proves the middleware's
// authorization (200 vs /forbidden). This proves the UI actually RENDERS: it
// drives a real Chromium per role (auth injected from a next-auth session
// minted over HTTP — no brittle form) and asserts on the rendered DOM that the
// "Token Usage" menu item shows only for allowed roles and the /token-usage
// screen renders for them while denied roles get a rendered /forbidden page.
// Records a video + screenshots per role into the run's artifact dir.
//
// Browser work lives in playwright/rbac-ui-render.mjs (run from the playwright
// workspace where `playwright` is installed); this scenario provisions the role
// users and spawns it. Menu-item assertions are skipped (logged) if the radix
// dropdown won't open in headless — the route-render assertion is the hard gate.
// ---------------------------------------------------------------------------

const PLAYWRIGHT_DIR = resolve(import.meta.dirname, "..", "playwright");
const SPEC = resolve(PLAYWRIGHT_DIR, "rbac-ui-render.mjs");

export const rbacUiRender: Scenario = {
    id: "rbac-ui-render",
    title: "RBAC: the web renders the right menu + screen vs /forbidden per role",
    priority: "P0",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        provider: ["github"],
        license: ["trial", "paid", "license-paid"],
    },
    // 4 roles × (menu check + 5 route renders) in a real browser.
    timeoutSec: 900,
    async run(ctx: RunContext) {
        ctx.assert(existsSync(SPEC), `Playwright spec not found at ${SPEC}`);

        const { sessions } = await setupRbacOrg(ctx);
        const roles = sessions.map((s) => ({ role: s.role, email: s.email }));

        const code = await new Promise<number>((done) => {
            const child = spawn("node", ["rbac-ui-render.mjs"], {
                cwd: PLAYWRIGHT_DIR,
                env: {
                    ...process.env,
                    WEB_URL: ctx.target.webBaseUrl,
                    PASSWORD: RBAC_PASSWORD,
                    ROLES_JSON: JSON.stringify(roles),
                    OUT_DIR: ctx.artifactDir,
                },
                stdio: ["ignore", "inherit", "inherit"],
            });
            child.on("close", (c) => done(c ?? -1));
        });

        ctx.assert(
            code === 0,
            `rbac-ui-render Playwright spec failed (exit ${code}) — see logs + ${ctx.artifactDir}`,
        );
        return { evidenceDir: ctx.artifactDir, roles: roles.length };
    },
};

export default rbacUiRender;
