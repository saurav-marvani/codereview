import type { OpenPRFromBranchesArgs } from "../lib/types.js";
import type {
    OpenPRArgs,
    OpenedPR,
    ProviderName,
    ProviderRepoRef,
    ReviewSignal,
    WebhookInfo,
} from "../lib/types.js";
import { BaseProvider, pollUntil, requireEnv } from "./base.js";
import { ensureOk, http } from "../lib/http.js";
import { prepareBranch } from "../lib/git.js";

interface AzureThread {
    id: number;
    publishedDate: string;
    lastUpdatedDate?: string;
    isDeleted?: boolean;
    status?: string;
    comments?: AzureComment[];
}

interface AzureComment {
    id: number;
    content: string;
    publishedDate: string;
    author?: { displayName: string };
}

export class AzureDevOpsProvider extends BaseProvider {
    readonly name: ProviderName = "azure-devops";
    readonly integrationType = "AZURE_REPOS";
    readonly webhookPath = "/azure-repos/webhook";

    private readonly pat: string;
    private readonly org: string;
    private readonly project: string;
    private readonly repo: string;
    private readonly apiBase: string;
    private readonly apiVersion = "7.1-preview.1";
    private repoId?: string;
    private readonly existingPrId?: number;

    constructor() {
        super();
        this.pat = requireEnv("AZ_TEST_TOKEN");
        this.org = requireEnv("AZ_TEST_ORG");
        this.project = requireEnv("AZ_TEST_PROJECT");
        this.repo = requireEnv("AZ_TEST_REPO");
        this.apiBase = `https://dev.azure.com/${encodeURIComponent(this.org)}/${encodeURIComponent(this.project)}`;
        const existing = process.env.AZ_TEST_PR_ID;
        if (existing) this.existingPrId = Number(existing);
    }

    private basicAuth(): string {
        const raw = `:${this.pat}`;
        return `Basic ${Buffer.from(raw).toString("base64")}`;
    }

    private headers(): Record<string, string> {
        return {
            Authorization: this.basicAuth(),
            Accept: "application/json",
        };
    }

    private cloneUrl(): string {
        return `https://anything:${this.pat}@dev.azure.com/${this.org}/${this.project}/_git/${this.repo}`;
    }

    private async resolveRepoId(): Promise<string> {
        if (this.repoId) return this.repoId;
        const resp = await http<{ id: string }>(
            `${this.apiBase}/_apis/git/repositories/${encodeURIComponent(this.repo)}?api-version=7.1-preview.1`,
            { headers: this.headers() },
        );
        ensureOk(resp, "azure:resolveRepoId");
        this.repoId = resp.body.id;
        return this.repoId;
    }

    async repoRef(): Promise<ProviderRepoRef> {
        const id = await this.resolveRepoId();
        return {
            id,
            full_name: `${this.org}/${this.project}/${this.repo}`,
            name: this.repo,
        };
    }

    async createWebhook(webhookUrl: string): Promise<{ id: string }> {
        const repoId = await this.resolveRepoId();
        const subscriptionUrl = `https://dev.azure.com/${encodeURIComponent(this.org)}/_apis/hooks/subscriptions?api-version=7.1-preview.1`;
        const body = {
            publisherId: "tfs",
            eventType: "git.pullrequest.created",
            resourceVersion: "1.0",
            consumerId: "webHooks",
            consumerActionId: "httpRequest",
            publisherInputs: {
                projectId: this.project,
                repository: repoId,
            },
            consumerInputs: {
                url: webhookUrl,
            },
        };
        const resp = await http<{ id: string }>(subscriptionUrl, {
            method: "POST",
            headers: this.headers(),
            body,
        });
        ensureOk(resp, "azure:createWebhook");
        return { id: resp.body.id };
    }

    async deleteWebhook(id: string): Promise<void> {
        await http(
            `https://dev.azure.com/${encodeURIComponent(this.org)}/_apis/hooks/subscriptions/${id}?api-version=7.1-preview.1`,
            { method: "DELETE", headers: this.headers() },
        );
    }

