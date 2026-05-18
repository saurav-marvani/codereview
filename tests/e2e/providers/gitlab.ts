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

interface GitLabNote {
    id: number;
    body: string;
    created_at: string;
    author: { id: number; username: string };
    system: boolean;
}

export class GitLabProvider extends BaseProvider {
    readonly name: ProviderName = "gitlab";
    readonly integrationType = "GITLAB";
    readonly webhookPath = "/gitlab/webhook";

    private readonly token: string;
    private readonly projectPath: string;
    private readonly host: string;
    private readonly apiBase: string;
    private projectId?: number;
    private readonly existingMrIid?: number;

    constructor() {
        super();
        this.token = requireEnv("GL_TEST_TOKEN");
        this.projectPath = requireEnv("GL_TEST_REPO");
        this.host = process.env.GL_HOST ?? "https://gitlab.com";
        this.apiBase = `${this.host}/api/v4`;
        const existing = process.env.GL_TEST_MR_IID;
        if (existing) this.existingMrIid = Number(existing);
    }

    private headers(): Record<string, string> {
        return {
            "PRIVATE-TOKEN": this.token,
        };
    }

    private cloneUrl(): string {
        const hostNoScheme = this.host.replace(/^https?:\/\//, "");
        return `https://oauth2:${this.token}@${hostNoScheme}/${this.projectPath}.git`;
    }

    private async resolveProjectId(): Promise<number> {
        if (this.projectId) return this.projectId;
        const encoded = encodeURIComponent(this.projectPath);
        const resp = await http<{ id: number }>(
            `${this.apiBase}/projects/${encoded}`,
            { headers: this.headers() },
        );
        ensureOk(resp, "gitlab:resolveProjectId");
        this.projectId = resp.body.id;
        return this.projectId;
    }

    async repoRef(): Promise<ProviderRepoRef> {
        const id = await this.resolveProjectId();
        return {
            id,
            full_name: this.projectPath,
            name: this.projectPath.split("/").pop() ?? this.projectPath,
        };
    }

    async createWebhook(webhookUrl: string): Promise<{ id: string }> {
        const id = await this.resolveProjectId();
        const resp = await http<{ id: number }>(
            `${this.apiBase}/projects/${id}/hooks`,
            {
                method: "POST",
                headers: this.headers(),
                body: {
                    url: webhookUrl,
                    push_events: true,
                    merge_requests_events: true,
                    note_events: true,
                    pipeline_events: false,
                    enable_ssl_verification: true,
                },
            },
        );
        ensureOk(resp, "gitlab:createWebhook");
        return { id: String(resp.body.id) };
    }

    async deleteWebhook(id: string): Promise<void> {
        const projectId = await this.resolveProjectId();
        await http(
            `${this.apiBase}/projects/${projectId}/hooks/${id}`,
            { method: "DELETE", headers: this.headers() },
        );
    }

    async listWebhooks(): Promise<WebhookInfo[]> {
        const projectId = await this.resolveProjectId();
        // GitLab hooks API returns one bool field per event type (e.g.,
        // `merge_requests_events: true`) rather than an `events: []` array
        // like GitHub. We normalize back to a flat string[] so callers don't
        // have to special-case per provider.
        const resp = await http<
            Array<{
                id: number;
                url: string;
                push_events?: boolean;
                merge_requests_events?: boolean;
                note_events?: boolean;
                issues_events?: boolean;
                pipeline_events?: boolean;
                tag_push_events?: boolean;
                wiki_page_events?: boolean;
                deployment_events?: boolean;
                releases_events?: boolean;
                // Field is sent as `disabled_until` (truthy = inactive) or
                // omitted/null when active. There's no explicit `active` flag.
                disabled_until?: string | null;
            }>
        >(`${this.apiBase}/projects/${projectId}/hooks?per_page=100`, {
            headers: this.headers(),
        });
        ensureOk(resp, "gitlab:listWebhooks");
        const eventFlags: Array<
            [keyof (typeof resp.body)[number], string]
        > = [
            ["push_events", "push"],
            ["merge_requests_events", "merge_request"],
            ["note_events", "note"],
            ["issues_events", "issue"],
            ["pipeline_events", "pipeline"],
            ["tag_push_events", "tag_push"],
            ["wiki_page_events", "wiki_page"],
            ["deployment_events", "deployment"],
            ["releases_events", "release"],
        ];
        return (resp.body ?? []).map((h) => ({
            id: String(h.id),
            url: h.url ?? "",
            active: !h.disabled_until,
            events: eventFlags
                .filter(([k]) => Boolean(h[k]))
                .map(([, name]) => name),
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
            const projectId = await this.resolveProjectId();
            const resp = await http<{ iid: number; web_url: string }>(
                `${this.apiBase}/projects/${projectId}/merge_requests`,
                {
                    method: "POST",
                    headers: this.headers(),
                    body: {
                        source_branch: args.branch,
                        target_branch: prepared.baseBranch,
                        title: args.title,
                        description: args.body,
                        remove_source_branch: true,
                    },
                },
            );
            ensureOk(resp, "gitlab:openPR");
            return {
                number: resp.body.iid,
                url: resp.body.web_url,
                branch: args.branch,
                baseBranch: prepared.baseBranch,
            };
        } finally {
            prepared.cleanup();
        }
    }

    async openPRFromBranches(args: OpenPRFromBranchesArgs): Promise<OpenedPR> {
        const projectId = await this.resolveProjectId();
        const resp = await http<{ iid: number; web_url: string }>(
            `${this.apiBase}/projects/${projectId}/merge_requests`,
            {
                method: "POST",
                headers: this.headers(),
                body: {
                    source_branch: args.head,
                    target_branch: args.base,
                    title: args.title,
                    description: args.body,
                    // Don't auto-delete the source branch — it's a persistent
                    // fixture branch, not something we just pushed.
                    remove_source_branch: false,
                },
            },
        );
        ensureOk(resp, "gitlab:openPRFromBranches");
        return {
            number: resp.body.iid,
            url: resp.body.web_url,
            branch: args.head,
            baseBranch: args.base,
            keepBranchOnClose: true,
        };
    }

    async closePR(pr: OpenedPR): Promise<void> {
        const projectId = await this.resolveProjectId();
        await http(
            `${this.apiBase}/projects/${projectId}/merge_requests/${pr.number}`,
            {
                method: "PUT",
                headers: this.headers(),
                body: { state_event: "close" },
            },
        );
        // GitLab's `closePR` doesn't delete the source branch by default —
        // remove_source_branch on the original PR controls that on merge.
        // For our close-without-merge path, there's nothing extra to do
        // even when keepBranchOnClose is false.
    }

    async triggerReviewOnExistingPR(
        prNumber: number,
    ): Promise<{ triggerId: string; sinceIso: string }> {
        const projectId = await this.resolveProjectId();
        const target = prNumber || this.existingMrIid;
        if (!target) throw new Error("gitlab:triggerReview requires GL_TEST_MR_IID");
        const resp = await http<GitLabNote>(
            `${this.apiBase}/projects/${projectId}/merge_requests/${target}/notes`,
            {
                method: "POST",
                headers: this.headers(),
                body: { body: "@kody review" },
            },
        );
        ensureOk(resp, "gitlab:triggerReview");
        return {
            triggerId: String(resp.body.id),
            sinceIso: resp.body.created_at,
        };
    }

    async pollForReview(
        pr: { number: number },
        opts: { sinceIso: string; triggerId?: string; timeoutSec?: number },
    ): Promise<ReviewSignal> {
        const projectId = await this.resolveProjectId();
        const result = await pollUntil(
            async () => {
                const resp = await http<GitLabNote[]>(
                    `${this.apiBase}/projects/${projectId}/merge_requests/${pr.number}/notes?per_page=100&sort=desc&order_by=updated_at`,
                    { headers: this.headers() },
                );
                ensureOk(resp, "gitlab:pollForReview");
                const filtered = (resp.body ?? []).filter((n) => {
                    if (n.system) return false;
                    if (n.created_at <= opts.sinceIso) return false;
                    if (opts.triggerId && String(n.id) === opts.triggerId) return false;
                    const body = n.body ?? "";
                    if (body.toLowerCase().startsWith("@kody")) return false;
                    // Drop "Started!" placeholder but keep "Complete!" — the
                    // latter is a valid mechanics signal even when Kody
                    // found no inline findings.
                    if (
                        body.includes("<!-- kody-codereview") &&
                        !body.includes("kody-codereview-completed")
                    ) {
                        return false;
                    }
                    return true;
                });
                if (filtered.length) {
                    return {
                        reviewComments: 0,
                        issueComments: filtered.length,
                        reviews: 0,
                        sample: (filtered[0]?.body ?? "").slice(0, 240),
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
        const projectId = await this.resolveProjectId();
        const resp = await http<{ id: number }>(
            `${this.apiBase}/projects/${projectId}/merge_requests/${prNumber}/notes`,
            {
                method: "POST",
                headers: this.headers(),
                body: { body },
            },
        );
        ensureOk(resp, "gitlab:postComment");
        return { id: String(resp.body.id) };
    }

    authMode(): "token" {
        return "token";
    }

    authToken(): string {
        return this.token;
    }
}
