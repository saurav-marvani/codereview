import type {
    Provider,
    ProviderName,
    OpenPRArgs,
    OpenedPR,
    ProviderRepoRef,
    ReviewSignal,
    WebhookInfo,
} from "../lib/types.js";

export interface ProviderConfig {
    name: ProviderName;
    apiBaseUrl: string;
    webBaseUrl?: string;
}

export abstract class BaseProvider implements Provider {
    abstract readonly name: ProviderName;
    abstract readonly integrationType: string;
    abstract readonly webhookPath: string;

    abstract repoRef(): Promise<ProviderRepoRef>;
    abstract createWebhook(webhookUrl: string): Promise<{ id: string }>;
    abstract deleteWebhook(id: string): Promise<void>;
    abstract listWebhooks(): Promise<WebhookInfo[]>;
    abstract openPR(args: OpenPRArgs): Promise<OpenedPR>;
    abstract closePR(pr: OpenedPR): Promise<void>;
    abstract triggerReviewOnExistingPR(prNumber: number): Promise<{
        triggerId: string;
        sinceIso: string;
    }>;
    abstract pollForReview(
        pr: { number: number },
        opts: { sinceIso: string; triggerId?: string; timeoutSec?: number },
    ): Promise<ReviewSignal>;
    abstract postComment(prNumber: number, body: string): Promise<{ id: string }>;
    abstract authMode(): "token" | "oauth" | "app-password";
    abstract authToken(): string;
}

export function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) {
        throw new Error(`Required env var ${name} is not set`);
    }
    return v;
}

export function nowIso(): string {
    return new Date().toISOString();
}

export async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PollOptions {
    timeoutSec: number;
    intervalSec: number;
}

export async function pollUntil<T>(
    fn: () => Promise<T | null>,
    opts: PollOptions,
): Promise<T | null> {
    const intervalSec = Number(
        process.env.E2E_POLL_INTERVAL_OVERRIDE_SEC ?? opts.intervalSec,
    );
    const timeoutSec = Number(
        process.env.E2E_POLL_TIMEOUT_OVERRIDE_SEC ?? opts.timeoutSec,
    );
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
        const result = await fn();
        if (result !== null) return result;
        await sleep(intervalSec * 1000);
    }
    return null;
}
