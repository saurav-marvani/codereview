// AWS WAF on the QA ALB intermittently blocks GitHub-hosted runner IPs,
// 403-ing the whole run. The WAF carries an Allow rule keyed on the
// `x-kodus-e2e` secret header (QA_WAF_BYPASS_HEADER). Browser contexts
// inject it via route() — scoped to `qa.*.kodus.io` hosts ONLY, so the
// secret never leaks to third parties the page touches (Stripe checkout,
// fonts, etc.), which a context-wide extraHTTPHeaders would do.
// No-op when the env var is unset (local runs, forks, self-hosted cells).
export async function applyWafBypass(ctx) {
    const secret = process.env.QA_WAF_BYPASS_HEADER;
    if (!secret) return;
    await ctx.route(
        (url) => /^qa\.([a-z0-9-]+\.)*kodus\.io$/i.test(url.hostname),
        (route) =>
            route.continue({
                headers: {
                    ...route.request().headers(),
                    "x-kodus-e2e": secret,
                },
            }),
    );
}