    async listWebhooks(): Promise<WebhookInfo[]> {
        // Azure DevOps service hooks are subscriptions scoped to the
        // organization. We filter client-side to only those whose
        // publisherInputs.repository matches the test repo — otherwise
        // unrelated subscriptions in the org leak into the assertion.
        const repoId = await this.resolveRepoId();
        const url = `https://dev.azure.com/${encodeURIComponent(this.org)}/_apis/hooks/subscriptions?api-version=7.1-preview.1`;
        const resp = await http<{
            value?: Array<{
                id: string;
                status: string;
                eventType: string;
                publisherInputs?: { repository?: string };
                consumerInputs?: { url?: string };
            }>;
        }>(url, { headers: this.headers() });
        ensureOk(resp, "azure:listWebhooks");
        return (resp.body.value ?? [])
            .filter(
                (s) =>
                    !s.publisherInputs?.repository ||
                    s.publisherInputs.repository === repoId,
            )
            .map((s) => ({
                id: s.id,
                url: s.consumerInputs?.url ?? "",
                active: s.status === "enabled",
                events: s.eventType ? [s.eventType] : [],
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
            const repoId = await this.resolveRepoId();
            const resp = await http<{
                pullRequestId: number;
                url: string;
                _links?: { web?: { href: string } };
            }>(
                `${this.apiBase}/_apis/git/repositories/${repoId}/pullrequests?api-version=${this.apiVersion}`,
                {
                    method: "POST",
                    headers: this.headers(),
                    body: {
                        sourceRefName: `refs/heads/${args.branch}`,
                        targetRefName: `refs/heads/${prepared.baseBranch}`,
                        title: args.title,
                        description: args.body,
                    },
                },
            );
            ensureOk(resp, "azure:openPR");
            const webUrl =
                resp.body._links?.web?.href ??
                `https://dev.azure.com/${this.org}/${this.project}/_git/${this.repo}/pullrequest/${resp.body.pullRequestId}`;
            return {
                number: resp.body.pullRequestId,
                url: webUrl,
                branch: args.branch,
                baseBranch: prepared.baseBranch,
            };
        } finally {
            prepared.cleanup();
        }
    }

    async openPRFromBranches(args: OpenPRFromBranchesArgs): Promise<OpenedPR> {
        const repoId = await this.resolveRepoId();
        const resp = await http<{
            pullRequestId: number;
            _links?: { web?: { href: string } };
        }>(
            `${this.apiBase}/_apis/git/repositories/${repoId}/pullrequests?api-version=${this.apiVersion}`,
            {
                method: "POST",
                headers: this.headers(),
                body: {
                    sourceRefName: `refs/heads/${args.head}`,
                    targetRefName: `refs/heads/${args.base}`,
                    title: args.title,
                    description: args.body,
                },
            },
        );
        ensureOk(resp, "azure:openPRFromBranches");
        const webUrl =
            resp.body._links?.web?.href ??
            `https://dev.azure.com/${this.org}/${this.project}/_git/${this.repo}/pullrequest/${resp.body.pullRequestId}`;
        return {
            number: resp.body.pullRequestId,
            url: webUrl,
            branch: args.head,
            baseBranch: args.base,
            keepBranchOnClose: true,
        };
    }

    async closePR(pr: OpenedPR): Promise<void> {
        const repoId = await this.resolveRepoId();
        await http(
            `${this.apiBase}/_apis/git/repositories/${repoId}/pullrequests/${pr.number}?api-version=${this.apiVersion}`,
            {
                method: "PATCH",
                headers: this.headers(),
                body: { status: "abandoned" },
            },
        );
        // Azure DevOps PR abandon doesn't delete the source ref; no extra
        // step needed regardless of keepBranchOnClose.
    }

    async triggerReviewOnExistingPR(
        prNumber: number,
    ): Promise<{ triggerId: string; sinceIso: string }> {
        const repoId = await this.resolveRepoId();
        const target = prNumber || this.existingPrId;
        if (!target) throw new Error("azure:triggerReview requires AZ_TEST_PR_ID");
        const resp = await http<{
            id: number;
            publishedDate: string;
            comments: { id: number; publishedDate: string }[];
        }>(
            `${this.apiBase}/_apis/git/repositories/${repoId}/pullRequests/${target}/threads?api-version=${this.apiVersion}`,
            {
                method: "POST",
                headers: this.headers(),
                body: {
                    comments: [
                        {
                            parentCommentId: 0,
                            content: "@kody review",
                            commentType: 1,
                        },
                    ],
                    status: 1,
                },
            },
        );
        ensureOk(resp, "azure:triggerReview");
        const triggerComment = resp.body.comments?.[0];
        return {
            triggerId: String(triggerComment?.id ?? resp.body.id),
            sinceIso: triggerComment?.publishedDate ?? resp.body.publishedDate,
        };
    }

    async pollForReview(
        pr: { number: number },
        opts: { sinceIso: string; triggerId?: string; timeoutSec?: number },
    ): Promise<ReviewSignal> {
        const repoId = await this.resolveRepoId();
        const result = await pollUntil(
            async () => {
                const resp = await http<{ value: AzureThread[] }>(
                    `${this.apiBase}/_apis/git/repositories/${repoId}/pullRequests/${pr.number}/threads?api-version=${this.apiVersion}`,
                    { headers: this.headers() },
                );
                ensureOk(resp, "azure:pollForReview");
                let count = 0;
                let sample = "";
                for (const thread of resp.body.value ?? []) {
                    if (thread.isDeleted) continue;
                    for (const c of thread.comments ?? []) {
                        if (c.publishedDate <= opts.sinceIso) continue;
                        if (opts.triggerId && String(c.id) === opts.triggerId)
                            continue;
                        const text = c.content ?? "";
                        if (text.toLowerCase().startsWith("@kody")) continue;
                        // Drop "Started!" placeholder but keep "Complete!" —
                        // the latter is a valid mechanics signal even when
                        // Kody found no inline findings.
                        if (
                            text.includes("<!-- kody-codereview") &&
                            !text.includes("kody-codereview-completed")
                        ) {
                            continue;
                        }
                        count++;
                        if (!sample) sample = text.slice(0, 240);
                    }
                }
                if (count > 0) {
                    return {
                        reviewComments: count,
                        issueComments: 0,
                        reviews: 0,
                        sample,
                    };
                }
                return null;
            },
            { timeoutSec: opts.timeoutSec ?? 600, intervalSec: 10 },
        );
        return result ?? { reviewComments: 0, issueComments: 0, reviews: 0 };
    }

    async postComment(
        prNumber: number,
        body: string,
    ): Promise<{ id: string }> {
        const repoId = await this.resolveRepoId();
        const resp = await http<{
            id: number;
            comments: { id: number }[];
        }>(
            `${this.apiBase}/_apis/git/repositories/${repoId}/pullRequests/${prNumber}/threads?api-version=${this.apiVersion}`,
            {
                method: "POST",
                headers: this.headers(),
                body: {
                    comments: [
                        { parentCommentId: 0, content: body, commentType: 1 },
                    ],
                    status: 1,
                },
            },
        );
        ensureOk(resp, "azure:postComment");
        return {
            id: String(resp.body.comments?.[0]?.id ?? resp.body.id),
        };
    }

    authMode(): "token" {
        return "token";
    }

    authToken(): string {
        return this.pat;
    }
}
