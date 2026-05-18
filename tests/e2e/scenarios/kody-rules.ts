import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunContext, Scenario } from "../lib/types.js";
import { ensureOk, http } from "../lib/http.js";

// Fixture branch pair per provider. Each fixture branch lives permanently in
// the test repo and contains a file with deliberate TODO_REMOVE_ME markers
// (both as a comment and as a string literal) so the rule we create at
// runtime always has something concrete to match against. We use
// `openPRFromBranches` instead of the old clone+push flow because:
//   - the old flow took ~70s per run on sentry (large repo)
//   - the fixture content is stable, so there's nothing per-run that needs
//     to be authored from the test runner
const FIXTURE_BRANCHES: Record<
    string,
    { head: string; base: string } | undefined
> = {
    github: {
        // Persistent fixture branch in kodus-e2e/tiny-url. Adds
        // `src/legacy/cleanup.ts` with TODO_REMOVE_ME both as a string
        // literal (FORBIDDEN_MARKER constant) and inside a comment, so a
        // rule forbidding the identifier matches either interpretation.
        head: "fixture/kody-rule-todo-remove-me",
        base: "main",
    },
    gitlab: {
        // Same fixture mirrored into gitlab.com/kodus-e2e/tiny-url. The
        // branch was pushed as part of the initial fixture seeding.
        head: "fixture/kody-rule-todo-remove-me",
        base: "main",
    },
};

export const kodyRulesCreateAndApply: Scenario = {
    id: "kody-rules-create-and-apply",
    title: "A Kody Rule is created and applied to a fresh PR",
    priority: "P0",
    appliesTo: {
        target: ["cloud", "self-hosted"],
        provider: ["github", "gitlab", "bitbucket", "azure-devops"],
        license: ["paid", "license-paid"],
    },
    timeoutSec: 1200,
    async run(ctx: RunContext) {
        ctx.assert(ctx.tenant, "scenario requires a tenant");

        const fixture = FIXTURE_BRANCHES[ctx.provider.name];
        ctx.assert(
            fixture,
            `No fixture branch pair configured for provider ${ctx.provider.name} in kody-rules.ts`,
        );
        if (!ctx.provider.openPRFromBranches) {
            throw new Error(
                `Provider ${ctx.provider.name} does not implement openPRFromBranches yet`,
            );
        }

        const session = await ctx.kodus.login(ctx.tenant!);
        await ctx.kodus.registerIntegration(session);
        const repo = await ctx.kodus.registerRepo(session);
        await ctx.kodus.finishOnboarding(session, repo);

        const ruleName = `e2e-rule-${ctx.runId.slice(0, 8)}-${randomUUID().slice(0, 6)}`;
        // Unambiguous wording: explicitly call out comments AND string
        // literals so a pedantic LLM doesn't excuse comment-only matches as
        // "not a string literal in the JS sense". The fixture has both.
        const ruleInstruction =
            "Forbid any occurrence of the identifier TODO_REMOVE_ME in source files, including in comments and string literals.";

        const ruleResp = await http<{
            data?: { uuid?: string; id?: string };
        }>(
            // POST /kody-rules/create-or-update (CreateKodyRuleDto). `type`,
            // `title`, `rule`, `severity`, `origin` are required by the DTO;
            // severity is lowercase, origin must be 'user'|'library'|'generated'.
            `${ctx.target.apiBaseUrl}/kody-rules/create-or-update`,
            {
                method: "POST",
                headers: { Authorization: `Bearer ${session.accessToken}` },
                body: {
                    teamId: session.teamId,
                    repositoryId: String(repo.id),
                    type: "standard",
                    title: ruleName,
                    rule: ruleInstruction,
                    severity: "high",
                    origin: "user",
                    path: "",
                },
                timeoutMs: 30_000,
            },
        );
        ensureOk(ruleResp, "kody-rules:create");
        const ruleId = ruleResp.body.data?.uuid ?? ruleResp.body.data?.id;
        ctx.assert(
            ruleId,
            "Rule was created but the response did not include uuid/id",
        );

        const sinceIso = new Date().toISOString();
        const opened = await ctx.provider.openPRFromBranches({
            head: fixture!.head,
            base: fixture!.base,
            title: `[e2e] kody-rules ${ruleName}`,
            body: `Automated PR opened by Kodus E2E run ${ctx.runId} to validate rule ${ruleName}. Auto-closed by the scenario; branches are persistent fixtures and are not deleted.`,
        });

        try {
            const review = await ctx.provider.pollForReview(
                { number: opened.number },
                { sinceIso, timeoutSec: 720 },
            );

            // Mechanics: review pipeline ran end-to-end and Kody finished
            // (status "Complete!" comment or real inline findings).
            ctx.assert(
                review.reviewComments + review.issueComments + review.reviews >
                    0,
                `No review activity on PR ${opened.url} within timeout`,
            );

            // Apply: the rule influenced the review. Mechanically observable
            // via Kodus's own API (`GET /kody-rules/suggestions?ruleId=…`)
            // which returns suggestions whose pipeline-side metadata links
            // them to this rule. We don't inspect the suggestion text — only
            // count — so we don't reintroduce LLM-quality flakiness. If 0
            // suggestions came back for an obvious fixture (literal +
            // commented TODO_REMOVE_ME against a rule explicitly forbidding
            // it), the rule pipeline silently skipped — a real regression.
            const suggestionsResp = await http<{ data?: unknown[] }>(
                `${ctx.target.apiBaseUrl}/kody-rules/suggestions?ruleId=${encodeURIComponent(ruleId!)}`,
                {
                    headers: {
                        Authorization: `Bearer ${session.accessToken}`,
                    },
                    timeoutMs: 30_000,
                },
            );
            ensureOk(suggestionsResp, "kody-rules:findSuggestionsByRule");
            const suggestionsCount = Array.isArray(suggestionsResp.body.data)
                ? suggestionsResp.body.data.length
                : 0;
            ctx.assert(
                suggestionsCount > 0,
                `Rule ${ruleName} produced 0 suggestions even though the fixture branch contains explicit TODO_REMOVE_ME occurrences. Either the rule pipeline didn't run for this PR or it ignored the rule.`,
            );

            // Informational only — captured as evidence, not asserted on.
            // The sample text depends on LLM phrasing and is out of scope
            // for this mechanics test.
            const sample = (review.sample ?? "").toLowerCase();
            const mentionsRule =
                sample.includes(ruleName.toLowerCase()) ||
                sample.includes("todo_remove_me") ||
                sample.includes("kody rule") ||
                sample.includes("rule violation");

            writeFileSync(
                join(ctx.artifactDir, "review-sample.txt"),
                review.sample ?? "(no sample captured)",
            );

            return {
                ruleId,
                ruleName,
                pr: opened,
                review,
                suggestionsCount,
                rulementioned: mentionsRule,
            };
        } finally {
            try {
                await ctx.provider.closePR(opened);
            } catch (err) {
                /* best effort */
            }
            if (ruleId) {
                try {
                    await http(
                        // DELETE /kody-rules/delete-rule-in-organization-by-id
                        // ?ruleId=…&teamId=… (query params, not path).
                        `${ctx.target.apiBaseUrl}/kody-rules/delete-rule-in-organization-by-id?ruleId=${encodeURIComponent(ruleId)}&teamId=${encodeURIComponent(session.teamId)}`,
                        {
                            method: "DELETE",
                            headers: {
                                Authorization: `Bearer ${session.accessToken}`,
                            },
                        },
                    );
                } catch {
                    /* best effort */
                }
            }
        }
    },
};

export default kodyRulesCreateAndApply;
