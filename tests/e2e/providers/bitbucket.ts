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

interface BitbucketComment {
    id: number;
    content: { raw: string };
    created_on: string;
    user: { uuid: string; display_name: string };
}

export class BitbucketProvider extends BaseProvider {
    readonly name: ProviderName = "bitbucket";
    readonly integrationType = "BITBUCKET";
    readonly webhookPath = "/bitbucket/webhook";

    private readonly user: string;
    private readonly appPassword: string;
    private readonly workspaceSlug: string;
    private readonly apiBase = "https://api.bitbucket.org/2.0";
    private readonly existingPrId?: number;

    constructor() {
        super();
        this.user = requireEnv("BB_TEST_USER");
        this.appPassword = requireEnv("BB_TEST_APP_PASSWORD");
        this.workspaceSlug = requireEnv("BB_TEST_REPO");
        const existing = process.env.BB_TEST_PR_ID;
        if (existing) this.existingPrId = Number(existing);
    }

    private basicAuth(): string {
        const raw = `${this.user}:${this.appPassword}`;
        return `Basic ${Buffer.from(raw).toString("base64")}`;
    }

    private headers(): Record<string, string> {
        return {
            Authorization: this.basicAuth(),
            Accept: "application/json",
        };
    }

    private cloneUrl(): string {
        return `https://${this.user}:${this.appPassword}@bitbucket.org/${this.workspaceSlug}.git`;
    }

    async repoRef(): Promise<ProviderRepoRef> {
        const resp = await http<{ uuid: string; full_name: string; name: string }>(
            `${this.apiBase}/repositories/${this.workspaceSlug}`,
            { headers: this.headers() },
        );
        ensureOk(resp, "bitbucket:repoRef");
        return {
            id: resp.body.uuid,
            full_name: resp.body.full_name,
            name: resp.body.name,
        };
    }

    async createWebhook(webhookUrl: string): Promise<{ id: string }> {
        const resp = await http<{ uuid: string }>(
            `${this.apiBase}/repositories/${this.workspaceSlug}/hooks`,
            {
                method: "POST",
                headers: this.headers(),
                body: {
                    description: "Kodus E2E webhook",
                    url: webhookUrl,
                    active: true,
                    events: [
                        "pullrequest:created",
                        "pullrequest:updated",
                        "pullrequest:comment_created",
                        "pullrequest:approved",
                        "repo:push",
                    ],
                },
            },
        );
        ensureOk(resp, "bitbucket:createWebhook");
        return { id: resp.body.uuid };
    }

    async deleteWebhook(id: string): Promise<void> {
        await http(
            `${this.apiBase}/repositories/${this.workspaceSlug}/hooks/${encodeURIComponent(id)}`,
            { method: "DELETE", headers: this.headers() },
        );
    }

