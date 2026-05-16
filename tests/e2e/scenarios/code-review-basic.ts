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
        head: "performance-enhancement-complete",
        base: "performance-optimization-baseline",
    },
    // Placeholders for GitLab / Bitbucket / Azure DevOps — the real values
    // come from the equivalent fork (TODO: replicate
    // scripts/pr-creator/fork-benchmark-repos.sh into those providers).
    // The values below are good enough for the mocked integration tests
    // (they only need a head/base pair to POST), but won't work against
    // real providers until the fixture repos exist.
    gitlab: {
        head: "performance-enhancement-complete",
        base: "performance-optimization-baseline",
    },
    bitbucket: {
        head: "performance-enhancement-complete",
        base: "performance-optimization-baseline",
    },
    "azure-devops": {
        head: "performance-enhancement-complete",
        base: "performance-optimization-baseline",
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
    timeoutSec: 900,
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
            const review = await ctx.provider.pollForReview(
                { number: pr.number },
                { sinceIso, timeoutSec: 600 },
            );

            // Trust per-provider filter (each pollForReview excludes the
            // `<!-- kody-codereview -->` status comments). What survives the
            // filter is a real Kody finding in whatever bucket the provider
            // uses (GitLab puts everything in issueComments because the API
            // has only notes; Bitbucket/Azure use reviewComments; GitHub
            // splits across all three).
            ctx.assert(
                review.reviewComments + review.issueComments + review.reviews >
                    0,
                `No real review findings on PR/MR #${pr.number} within timeout`,
            );

            return {
                prNumber: pr.number,
                prUrl: pr.url,
                fixture,
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
