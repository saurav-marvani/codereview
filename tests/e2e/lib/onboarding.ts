import type {
    KodusSession,
    Provider,
    ProviderRepoRef,
    TargetContext,
    TenantCredentials,
} from "./types.js";
import { ensureOk, http } from "./http.js";
import { logger } from "./log.js";

const log = logger("onboarding");

interface LoginEnvelope {
    data?: { accessToken?: string };
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
    const segments = jwt.split(".");
    if (segments.length < 2) throw new Error("invalid JWT");
    const padded = segments[1] + "=".repeat((4 - (segments[1].length % 4)) % 4);
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    try {
        return JSON.parse(decoded) as Record<string, unknown>;
    } catch (err) {
        throw new Error(`Could not decode JWT payload: ${(err as Error).message}`);
    }
}

// Signs up a fresh Kodus tenant. Used by smoke/matrix runs against
// self-hosted droplets so every (provider × target) cell starts with a
// virgin organization — no leftover integrations, repos, or rules from
// previous cells. Without this, re-running the matrix against the same
// droplet would re-use whichever tenant happened to onboard first, and
// `getTypeIntegration` (which doesn't filter by platform) would route
// dispatches to whatever provider was registered first — silently
// breaking every subsequent provider's webhook auto-register flow.
export async function signUp(
    target: TargetContext,
    creds: { email: string; password: string; name?: string },
): Promise<void> {
    log.info(`Signing up fresh tenant ${creds.email}`);
    // Kodus's API has been spelled both `/auth/signUp` (camelCase) and
    // `/auth/signup` (lowercase) at different versions — try the canonical
    // form first, fall back to the lowercase variant on a 404.
    let resp = await http(`${target.apiBaseUrl}/auth/signUp`, {
        method: "POST",
        body: {
            name: creds.name ?? `e2e-${Date.now()}`,
            email: creds.email,
            password: creds.password,
        },
        timeoutMs: 30_000,
    });
    if (resp.status === 404) {
        resp = await http(`${target.apiBaseUrl}/auth/signup`, {
            method: "POST",
            body: {
                name: creds.name ?? `e2e-${Date.now()}`,
                email: creds.email,
                password: creds.password,
            },
            timeoutMs: 30_000,
        });
    }
    ensureOk(resp, "onboarding:signUp");
    log.ok(`Tenant ${creds.email} created`);
}

export async function login(
    target: TargetContext,
    creds: TenantCredentials,
): Promise<KodusSession> {
    log.info(`Logging in as ${creds.email} via ${target.apiBaseUrl}`);
    const resp = await http<LoginEnvelope>(
        `${target.apiBaseUrl}/auth/login`,
        {
            method: "POST",
            body: { email: creds.email, password: creds.password },
            timeoutMs: 20_000,
        },
    );
    ensureOk(resp, "onboarding:login");
    const accessToken = resp.body.data?.accessToken;
    if (!accessToken) {
        throw new Error(
            `Login response missing accessToken: ${resp.raw.slice(0, 400)}`,
        );
    }
    const payload = decodeJwtPayload(accessToken);
    const organizationId = String(payload.organizationId ?? "");
    if (!organizationId) {
        throw new Error("JWT payload missing organizationId");
    }
    const teamsResp = await http<{ data: { uuid: string }[] }>(
        `${target.apiBaseUrl}/team/`,
        {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeoutMs: 15_000,
        },
    );
    ensureOk(teamsResp, "onboarding:listTeams");
    const teamId = teamsResp.body.data?.[0]?.uuid;
    if (!teamId) {
        throw new Error("No team found for the logged-in user");
    }
    log.ok(`org=${organizationId} team=${teamId}`);
    return { accessToken, organizationId, teamId };
}

export async function registerIntegration(
    target: TargetContext,
    provider: Provider,
    session: KodusSession,
): Promise<void> {
    log.info(`Registering ${provider.integrationType} integration`);
    const resp = await http<{ data: { status?: string } }>(
        `${target.apiBaseUrl}/code-management/auth-integration`,
        {
            method: "POST",
            headers: { Authorization: `Bearer ${session.accessToken}` },
            body: {
                integrationType: provider.integrationType,
                authMode: provider.authMode(),
                token: provider.authToken(),
                organizationAndTeamData: {
                    organizationId: session.organizationId,
                    teamId: session.teamId,
                },
            },
            timeoutMs: 30_000,
        },
    );
    ensureOk(resp, "onboarding:registerIntegration");
    if (resp.body.data?.status !== "SUCCESS") {
        throw new Error(
            `auth-integration did not return SUCCESS: ${resp.raw.slice(0, 400)}`,
        );
    }
}

export async function registerRepo(
    target: TargetContext,
    provider: Provider,
    session: KodusSession,
): Promise<ProviderRepoRef> {
    const repoRef = await provider.repoRef();
    log.info(`Looking up ${repoRef.full_name} in available repos`);
    const listResp = await http<{
        data: { full_name: string; id: string | number; name?: string }[];
    }>(
        `${target.apiBaseUrl}/code-management/repositories/org?teamId=${encodeURIComponent(session.teamId)}`,
        {
            headers: { Authorization: `Bearer ${session.accessToken}` },
            timeoutMs: 30_000,
        },
    );
    ensureOk(listResp, "onboarding:listRepos");
    const found =
        listResp.body.data?.find((r) => r.full_name === repoRef.full_name) ??
        listResp.body.data?.find((r) => String(r.id) === String(repoRef.id));
    if (!found) {
        throw new Error(
            `Repo ${repoRef.full_name} not in integration's available list`,
        );
    }
    const registerResp = await http<{ data: { status: boolean } }>(
        `${target.apiBaseUrl}/code-management/repositories`,
        {
            method: "POST",
            headers: { Authorization: `Bearer ${session.accessToken}` },
            body: {
                teamId: session.teamId,
                type: "replace",
                repositories: [found],
            },
            timeoutMs: 30_000,
        },
    );
    ensureOk(registerResp, "onboarding:registerRepo");
    if (!registerResp.body.data?.status) {
        throw new Error(
            `Repo registration failed: ${registerResp.raw.slice(0, 400)}`,
        );
    }
    log.ok(`Repo ${found.full_name} registered`);
    return found;
}

export async function finishOnboarding(
    target: TargetContext,
    session: KodusSession,
    repo: ProviderRepoRef,
): Promise<void> {
    log.info("Finishing onboarding");
    const resp = await http(
        `${target.apiBaseUrl}/code-management/finish-onboarding`,
        {
            method: "POST",
            headers: { Authorization: `Bearer ${session.accessToken}` },
            body: {
                teamId: session.teamId,
                reviewPR: false,
                repositoryId: String(repo.id),
                repositoryName: repo.name ?? repo.full_name,
            },
            timeoutMs: 30_000,
        },
    );
    ensureOk(resp, "onboarding:finishOnboarding");
}
