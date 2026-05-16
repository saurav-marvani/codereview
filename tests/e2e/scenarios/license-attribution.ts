import type { LicenseMode, RunContext, Scenario } from "../lib/types.js";

export const licenseAttribution: Scenario = {
    id: "license-attribution",
    title:
        "Entitlement gate honors the active license/plan: paid reviews; free does not",
    priority: "P0",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        provider: ["github"],
        license: ["free", "trial", "paid", "license-paid", "license-free"],
    },
    timeoutSec: 600,
    async run(ctx: RunContext) {
        ctx.assert(ctx.tenant, "scenario requires a tenant");

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        await ctx.kodus.finishOnboarding(session, repo);

        const noReviewLicenses: LicenseMode[] = ["free", "license-free"];
        const expectReview = !noReviewLicenses.includes(ctx.license);

        const { triggerId, sinceIso } = await ctx.provider.triggerReviewOnExistingPR(0);
        const prNumber = Number(
            process.env.GH_TEST_PR_NUMBER ?? process.env.GH_TEST_MR_IID ?? "0",
        );
        ctx.assert(prNumber > 0, "GH_TEST_PR_NUMBER is required");

        const pollWindow = expectReview ? 600 : 90;
        const review = await ctx.provider.pollForReview(
            { number: prNumber },
            { sinceIso, triggerId, timeoutSec: pollWindow },
        );

        // Trust per-provider filter (excludes Kody's status placeholder by
        // <!-- kody-codereview --> marker). Whatever survives counts as a
        // real Kody response, regardless of which bucket the provider uses.
        const sawReview =
            review.reviewComments + review.issueComments + review.reviews > 0;

        if (expectReview) {
            ctx.assert(
                sawReview,
                `Expected review for license=${ctx.license} but none arrived within ${pollWindow}s`,
            );
        } else {
            ctx.assert(
                !sawReview,
                `Expected NO review for license=${ctx.license} but found activity: ${JSON.stringify(review)}`,
            );
        }

        return {
            expectReview,
            actuallySawReview: sawReview,
            review,
            prNumber,
            sinceIso,
            triggerId,
        };
    },
};

export default licenseAttribution;