    async listWebhooks(): Promise<WebhookInfo[]> {
        const resp = await http<{
            values?: Array<{
                uuid: string;
                url: string;
                active: boolean;
                events: string[];
            }>;
        }>(
            `${this.apiBase}/repositories/${this.workspaceSlug}/hooks?pagelen=100`,
            { headers: this.headers() },
        );
        ensureOk(resp, "bitbucket:listWebhooks");
        return (resp.body.values ?? []).map((h) => ({
            id: h.uuid,
            url: h.url ?? "",
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
            const resp = await http<{
                id: number;
                links: { html: { href: string } };
            }>(
                `${this.apiBase}/repositories/${this.workspaceSlug}/pullrequests`,
                {
                    method: "POST",
                    headers: this.headers(),
                    body: {
                        title: args.title,
                        description: args.body,
                        source: { branch: { name: args.branch } },
                        destination: { branch: { name: prepared.baseBranch } },
                        close_source_branch: true,
                    },
                },
            );
            ensureOk(resp, "bitbucket:openPR");
            return {
                number: resp.body.id,
                url: resp.body.links.html.href,
                branch: args.branch,
                baseBranch: prepared.baseBranch,
            };
        } finally {
            prepared.cleanup();
        }
    }

    async openPRFromBranches(args: OpenPRFromBranchesArgs): Promise<OpenedPR> {
        const resp = await http<{ id: number; links: { html: { href: string } } }>(
            `${this.apiBase}/repositories/${this.workspaceSlug}/pullrequests`,
            {
                method: "POST",
                headers: this.headers(),
                body: {
                    title: args.title,
                    description: args.body,
                    source: { branch: { name: args.head } },
                    destination: { branch: { name: args.base } },
                    // Persistent fixture branch — don't auto-delete on close.
                    close_source_branch: false,
                },
            },
        );
        ensureOk(resp, "bitbucket:openPRFromBranches");
        return {
            number: resp.body.id,
            url: resp.body.links.html.href,
            branch: args.head,
            baseBranch: args.base,
            keepBranchOnClose: true,
        };
    }

    async closePR(pr: OpenedPR): Promise<void> {
        await http(
            `${this.apiBase}/repositories/${this.workspaceSlug}/pullrequests/${pr.number}/decline`,
            { method: "POST", headers: this.headers() },
        );
        // Bitbucket's decline doesn't delete the source branch; nothing
        // extra needed here whether keepBranchOnClose is true or false.
    }

    async triggerReviewOnExistingPR(
        prNumber: number,
    ): Promise<{ triggerId: string; sinceIso: string }> {
        const target = prNumber || this.existingPrId;
        if (!target) throw new Error("bitbucket:triggerReview requires BB_TEST_PR_ID");
        const resp = await http<BitbucketComment>(
            `${this.apiBase}/repositories/${this.workspaceSlug}/pullrequests/${target}/comments`,
            {
                method: "POST",
                headers: this.headers(),
                body: { content: { raw: "@kody review" } },
            },
        );
        ensureOk(resp, "bitbucket:triggerReview");
        return {
            triggerId: String(resp.body.id),
            sinceIso: resp.body.created_on,
        };
    }

    async pollForReview(
        pr: { number: number },
        opts: { sinceIso: string; triggerId?: string; timeoutSec?: number },
    ): Promise<ReviewSignal> {
        const result = await pollUntil(
            async () => {
                const resp = await http<{ values: BitbucketComment[] }>(
                    `${this.apiBase}/repositories/${this.workspaceSlug}/pullrequests/${pr.number}/comments?pagelen=50&sort=-created_on`,
                    { headers: this.headers() },
                );
                ensureOk(resp, "bitbucket:pollForReview");
                const filtered = (resp.body.values ?? []).filter((c) => {
                    if (c.created_on <= opts.sinceIso) return false;
                    if (opts.triggerId && String(c.id) === opts.triggerId) return false;
                    const raw = c.content?.raw ?? "";
                    if (raw.toLowerCase().startsWith("@kody")) return false;
                    // Drop "Started!" placeholder but keep "Complete!" — the
                    // latter is a valid mechanics signal even when Kody
                    // found no inline findings.
                    if (
                        raw.includes("<!-- kody-codereview") &&
                        !raw.includes("kody-codereview-completed")
                    ) {
                        return false;
                    }
                    return true;
                });
                if (filtered.length) {
                    return {
                        reviewComments: filtered.length,
                        issueComments: 0,
                        reviews: 0,
                        sample: (filtered[0]?.content?.raw ?? "").slice(0, 240),
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
        const resp = await http<BitbucketComment>(
            `${this.apiBase}/repositories/${this.workspaceSlug}/pullrequests/${prNumber}/comments`,
            {
                method: "POST",
                headers: this.headers(),
                body: { content: { raw: body } },
            },
        );
        ensureOk(resp, "bitbucket:postComment");
        return { id: String(resp.body.id) };
    }

    authMode(): "app-password" {
        return "app-password";
    }

    authToken(): string {
        return this.appPassword;
    }
}
