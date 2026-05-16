export type Target = "cloud" | "self-hosted";

export type ProviderName = "github" | "gitlab" | "bitbucket" | "azure-devops";

export type LicenseMode =
    | "free"
    | "trial"
    | "paid"
    | "license-paid"
    | "license-free";

export type Priority = "P0" | "P1" | "P2";

export interface TargetContext {
    target: Target;
    apiBaseUrl: string;
    webBaseUrl: string;
    tunnelUrl?: string;
}

export interface ProviderRepoRef {
    full_name: string;
    id: string | number;
    name?: string;
}

export interface OpenPRArgs {
    branch: string;
    title: string;
    body: string;
    fixtureFiles: Record<string, string>;
    baseBranch?: string;
}

// For test repos that already have head/base branch pairs with deliberate
// diffs committed (e.g. the forked benchmark repos in the kodus-e2e org).
// No clone, no push — just opens a PR between two existing branches. Each
// call creates a fresh PR number, so the `validate-new-commits` pipeline
// stage always treats it as a new review (unlike re-triggering on a
// standing PR, which gets short-circuited as "already reviewed").
export interface OpenPRFromBranchesArgs {
    head: string;
    base: string;
    title: string;
    body: string;
}

export interface OpenedPR {
    number: number;
    url: string;
    branch: string;
    baseBranch: string;
    // When true, `closePR` only closes the PR and does NOT delete the head
    // branch. Used by `openPRFromBranches` where the branch is a permanent
    // fixture in the test repo, not something the scenario created.
    keepBranchOnClose?: boolean;
}

export interface ReviewSignal {
    reviewComments: number;
    issueComments: number;
    reviews: number;
    sample?: string;
}

export interface Provider {
    readonly name: ProviderName;
    readonly integrationType: string;
    readonly webhookPath: string;
    repoRef(): Promise<ProviderRepoRef>;
    createWebhook(webhookUrl: string): Promise<{ id: string }>;
    deleteWebhook(id: string): Promise<void>;
    openPR(args: OpenPRArgs): Promise<OpenedPR>;
    // Optional: opens a PR using two already-existing branches (head/base)
    // without cloning or pushing. Providers that don't implement this throw
    // a clear "not supported" error. See `OpenPRFromBranchesArgs` for the
    // motivation (avoid `validate-new-commits` skip on standing PRs).
    openPRFromBranches?(args: OpenPRFromBranchesArgs): Promise<OpenedPR>;
    closePR(pr: OpenedPR): Promise<void>;
    triggerReviewOnExistingPR(prNumber: number): Promise<{
        triggerId: string;
        sinceIso: string;
    }>;
    pollForReview(
        pr: { number: number },
        opts: { sinceIso: string; triggerId?: string; timeoutSec?: number },
    ): Promise<ReviewSignal>;
    postComment(prNumber: number, body: string): Promise<{ id: string }>;
    authMode(): "token" | "oauth" | "app-password";
    authToken(): string;
}

export interface TenantCredentials {
    email: string;
    password: string;
}

export interface KodusSession {
    accessToken: string;
    organizationId: string;
    teamId: string;
}

export interface RunContext {
    target: TargetContext;
    provider: Provider;
    license: LicenseMode;
    tenant?: TenantCredentials;
    kodus: {
        login: (creds: TenantCredentials) => Promise<KodusSession>;
        registerIntegration: (session: KodusSession) => Promise<void>;
        registerRepo: (session: KodusSession) => Promise<ProviderRepoRef>;
        finishOnboarding: (
            session: KodusSession,
            repo: ProviderRepoRef,
        ) => Promise<void>;
    };
    assert: (cond: unknown, msg: string) => asserts cond;
    artifactDir: string;
    runId: string;
}

export type ScenarioStatus =
    | "passed"
    | "failed"
    | "skipped"
    | "blocked";

export interface ScenarioResult {
    scenarioId: string;
    cell: {
        target: Target;
        provider: ProviderName;
        license: LicenseMode;
    };
    status: ScenarioStatus;
    durationMs: number;
    evidence: Record<string, unknown>;
    errorMessage?: string;
    errorStack?: string;
    startedAt: string;
    finishedAt: string;
}

export interface ScenarioAppliesTo {
    target?: Target[];
    provider?: ProviderName[];
    license?: LicenseMode[];
}

export interface Scenario {
    id: string;
    title: string;
    priority: Priority;
    appliesTo: ScenarioAppliesTo;
    timeoutSec?: number;
    run: (ctx: RunContext) => Promise<Record<string, unknown>>;
}

export interface MatrixCell {
    target: Target;
    provider: ProviderName;
    license: LicenseMode;
}

export interface MatrixConfig {
    id: string;
    description?: string;
    scenarios: string[];
    cells: MatrixCell[];
}
