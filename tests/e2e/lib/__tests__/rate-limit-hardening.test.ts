import { strict as assert } from "node:assert";
import { test } from "node:test";
import { registerIntegration } from "../onboarding.js";
import { isGithubRateLimit } from "../runner.js";
import { GitHubProvider } from "../../providers/github.js";
import type { KodusSession, Provider, TargetContext } from "../types.js";
import { json, startMockServer } from "./mock-server.js";

// Minimal Provider stand-in for onboarding-layer tests: registerIntegration
// only touches integrationType/authMode/authToken/authExtraFields.
function fakeProvider(): Provider {
    return {
        name: "github",
        integrationType: "GITHUB",
        authMode: () => "token",
        authToken: () => "fake-token",
    } as unknown as Provider;
}

function sessionFor(orgId: string): KodusSession {
    return {
        accessToken: "fake-jwt",
        organizationId: orgId,
        teamId: `team-${orgId}`,
    };
}

test("registerIntegration: caches per (api, org, platform) — one auth-integration POST per tenant per run", async () => {
    const server = await startMockServer([
        {
            method: "POST",
            pathRegex: /^\/code-management\/auth-integration$/,
            handler: (_req, res) => json(res, 200, { data: { status: "SUCCESS" } }),
        },
    ]);
    const target: TargetContext = {
        target: "self-hosted",
        apiBaseUrl: server.baseUrl,
        webBaseUrl: server.baseUrl,
        tunnelUrl: server.baseUrl,
    };
    try {
        const provider = fakeProvider();
        // Two scenarios on the SAME tenant → the second must reuse the
        // first registration instead of re-validating the token against
        // the provider (the Bitbucket-throttle trigger on run 28888685303).
        await registerIntegration(target, provider, sessionFor("org-cache-a"));
        await registerIntegration(target, provider, sessionFor("org-cache-a"));
        const posts = server.requests.filter(
            (r) => r.method === "POST" && r.path.startsWith("/code-management/auth-integration"),
        );
        assert.equal(posts.length, 1, "same tenant should register exactly once per run");

        // A DIFFERENT org (e.g. centralized-config-sync's throwaway tenant)
        // has its own cache slot and must still hit the real endpoint.
        await registerIntegration(target, provider, sessionFor("org-cache-b"));
        const postsAfter = server.requests.filter(
            (r) => r.method === "POST" && r.path.startsWith("/code-management/auth-integration"),
        );
        assert.equal(postsAfter.length, 2, "a different org must not reuse the cache");
    } finally {
        await server.close();
    }
});

test("pollForReview: GitHub rate-limit envelope surfaces as an explicit rate-limit error (not 'items is not iterable')", async () => {
    // GitHub answers list endpoints with an error ENVELOPE (an object,
    // not an array) when the per-account quota is exhausted. Before the
    // listOrThrow guard, filterNonTrigger iterated that object and the
    // scenario FAILED with an opaque "items is not iterable" the runner
    // couldn't classify — gating release run 28888685303 red. It must
    // instead throw a message isGithubRateLimit() recognizes, so the
    // runner marks the cell as a loud non-gating SKIP.
    const ghServer = await startMockServer([
        {
            method: "GET",
            pathRegex: /^\/repos\/[^/]+\/[^/]+\/(pulls|issues)\/\d+\/(comments|reviews)/,
            handler: (_req, res) =>
                json(res, 403, {
                    message:
                        "API rate limit exceeded for user ID 12345. If you reach out to GitHub Support...",
                    documentation_url:
                        "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api",
                }),
        },
    ]);
    const originalEnv = { ...process.env };
    const originalFetch = global.fetch;
    process.env.GH_TEST_TOKEN = "fake";
    process.env.GH_TEST_REPO = "kodustech/qa-fixture";
    // The provider hardcodes api.github.com — redirect to the mock.
    global.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input.toString();
        return originalFetch(
            url.replace("https://api.github.com", ghServer.baseUrl),
            init,
        );
    };
    try {
        const provider = new GitHubProvider({ target: "self-hosted" });
        await assert.rejects(
            provider.pollForReview(
                { number: 42 },
                { sinceIso: new Date(0).toISOString(), timeoutSec: 5 },
            ),
            (err: Error) => {
                assert.match(err.message, /rate limit exceeded/i);
                assert.ok(
                    isGithubRateLimit(err.message),
                    `runner must classify as rate limit, got: ${err.message}`,
                );
                return true;
            },
        );
    } finally {
        global.fetch = originalFetch;
        process.env = originalEnv;
        await ghServer.close();
    }
});
