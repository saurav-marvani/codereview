import type {
    OpenPRArgs,
    OpenPRFromBranchesArgs,
    OpenedPR,
    ProviderName,
    ProviderRepoRef,
    ReviewSignal,
    WebhookInfo,
} from "../lib/types.js";
import { BaseProvider, nowIso, pollUntil, requireEnv } from "./base.js";
import { ensureOk, http } from "../lib/http.js";
import { prepareBranch } from "../lib/git.js";
import { logger } from "../lib/log.js";

const log = logger("provider:github");

export class GitHubProvider extends BaseProvider {
    readonly name: ProviderName = "github";
    readonly integrationType = "GITHUB";
    readonly webhookPath = "/github/webhook";

    private readonly token: string;
    private readonly repoFullName: string;
    private readonly apiBase = "https://api.github.com";
    private readonly existingPrNumber?: number;

    constructor() {
        super();
        this.token = requireEnv("GH_TEST_TOKEN");
        this.repoFullName = requireEnv("GH_TEST_REPO");
        const existing = process.env.GH_TEST_PR_NUMBER;
        if (existing) this.existingPrNumber = Number(existing);
    }

    private headers(): Record<string, string> {
        return {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        };
    }

    private cloneUrl(): string {
        return `https://x-access-token:${this.token}@github.com/${this.repoFullName}.git`;
    }

    async repoRef(): Promise<ProviderRepoRef> {
        const resp = await http<{ id: number; full_name: string; name: string }>(
            `${this.apiBase}/repos/${this.repoFullName}`,
            { headers: this.headers() },
        );
        ensureOk(resp, "github:repoRef");
        return {
            id: resp.body.id,
            full_name: resp.body.full_name,
            name: resp.body.name,
        };
    }

    async createWebhook(webhookUrl: string): Promise<{ id: string }> {
        const resp = await http<{ id: number }>(
            `${this.apiBase}/repos/${this.repoFullName}/hooks`,
            {
                method: "POST",
                headers: this.headers(),
                body: {
                    name: "web",
                    active: true,
                    events: [
                        "pull_request",
                        "push",
                        "issue_comment",
                        "pull_request_review",
                        "pull_request_review_comment",
                    ],
                    config: {
                        url: webhookUrl,
                        content_type: "json",
                        insecure_ssl: "0",
                    },
                },
            },
        );
        ensureOk(resp, "github:createWebhook");
        return { id: String(resp.body.id) };
    }

    async deleteWebhook(id: string): Promise<void> {
        await http(
            `${this.apiBase}/repos/${this.repoFullName}/hooks/${id}`,
            { method: "DELETE", headers: this.headers() },
        );
    }

    async listWebhooks(): Promise<WebhookInfo[]> {
        const resp = await http<
            Array<{
                id: number;
                active: boolean;
                events: string[];
                config?: { url?: string };
            }>
        >(`${this.apiBase}/repos/${this.repoFullName}/hooks?per_page=100`, {
            headers: this.headers(),
        });
        ensureOk(resp, "github:listWebhooks");
        return (resp.body ?? []).map((h) => ({
            id: String(h.id),
            url: h.config?.url ?? "",
            active: Boolean(h.active),
            events: h.events ?? [],
        }));
    }

    async openPR(args: OpenPRArgs): Promise<OpenedPR> {
        const prepared = await prepareBranch({
            cloneUrl: this.cloneUrl(),
            branch: args.branch,
            files: args.fixtureFiles,
            commitMessage: args.title,
            baseBranch: args.baseBranch,
        });
        try {
            const resp = await http<{ number: number; html_url: string }>(
                `${this.apiBase}/repos/${this.repoFullName}/pulls`,
                {
                    method: "POST",
                    headers: this.headers(),
                    body: {
                        title: args.title,
                        body: args.body,
                        head: args.branch,
                        base: prepared.baseBranch,
                    },
                },
            );
            ensureOk(resp, "github:openPR");
            return {
                number: resp.body.number,
                url: resp.body.html_url,
                branch: args.branch,
                baseBranch: prepared.baseBranch,
            };
        } finally {
            prepared.cleanup();
        }
    }

    async openPRFromBranches(args: OpenPRFromBranchesArgs): Promise<OpenedPR> {
        // Self-heal: GitHub refuses to open a second open PR for the same
        // head→base combo. If a previous run crashed before `closePR` (or a
        // human left a standing PR there), close it first so we can open
        // fresh.
        await this.closeOpenPRsBetween(args.head, args.base);

        const resp = await http<{ number: number; html_url: string }>(
            `${this.apiBase}/repos/${this.repoFullName}/pulls`,
            {
                method: "POST",
                headers: this.headers(),
                body: {
                    title: args.title,
                    body: args.body,
                    head: args.head,
                    base: args.base,
                },
            },
        );
        ensureOk(resp, "github:openPRFromBranches");
        return {
            number: resp.body.number,
            url: resp.body.html_url,
            branch: args.head,
            baseBranch: args.base,
            keepBranchOnClose: true,
        };
    }

