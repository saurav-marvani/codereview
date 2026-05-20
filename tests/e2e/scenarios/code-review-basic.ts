import type { RunContext, Scenario } from "../lib/types.js";

// Fixture branch pairs per provider. Each entry maps to two branches that
// already exist in the test repo with a deliberate diff between them. The
// scenario opens a FRESH PR from head→base each run, so the
// `validate-new-commits` pipeline stage always treats it as a new review
// (re-triggering on a standing PR gets short-circuited as
// "already reviewed the latest changes").
//
// For GitHub: assumes the repo was forked via
// `scripts/pr-creator/fork-benchmark-repos.sh` into an org owned by the
// test PAT (e.g. `kodus-e2e`). The branch pair below comes from the sentry
// fork. When extending to other providers, populate the corresponding
// entries here once the fixture repos are set up.
const FIXTURE_BRANCHES: Record<
    string,
    { head: string; base: string } | undefined
> = {
    github: {
        // Refactor in the tiny-url fixture repo (kodus-e2e/tiny-url):
        // swaps the in-memory store from Object.create(null) to Map. No
        // behavior change, clean small diff — exercises the review
        // pipeline end-to-end without giving the LLM anything controversial
        // to flag. Set `GH_TEST_REPO=kodus-e2e/tiny-url` to use this.
        head: "refactor/use-map-storage",
        base: "main",
    },
    // Placeholders for GitLab / Bitbucket / Azure DevOps — assume the
    // tiny-url fixture repo will be mirrored into those providers under
    // the same path/branches. Good enough for mocked integration tests
    // (they only POST and don't care about the actual remote); won't work
    // against real providers until those mirrors exist.
    gitlab: {
        head: "refactor/use-map-storage",
        base: "main",
    },
    bitbucket: {
        head: "refactor/use-map-storage",
        base: "main",
    },
    "azure-devops": {
        head: "refactor/use-map-storage",
        base: "main",
    },
};

export const codeReviewBasic: Scenario = {
    id: "code-review-basic",
    title: "Kody reviews a PR opened on the configured fixture repo",
    priority: "P0",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        provider: ["github", "gitlab", "bitbucket", "azure-devops"],
        license: ["paid", "trial", "license-paid"],
    },
    // Scenario budget must comfortably exceed the inner pollForReview
    // budget (1500s) + onboarding + open-PR overhead. 1800s gives a
    // ~5min cushion so the outer kill never fires before the inner
    // timeout has a chance to surface a meaningful assertion message.
    timeoutSec: 1800,
    async run(ctx: RunContext) {
        ctx.assert(
            ctx.tenant,
            "scenario requires a tenant (set CLOUD_TENANT_*_EMAIL or SH_TENANT_EMAIL)",
        );

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        await ctx.kodus.finishOnboarding(session, repo);

        const fixture = FIXTURE_BRANCHES[ctx.provider.name];
        ctx.assert(
            fixture,
            `No fixture branch pair configured for provider ${ctx.provider.name} in code-review-basic.ts`,
        );

        if (!ctx.provider.openPRFromBranches) {
            throw new Error(
                `Provider ${ctx.provider.name} does not implement openPRFromBranches yet — add it before enabling this scenario for that provider`,
            );
        }

        const sinceIso = new Date().toISOString();
        const pr = await ctx.provider.openPRFromBranches({
            head: fixture!.head,
            base: fixture!.base,
            title: `[e2e] code-review-basic ${ctx.runId.slice(0, 8)}`,
            body: `Automated PR opened by Kodus E2E run ${ctx.runId}. Auto-closed by the scenario; branches are persistent fixtures and are not deleted.`,
        });

        try {
            // 25 min — matches per-seat-license-toggle's phase-2 budget.
            // Bumped from 600s on 2026-05-20 after matrix run #3 showed
            // gitlab/bitbucket/azure-devops × license-paid consistently
            // timing out at ~10 min while github passed in 160s and
            // per-seat (1500s budget) succeeded across all 4 providers.
            // Non-github providers genuinely take longer end-to-end —
            // probably a mix of webhook delivery latency and worker queue
            // depth — and the only meaningful signal we lost by extending
            // the budget is "review takes >10min", which we now expose
            // via reviewLatencySec on the evidence record so trends can
            // be observed across runs without re-introducing flakes.
            const pollStartMs = Date.now();
            const review = await ctx.provider.pollForReview(
                { number: pr.number },
                { sinceIso, timeoutSec: 1500 },
            );
            const reviewLatencySec = Math.round((Date.now() - pollStartMs) / 1000);

            // Trust per-provider filter (each pollForReview excludes the
            // `<!-- kody-codereview -->` status comments). What survives the
            // filter is a real Kody finding in whatever bucket the provider
            // uses (GitLab puts everything in issueComments because the API
            // has only notes; Bitbucket/Azure use reviewComments; GitHub
            // splits across all three).
            ctx.assert(
                review.reviewComments + review.issueComments + review.reviews >
                    0,
                `No real review findings on PR/MR #${pr.number} within timeout (${reviewLatencySec}s)`,
            );

            return {
                prNumber: pr.number,
                prUrl: pr.url,
                fixture,
                reviewLatencySec,
                sinceIso,
                review,
            };
        } finally {
            try {
                await ctx.provider.closePR(pr);
            } catch (err) {
                // best-effort cleanup — leaving the PR open is recoverable
            }
        }
    },
};

export default codeReviewBasic;
