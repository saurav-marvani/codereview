import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
    LicenseMode,
    MatrixCell,
    Scenario,
    ScenarioResult,
    ScenarioStatus,
    Target,
    TargetContext,
    TenantCredentials,
} from "./types.js";
import { makeProvider } from "../providers/index.js";
import {
    finishOnboarding,
    login,
    registerIntegration,
    registerRepo,
    signUp,
} from "./onboarding.js";
import { randomBytes } from "node:crypto";
import { logger } from "./log.js";

const log = logger("runner");

export interface RunOptions {
    artifactRoot: string;
    runId: string;
    target: Target;
    cells: MatrixCell[];
    scenarios: Scenario[];
    failFast?: boolean;
    dryRun?: boolean;
}

export interface RunOutcome {
    runId: string;
    startedAt: string;
    finishedAt: string;
    results: ScenarioResult[];
}

function appliesToCell(scenario: Scenario, cell: MatrixCell): boolean {
    const at = scenario.appliesTo;
    if (at.target && !at.target.includes(cell.target)) return false;
    if (at.provider && !at.provider.includes(cell.provider)) return false;
    if (at.license && !at.license.includes(cell.license)) return false;
    return true;
}

function envForTarget(target: Target): TargetContext {
    if (target === "cloud") {
        const apiBaseUrl =
            process.env.TARGET_BASE_URL ??
            process.env.CLOUD_API_BASE_URL ??
            "https://api-qa.kodus.io";
        const webBaseUrl =
            process.env.TARGET_WEB_URL ??
            process.env.CLOUD_WEB_BASE_URL ??
            "https://app-qa.kodus.io";
        return { target, apiBaseUrl, webBaseUrl };
    }
    const apiBaseUrl =
        process.env.TARGET_BASE_URL ??
        (() => {
            throw new Error(
                "TARGET_BASE_URL is required for self-hosted target (e.g. http://1.2.3.4:3001)",
            );
        })();
    const webBaseUrl =
        process.env.TARGET_WEB_URL ?? apiBaseUrl.replace(/:3001$/, ":3000");
    const tunnelUrl = process.env.TARGET_TUNNEL_URL;
    if (!tunnelUrl) {
        throw new Error(
            "TARGET_TUNNEL_URL is required for self-hosted target (e.g. https://xxx.trycloudflare.com)",
        );
    }
    return { target, apiBaseUrl, webBaseUrl, tunnelUrl };
}

// Resolves tenant credentials for a cell.
//
// `cloud`: pre-provisioned tenants per license tier (free/trial/paid)
// because the cloud control plane wires each tier into Stripe and we
// can't reproduce that from the test runner. The env vars are seeded by
// run.sh from `~/.kodus-dev/config` (or 1Password refs).
//
// `self-hosted`: ALWAYS sign up a fresh tenant per cell. Re-using a
// single tenant across cells leaves stale integration records (e.g. a
// GitHub integration from a previous cell), and Kodus's
// `getTypeIntegration` returns the first match by category — not by
// platform — so dispatches end up routed to whichever provider
// happened to onboard first, silently breaking webhook auto-register
// for every subsequent provider in the same matrix run. Fresh signup
// avoids the contamination entirely. The signup endpoint is wide open
// on self-hosted (no email verification), so this costs only one extra
// API call per cell.
async function resolveTenantForCell(
    target: TargetContext,
    license: LicenseMode,
): Promise<TenantCredentials | undefined> {
    if (target.target === "cloud") {
        const map: Record<string, [string, string] | undefined> = {
            free: ["CLOUD_TENANT_FREE_EMAIL", "CLOUD_TENANT_FREE_PASSWORD"],
            trial: ["CLOUD_TENANT_TRIAL_EMAIL", "CLOUD_TENANT_TRIAL_PASSWORD"],
            paid: ["CLOUD_TENANT_PAID_EMAIL", "CLOUD_TENANT_PAID_PASSWORD"],
        };
        const key = map[license];
        if (!key) return undefined;
        const email = process.env[key[0]];
        const password = process.env[key[1]];
        if (!email || !password) return undefined;
        return { email, password };
    }
    // self-hosted: sign up a virgin tenant per cell.
    const suffix = randomBytes(4).toString("hex");
    const email = `e2e-${suffix}-${Date.now()}@kodus.local`;
    const password = `E2eTest!${randomBytes(8).toString("hex")}`;
    await signUp(target, { email, password });
    return { email, password };
}