    private async closeOpenPRsBetween(
        head: string,
        base: string,
    ): Promise<void> {
        // GitHub's list-PRs `head` filter expects `owner:branch` form.
        const owner = this.repoFullName.split("/")[0];
        const headRef = `${owner}:${head}`;
        const resp = await http<Array<{ number: number; state: string }>>(
            `${this.apiBase}/repos/${this.repoFullName}/pulls?state=open&head=${encodeURIComponent(headRef)}&base=${encodeURIComponent(base)}&per_page=10`,
            { headers: this.headers() },
        );
        for (const pr of resp.body ?? []) {
            await http(
                `${this.apiBase}/repos/${this.repoFullName}/pulls/${pr.number}`,
                {
                    method: "PATCH",
                    headers: this.headers(),
                    body: { state: "closed" },
                },
            );
        }
    }

    async closePR(pr: OpenedPR): Promise<void> {
        await http(
            `${this.apiBase}/repos/${this.repoFullName}/pulls/${pr.number}`,
            {
                method: "PATCH",
                headers: this.headers(),
                body: { state: "closed" },
            },
        );
        if (pr.keepBranchOnClose) return;
        await http(
            `${this.apiBase}/repos/${this.repoFullName}/git/refs/heads/${pr.branch}`,
            { method: "DELETE", headers: this.headers() },
        );
    }

    async triggerReviewOnExistingPR(
        prNumber: number,
    ): Promise<{ triggerId: string; sinceIso: string }> {
        const target = prNumber || this.existingPrNumber;
        if (!target) throw new Error("github:triggerReview requires GH_TEST_PR_NUMBER");
        const resp = await http<{ id: number; created_at: string }>(
            `${this.apiBase}/repos/${this.repoFullName}/issues/${target}/comments`,
            {
                method: "POST",
                headers: this.headers(),
                body: { body: "@kody review" },
            },
        );
        ensureOk(resp, "github:triggerReview");
        return {
            triggerId: String(resp.body.id),
            sinceIso: resp.body.created_at,
        };
    }

    async pollForReview(
        pr: { number: number },
        opts: { sinceIso: string; triggerId?: string; timeoutSec?: number },
    ): Promise<ReviewSignal> {
        const since = encodeURIComponent(opts.sinceIso);
        const result = await pollUntil(
            async () => {
                const [reviewComments, issueComments, reviews] = await Promise.all([
                    http<{ id: number; body: string }[]>(
                        `${this.apiBase}/repos/${this.repoFullName}/pulls/${pr.number}/comments?since=${since}`,
                        { headers: this.headers() },
                    ),
                    http<{ id: number; body: string }[]>(
                        `${this.apiBase}/repos/${this.repoFullName}/issues/${pr.number}/comments?since=${since}`,
                        { headers: this.headers() },
                    ),
                    http<
                        { submitted_at?: string; created_at?: string; body?: string }[]
                    >(
                        `${this.apiBase}/repos/${this.repoFullName}/pulls/${pr.number}/reviews`,
                        { headers: this.headers() },
                    ),
                ]);
                // Distinguish Kody's two notification stages:
                //   - "Started!" placeholder carries `<!-- kody-codereview -->`
                //     by itself. No findings yet — drop.
                //   - "Complete!" carries `<!-- kody-codereview-completed-… -->`
                //     plus `<!-- kody-codereview -->`. Pipeline finished —
                //     keep, because for mechanics smoke tests "review came
                //     back, no issues" is a valid PASS signal (even with
                //     zero inline findings).
                const isStatusComment = (body: string) =>
                    body.includes("<!-- kody-codereview") &&
                    !body.includes("kody-codereview-completed");
                const filterNonTrigger = (items: { id: number; body: string }[]) =>
                    items.filter(
                        (c) =>
                            String(c.id) !== opts.triggerId &&
                            !(c.body ?? "").toLowerCase().startsWith("@kody") &&
                            !isStatusComment(c.body ?? ""),
                    );
                const rc = filterNonTrigger(reviewComments.body ?? []);
                const ic = filterNonTrigger(issueComments.body ?? []);
                const rv = (reviews.body ?? []).filter((r) => {
                    const ts = r.submitted_at ?? r.created_at ?? "";
                    if (ts <= opts.sinceIso) return false;
                    const body = r.body ?? "";
                    if (body.toLowerCase().startsWith("@kody")) return false;
                    if (isStatusComment(body)) return false;
                    return true;
                });
                if (rc.length || ic.length || rv.length) {
                    const sample = rc[0]?.body ?? ic[0]?.body ?? rv[0]?.body ?? "";
                    return {
                        reviewComments: rc.length,
                        issueComments: ic.length,
                        reviews: rv.length,
                        sample: sample.slice(0, 240),
                    };
                }
                return null;
            },
            { timeoutSec: opts.timeoutSec ?? 600, intervalSec: 10 },
        );
        if (!result) {
            log.err(`No review activity on PR #${pr.number} after timeout`);
            return { reviewComments: 0, issueComments: 0, reviews: 0 };
        }
        return result;
    }

    async postComment(
        prNumber: number,
        body: string,
    ): Promise<{ id: string }> {
        const resp = await http<{ id: number }>(
            `${this.apiBase}/repos/${this.repoFullName}/issues/${prNumber}/comments`,
            {
                method: "POST",
                headers: this.headers(),
                body: { body },
            },
        );
        ensureOk(resp, "github:postComment");
        return { id: String(resp.body.id) };
    }

    authMode(): "token" {
        return "token";
    }

    authToken(): string {
        return this.token;
    }
}

export function _touch() {
    return nowIso();
}
