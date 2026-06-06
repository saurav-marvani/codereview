// undici (Node's built-in fetch) ships a `headersTimeout` of 300_000ms.
// It fires INDEPENDENT of our AbortSignal — when Kodus's slow endpoints
// (e.g. Bitbucket `finish-onboarding` regularly takes 3–5 minutes while
// it clones, generates rules, and round-trips an LLM) don't send the
// first response byte by 5 minutes, the connection is killed with
// `TypeError: fetch failed` and the test sees a flaky network error.
//
// Install a custom undici Dispatcher with longer header/body timeouts on
// the global dispatcher so every `fetch` call in the test runner uses it.
// The bound is high enough (10 minutes) that legitimate hangs still
// surface, but well above the worst-case real onboarding latency we've
// measured.
import { Agent, setGlobalDispatcher } from "undici";
import { logger } from "./log.js";

const log = logger("http");

const TEN_MINUTES_MS = 10 * 60 * 1000;
setGlobalDispatcher(
    new Agent({
        headersTimeout: TEN_MINUTES_MS,
        bodyTimeout: TEN_MINUTES_MS,
    }),
);

export interface HttpOptions {
    method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
    headers?: Record<string, string>;
    body?: unknown;
    timeoutMs?: number;
    // "manual" surfaces 3xx responses instead of following them — needed
    // by callers that assert ON the redirect itself (e.g. the RBAC route
    // guard checking for a /forbidden Location). Default: fetch's "follow".
    redirect?: "follow" | "manual";
}

export interface HttpResponse<T = unknown> {
    status: number;
    headers: Headers;
    body: T;
    raw: string;
}

// AWS WAF on the QA ALB intermittently blocks GitHub-hosted runner IPs
// (shared pool → some land on the IP-reputation/rate rules), 403-ing the
// ENTIRE run. The WAF carries an Allow rule keyed on this secret header;
// inject it on every request bound for a `qa.*.kodus.io` host — and ONLY
// those: the secret must never reach github.com/gitlab.com/etc. No-op when
// QA_WAF_BYPASS_HEADER is unset (local runs, forks).
export function wafBypassHeader(url: string): Record<string, string> {
    const secret = process.env.QA_WAF_BYPASS_HEADER;
    if (!secret) return {};
    try {
        const host = new URL(url).hostname;
        if (/^qa\.([a-z0-9-]+\.)*kodus\.io$/i.test(host)) {
            return { "x-kodus-e2e": secret };
        }
    } catch {
        // unparsable URL → fetch() will fail with its own error anyway
    }
    return {};
}

// Internal: one attempt of the actual fetch. Extracted so the retry
// branch below can re-issue without duplicating the (mildly tedious)
// AbortController + body-encoding + content-type ceremony.
async function attempt<T>(
    url: string,
    opts: HttpOptions,
    timeoutMs: number,
): Promise<HttpResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const init: RequestInit = {
        method: opts.method ?? "GET",
        headers: { ...(opts.headers ?? {}), ...wafBypassHeader(url) },
        signal: controller.signal,
        ...(opts.redirect ? { redirect: opts.redirect } : {}),
    };
    if (opts.body !== undefined && opts.body !== null) {
        init.body =
            typeof opts.body === "string"
                ? opts.body
                : JSON.stringify(opts.body);
        if (
            typeof init.body === "string" &&
            !(opts.headers && Object.keys(opts.headers).some((k) => k.toLowerCase() === "content-type"))
        ) {
            init.headers = {
                ...(init.headers as Record<string, string>),
                "Content-Type": "application/json",
            };
        }
    }

    try {
        const resp = await fetch(url, init);
        const raw = await resp.text();
        let body: unknown = raw;
        const ct = resp.headers.get("content-type") ?? "";
        if (ct.includes("application/json") && raw.length > 0) {
            try {
                body = JSON.parse(raw);
            } catch {
                /* leave raw */
            }
        }
        return {
            status: resp.status,
            headers: resp.headers,
            body: body as T,
            raw,
        };
    } finally {
        clearTimeout(timer);
    }
}