export async function runMatrix(opts: RunOptions): Promise<RunOutcome> {
    const startedAt = new Date().toISOString();
    const results: ScenarioResult[] = [];
    const artifactDir = join(opts.artifactRoot, opts.runId);
    mkdirSync(artifactDir, { recursive: true });

    for (const cell of opts.cells) {
        if (cell.target !== opts.target) continue;

        const target = opts.dryRun
            ? {
                  target: cell.target,
                  apiBaseUrl: "https://dry-run.invalid",
                  webBaseUrl: "https://dry-run.invalid",
                  tunnelUrl: "https://dry-run.invalid",
              }
            : envForTarget(cell.target);
        const tenant = opts.dryRun
            ? { email: "dry-run@kodus.test", password: "dry-run" }
            : await resolveTenantForCell(target, cell.license);

        for (const scenario of opts.scenarios) {
            const cellLabel = `${scenario.id} × ${cell.target} × ${cell.provider} × ${cell.license}`;

            if (!appliesToCell(scenario, cell)) {
                log.info(`SKIP  ${cellLabel}`);
                results.push(makeResult(scenario, cell, "skipped", 0, {}));
                continue;
            }

            if (opts.dryRun) {
                log.info(`DRY   ${cellLabel}`);
                results.push(
                    makeResult(scenario, cell, "passed", 0, {
                        dryRun: true,
                        wouldRun: true,
                        scenarioTitle: scenario.title,
                    }),
                );
                continue;
            }

            log.info(`RUN   ${cellLabel}`);
            const t0 = Date.now();
            try {
                const provider = makeProvider(cell.provider);
                const scenarioArtifactDir = join(
                    artifactDir,
                    `${scenario.id}-${cell.target}-${cell.provider}-${cell.license}`,
                );
                mkdirSync(scenarioArtifactDir, { recursive: true });

                const evidence = await scenario.run({
                    target,
                    provider,
                    license: cell.license,
                    tenant,
                    kodus: {
                        login: (creds) => login(target, creds),
                        registerIntegration: (session) =>
                            registerIntegration(target, provider, session),
                        registerRepo: (session) =>
                            registerRepo(target, provider, session),
                        finishOnboarding: (session, repo) =>
                            finishOnboarding(target, session, repo),
                    },
                    assert: (cond, msg) => {
                        if (!cond) throw new Error(`Assertion failed: ${msg}`);
                    },
                    artifactDir: scenarioArtifactDir,
                    runId: opts.runId,
                });

                const duration = Date.now() - t0;
                log.ok(`PASS  ${cellLabel}  (${(duration / 1000).toFixed(1)}s)`);
                results.push(
                    makeResult(scenario, cell, "passed", duration, evidence),
                );
            } catch (err) {
                const duration = Date.now() - t0;
                const e = err as Error;
                log.err(`FAIL  ${cellLabel}: ${e.message}`);
                results.push(
                    makeResult(
                        scenario,
                        cell,
                        "failed",
                        duration,
                        {},
                        e.message,
                        e.stack,
                    ),
                );
                if (opts.failFast) break;
            }
        }
    }

    return {
        runId: opts.runId,
        startedAt,
        finishedAt: new Date().toISOString(),
        results,
    };
}

function makeResult(
    scenario: Scenario,
    cell: MatrixCell,
    status: ScenarioStatus,
    durationMs: number,
    evidence: Record<string, unknown>,
    errorMessage?: string,
    errorStack?: string,
): ScenarioResult {
    const now = new Date().toISOString();
    return {
        scenarioId: scenario.id,
        cell,
        status,
        durationMs,
        evidence,
        errorMessage,
        errorStack,
        startedAt: now,
        finishedAt: now,
    };
}
