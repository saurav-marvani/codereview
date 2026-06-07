import { useQuery } from "@tanstack/react-query";

/**
 * Session comes from the Next app's Auth.js endpoint — same origin in prod
 * (path-routed), proxied to :3000 in dev. The strangler shares the cookie;
 * no second login system.
 */
export type Session = {
    user?: { name?: string; email?: string };
    expires?: string;
} | null;

export function useSession() {
    return useQuery<Session>({
        queryKey: ["session"],
        queryFn: async () => {
            const response = await fetch("/api/auth/session", {
                credentials: "include",
            });
            if (!response.ok) return null;
            const session = (await response.json()) as Session;
            return session && Object.keys(session).length > 0
                ? session
                : null;
        },
        staleTime: 60_000,
        retry: false,
    });
}