// Heuristic for "transport failed, retry might help" — distinct from
// "server returned 5xx" (which the caller's `ensureOk` decides). We
// only retry on errors thrown BEFORE we get an HTTP status: undici's
// `TypeError: fetch failed`, plain network reset, AbortError fired by
// our own timer (the request never completed). HTTP 5xx is excluded
// here because the caller may legitimately want to surface it without
// silent retry side effects (e.g. registration that's idempotent on
// pure transport, but not on 5xx-after-partial-write).
function isTransportError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message ?? "";
    return (
        err.name === "TypeError" && msg === "fetch failed"
    ) || (
        err.name === "AbortError"
    ) || /ECONNRESET|EPIPE|ETIMEDOUT|socket hang up/i.test(msg);
}

// Transport-error retry budget. A freshly-provisioned self-hosted droplet
// can take several seconds AFTER the `api up` healthcheck before undici can
// actually open a keep-alive socket to :3001 — the NestJS app finishes
// wiring routes, the kernel finishes accepting on the published port, and
// the first cross-host connection sometimes resets. We observed (2026-05-29,
// bitbucket cell) ALL 6 scenarios fail with `fetch failed` in a 9s window
// while a sibling github cell on its own droplet passed — pure transport
// flakiness, not an app or test bug. A single 1s retry didn't cover it.
//
// Exponential backoff (1s, 2s, 4s, 8s, 16s → ~31s total) absorbs that
// window without masking real failures: a 4xx/5xx is NOT a transport error
// and throws immediately via ensureOk downstream, so a genuinely-broken
// endpoint still fails fast. Only `fetch failed` / ECONNRESET / AbortError
// get retried.
const TRANSPORT_RETRIES = 5;

// HTTP 429 retry budget. Bitbucket Cloud rate-limits the shared test account
// hard: the runner's pollForReview loop (one list-comments call every 10s for
// up to 10min) plus the review worker's own Bitbucket calls overrun the
// per-account quota and Bitbucket returns 429 with a Retry-After header. A
// single 429 also cascades — the next scenario's PAT re-validation goes
// through Kodus to Bitbucket and comes back as 400 "Error authenticating".
// Honouring Retry-After here makes the whole thing deterministic: we wait
// exactly as long as Bitbucket asks (capped) and retry, so no rate-limit
// blip ever surfaces as a test failure. Applies to every provider but only
// Bitbucket realistically hits it.
const RATE_LIMIT_RETRIES = 6;
const RETRY_AFTER_CAP_MS = 60_000;

function retryAfterMs(resp: HttpResponse<unknown>, attempt: number): number {
    const header = resp.headers.get("retry-after");
    if (header) {
        const secs = Number(header);
        if (Number.isFinite(secs) && secs >= 0) {
            return Math.min(secs * 1_000, RETRY_AFTER_CAP_MS);
        }
    }
    // No/!numeric header → exponential backoff 2s,4s,8s… capped.
    return Math.min(2_000 * 2 ** attempt, RETRY_AFTER_CAP_MS);
}

export async function http<T = unknown>(
    url: string,
    opts: HttpOptions = {},
): Promise<HttpResponse<T>> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    let lastErr: unknown;
    let rateLimitHits = 0;
    for (let i = 0; i <= TRANSPORT_RETRIES; i++) {
        try {
            const resp = await attempt<T>(url, opts, timeoutMs);
            // 429 isn't an exception — it's a valid response we choose to
            // retry. Don't count it against the transport budget.
            if (resp.status === 429 && rateLimitHits < RATE_LIMIT_RETRIES) {
                const delay = retryAfterMs(resp, rateLimitHits);
                rateLimitHits++;
                log.info(
                    `[http] 429 on ${opts.method ?? "GET"} ${url} (rate-limit ${rateLimitHits}/${RATE_LIMIT_RETRIES}) — waiting ${delay}ms`,
                );
                await new Promise((r) => setTimeout(r, delay));
                i--; // this loop turn didn't consume a transport retry
                continue;
            }
            return resp;
        } catch (err) {
            if (!isTransportError(err)) {
                throw err;
            }
            lastErr = err;
            if (i === TRANSPORT_RETRIES) break;
            // 1s, 2s, 4s, 8s, 16s
            const delay = 1_000 * 2 ** i;
            log.info(
                `[http] transport error on ${opts.method ?? "GET"} ${url} (attempt ${i + 1}/${TRANSPORT_RETRIES + 1}) — retrying in ${delay}ms`,
            );
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

export function ensureOk<T>(
    resp: HttpResponse<T>,
    label: string,
): HttpResponse<T> {
    if (resp.status >= 200 && resp.status < 300) return resp;
    throw new Error(
        `${label}: HTTP ${resp.status}\n${resp.raw.slice(0, 500)}`,
    );
}
