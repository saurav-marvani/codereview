/**
 * Kodus API client. All requests go through the Next app's same-origin
 * proxy (`/api/proxy/api/*`), which injects the Auth.js bearer token —
 * this app never touches tokens. In dev, vite proxies `/api` to :3000.
 */
const API_PREFIX = "/api/proxy/api";

type Envelope<T> = { statusCode: number; data: T };

export class ApiError extends Error {
    constructor(
        public status: number,
        message: string,
    ) {
        super(message);
    }
}

async function request<T>(
    path: string,
    init?: RequestInit & { params?: Record<string, string | undefined> },
): Promise<T> {
    const { params, ...rest } = init ?? {};
    const query = params
        ? `?${new URLSearchParams(
              Object.entries(params).filter(
                  (entry): entry is [string, string] =>
                      entry[1] !== undefined,
              ),
          )}`
        : "";

    const response = await fetch(`${API_PREFIX}${path}${query}`, {
        credentials: "include",
        headers: {
            Accept: "application/json",
            ...(rest.body ? { "Content-Type": "application/json" } : {}),
            ...rest.headers,
        },
        ...rest,
    });

    if (!response.ok) {
        throw new ApiError(
            response.status,
            `${rest.method ?? "GET"} ${path} → ${response.status}`,
        );
    }

    const envelope = (await response.json()) as Envelope<T>;
    return envelope.data;
}

export const api = {
    get: <T>(path: string, params?: Record<string, string | undefined>) =>
        request<T>(path, { params }),
    post: <T>(path: string, body: unknown) =>
        request<T>(path, { method: "POST", body: JSON.stringify(body) }),
};

/** Selected team: same cookie the Next app writes, fallback to first team. */
const TEAM_COOKIE = "global-selected-team-id";

export function readSelectedTeamId(): string | null {
    const match = document.cookie.match(
        new RegExp(`(?:^|; )${TEAM_COOKIE}=([^;]*)`),
    );
    return match ? decodeURIComponent(match[1]) : null;
}

export type Team = { uuid: string; name: string; status: string };

export async function resolveTeamId(): Promise<string> {
    const fromCookie = readSelectedTeamId();
    if (fromCookie) return fromCookie;

    const teams = await api.get<Team[]>("/team");
    const active =
        teams.find((team) => team.status === "active") ?? teams[0];
    if (!active) throw new ApiError(404, "No team available");
    return active.uuid;
}
