// Benchmark FARM runner — orchestrates ONE benchmark run against ONE droplet.
//
// Unlike run.ts (tier-0, N models on the shared QA cloud tenant), this targets
// a per-run DROPLET running a branch's compiled engine, opens the full 50-PR
// dataset on a fresh per-run clone-set, waits for Kody to review each, collects
// findings, and writes results.json. The precision/recall judging is a separate
// post-step (scorecard.ts / judge.ts) driven by bench-run.sh.
//
// It deliberately MIRRORS run.ts's proven onboarding (cloud-mode: trial -> BYOK
// -> migrate-to-free -> finish-onboarding) instead of inventing a self-hosted
// path — the engine (libs/code-review) is identical across modes, so the droplet
// runs cloud-mode and reuses the validated gate dance. See bench-sync.sh, which
// builds the droplet with API_CLOUD_MODE=true.
//
// Inputs (env):
//   FARM_WEB_BASE_URL   the droplet's web URL, e.g. http://159.203.x.x:3000   (required)
//   FARM_RUN_ID         unique run id; the cloned repos are kodus-e2e/<base>-<run id>  (required)
//   FARM_MODEL_SLUG     which curated model BYOK to benchmark (default: the run's pinned model)
//   GH_TEST_TOKEN       GitHub token for opening PRs + reading findings (from ~/.kodus-dev/config)
//   BYOK_* / ANTHROPIC_API_KEY   pulled from ~/.kodus-dev/config if not already set
//
// Output: tests/e2e/benchmark/results-farm-<run id>.json
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { GitHubProvider } from "../providers/github.js";
import { login, signUp, registerIntegration, finishOnboarding, resetCodeReviewConfig } from "../lib/onboarding.js";
import { http, ensureOk } from "../lib/http.js";
import { logger } from "../lib/log.js";
import { loadTier0Models, type BenchModel } from "./models.js";
import { setByokConfig, testByok } from "./byok.js";
import type { TargetContext, KodusSession } from "../lib/types.js";

const log = logger("farm");

// --- target: the droplet (NOT QA) ---
const WEB = process.env.FARM_WEB_BASE_URL?.replace(/\/$/, "");
if (!WEB) throw new Error("FARM_WEB_BASE_URL not set (the droplet's web URL, e.g. http://<ip>:3000)");
const RUN_ID = process.env.FARM_RUN_ID;
if (!RUN_ID) throw new Error("FARM_RUN_ID not set");
const DROPLET: TargetContext = {
    target: "cloud", // cloud-mode topology (see header) — the droplet runs API_CLOUD_MODE=true
    apiBaseUrl: `${WEB}/api/proxy/api`,
    webBaseUrl: WEB,
};

interface BenchPR {
    repo: string; // source repo from the dataset (ai-code-review-benchmark/<base>)
    head: string;
    base: string;
    title: string;
    golden_comments: { comment: string; severity?: string }[];
}

// Pull BYOK_* / GH_TEST_TOKEN / ANTHROPIC_API_KEY from ~/.kodus-dev/config if
// not already exported. Indent-tolerant; never overrides a caller-set var.
// (Mirrors run.ts:loadConfig.)
function loadConfig(): void {
    const path = join(homedir(), ".kodus-dev", "config");
    let text: string;
    try {
        text = readFileSync(path, "utf8");
    } catch {
        return;
    }
    for (const line of text.split("\n")) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (!m) continue;
        const [, k, vRaw] = m;
        if (process.env[k] !== undefined) continue;
        const v = vRaw.replace(/^["']|["']$/g, "");
        if (v.startsWith("op://")) continue;
        process.env[k] = v;
    }
}

// The full 50-PR dataset. Each run remaps repo -> the per-run clone
// kodus-e2e/<base>-<RUN_ID> (created by clone-run-repos.ts before this runs).
function loadPRs(): BenchPR[] {
    const p = join(process.cwd(), "..", "..", "scripts", "benchmark", "prs-benchmark.json");
    const raw = JSON.parse(readFileSync(p, "utf8"));
    return (raw.prs ?? raw) as BenchPR[];
}

const CLONE_ORG = "kodus-e2e";
// ai-code-review-benchmark/sentry  ->  kodus-e2e/sentry-<RUN_ID>
function clonedRepo(sourceRepo: string): string {
    const base = sourceRepo.split("/")[1];
    return `${CLONE_ORG}/${base}-${RUN_ID}`;
}

// --- onboarding (mirrors run.ts, retargeted to DROPLET) ---

async function listOrgRepos(session: KodusSession): Promise<Array<Record<string, unknown>>> {
    const resp = await http<{ data: Array<Record<string, unknown>> }>(
        `${DROPLET.apiBaseUrl}/code-management/repositories/org?teamId=${encodeURIComponent(session.teamId)}`,
        { headers: { Authorization: `Bearer ${session.accessToken}` }, timeoutMs: 30_000 },
    );
    return resp.status >= 200 && resp.status < 300 ? resp.body.data ?? [] : [];
}

// Idempotent: if every benchmark repo is already `selected`, do nothing (a
// re-onboard deletes+recreates the webhooks and silently stops reviews — see
// run.ts:registerRepos for the full rationale).
async function registerRepos(session: KodusSession, repoFullNames: string[]): Promise<void> {
    const avail = await listOrgRepos(session);
    const availByName = new Map(avail.map((x) => [x.full_name as string, x]));
    const found = repoFullNames.map((fn) => {
        const r = availByName.get(fn);
        if (!r) {
            throw new Error(
                `clone repo ${fn} not in integration's available list (${avail.length} repos). Sample: ${JSON.stringify(avail.slice(0, 6).map((x) => x.full_name))}`,
            );
        }
        return r;
    });
    if (found.every((r) => r.selected === true)) {
        log.info(`${found.length} repos already onboarded — skipping re-register`);
        return;
    }
    const resp = await http<{ data: { status: boolean } }>(
        `${DROPLET.apiBaseUrl}/code-management/repositories`,
        {
            method: "POST",
            headers: { Authorization: `Bearer ${session.accessToken}` },
            body: { teamId: session.teamId, type: "replace", repositories: found },
            timeoutMs: 30_000,
        },
    );
    ensureOk(resp, "farm:registerRepos");
    log.ok(`onboarded ${found.length} repos`);
}

// trial -> BYOK config -> migrate-to-free, so the cloud review gate
// (permissionValidation) allows reviews on the free_byok plan. Idempotent.
async function ensureReviewLicense(session: KodusSession, seedModel: BenchModel): Promise<void> {
    const billing = `${DROPLET.webBaseUrl}/api/proxy/billing`;
    const auth = { Authorization: `Bearer ${session.accessToken}` };
    const body = { organizationId: session.organizationId, teamId: session.teamId };
    const okOrAlready = (s: number, raw: string) =>
        (s >= 200 && s < 300) || s === 409 || (s === 400 && /already|trial|existe|free_byok/i.test(raw));

    const trial = await http(`${billing}/trial`, { method: "POST", headers: auth, body: { ...body, byok: true }, timeoutMs: 30_000 });
    if (!okOrAlready(trial.status, trial.raw)) throw new Error(`billing/trial failed: HTTP ${trial.status} ${trial.raw.slice(0, 200)}`);
    await setByokConfig({ apiBaseUrl: DROPLET.apiBaseUrl, accessToken: session.accessToken }, seedModel);
    const migrate = await http(`${billing}/migrate-to-free`, { method: "POST", headers: auth, body, timeoutMs: 30_000 });
    if (!okOrAlready(migrate.status, migrate.raw)) throw new Error(`billing/migrate-to-free failed: HTTP ${migrate.status} ${migrate.raw.slice(0, 200)}`);
    log.ok(`review license ready (free_byok)`);
}

async function ensureOnboarded(session: KodusSession, repoFullNames: string[]): Promise<void> {
    let avail = await listOrgRepos(session);
    const selected = new Set(avail.filter((r) => r.selected === true).map((r) => r.full_name as string));
    const allSelected = avail.length > 0 && repoFullNames.every((fn) => selected.has(fn));
    if (!allSelected) {
        const provider0 = new GitHubProvider({ repoOverride: repoFullNames[0], target: "cloud" });
        await registerIntegration(DROPLET, provider0, session);
        await registerRepos(session, repoFullNames);
        avail = await listOrgRepos(session);
    } else {
        log.ok(`repos already onboarded`);
    }
    // finish-onboarding activates AUTOMATION_CODE_REVIEW (registerRepos alone
    // doesn't) — without it every PR webhook is silently dropped.
    const first = avail.find((r) => r.full_name === repoFullNames[0]);
    if (!first) throw new Error(`onboarded repo ${repoFullNames[0]} not found after register`);
    await finishOnboarding(DROPLET, session, { id: String(first.id), name: String(first.name), full_name: String(first.full_name) });
    log.ok(`code-review automation activated`);
}

// --- GitHub-side review helpers (target-agnostic; mirror run.ts) ---
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ghGetJson<T>(url: string): Promise<T> {
    const headers = {
        Authorization: `Bearer ${process.env.GH_TEST_TOKEN!}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    };
    let lastErr: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            const r = await fetch(url, { headers });
            if (r.ok) return (await r.json()) as T;
            if (r.status === 429 || r.status >= 500) { await sleep(2000 * 2 ** attempt); continue; }
            throw new Error(`GitHub ${r.status} on ${url}: ${(await r.text()).slice(0, 150)}`);
        } catch (e) {
            lastErr = e;
            await sleep(2000 * 2 ** attempt);
        }
    }
    throw new Error(`ghGetJson exhausted retries: ${url} (${(lastErr as Error)?.message})`);
}

async function collectFindings(repo: string, prNumber: number): Promise<string[]> {
    const body = await ghGetJson<{ body?: string }[]>(
        `https://api.github.com/repos/${repo}/pulls/${prNumber}/comments?per_page=100`,
    );
    return (body ?? [])
        .map((c) => (c.body ?? "").trim())
        .filter((b) => b && !b.toLowerCase().startsWith("@kody"))
        .map((b) => b.replace(/^(?:\s*!\[[^\]]*\]\([^)]*\)\s*)+/i, "").trim());
}

type ReviewOutcome = "completed" | "failed" | "timeout";
async function waitForReviewOutcome(repo: string, prNumber: number, sinceMs: number, capSec = 3000): Promise<ReviewOutcome> {
    const deadline = Date.now() + capSec * 1000;
    while (Date.now() < deadline) {
        try {
            const comments = await ghGetJson<{ body?: string; created_at?: string }[]>(
                `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100`,
            );
            const fresh = comments.filter((c) => !c.created_at || new Date(c.created_at).getTime() >= sinceMs);
            if (fresh.some((c) => /could not complete|review failed before/i.test(c.body ?? ""))) return "failed";
            if (fresh.some((c) => /review complet(ed|e)\b/i.test(c.body ?? ""))) return "completed";
        } catch { /* transient */ }
        await sleep(15_000);
    }
    return "timeout";
}

async function collectFindingsStable(repo: string, prNumber: number): Promise<string[]> {
    let prev = await collectFindings(repo, prNumber);
    for (let i = 0; i < 6; i++) {
        await sleep(10_000);
        const next = await collectFindings(repo, prNumber);
        if (next.length === prev.length) return next;
        prev = next;
    }
    return prev;
}

// Open a PR on its per-run clone, wait for Kody, collect findings, close.
async function reviewOnePR(model: BenchModel, pr: BenchPR): Promise<{ ok: boolean; result: unknown }> {
    const repo = clonedRepo(pr.repo);
    const provider = new GitHubProvider({ repoOverride: repo, target: "cloud" });
    const repoShort = repo.split("/")[1];
    let opened;
    try {
        const openedAt = Date.now();
        opened = await provider.openPRFromBranches!({ head: pr.head, base: pr.base, title: `[bench] ${RUN_ID} ${repoShort}`, body: `Farm benchmark run ${RUN_ID}` });
        let outcome = await waitForReviewOutcome(repo, opened.number, openedAt - 5_000);
        let retried = false;
        if (outcome !== "completed") {
            retried = true;
            log.info(`${repoShort}: review ${outcome} — retrying once via @kody review (PR #${opened.number})`);
            await sleep(5_000);
            const retryAt = Date.now() - 5_000;
            await provider.postComment(opened.number, "@kody review").catch(() => {});
            outcome = await waitForReviewOutcome(repo, opened.number, retryAt);
        }
        const reviewed = outcome === "completed";
        const findings = reviewed ? await collectFindingsStable(repo, opened.number) : [];
        if (reviewed) log.ok(`${repoShort}: reviewed (${findings.length} findings)${retried ? " [retry]" : ""}`);
        else log.err(`${repoShort}: ${outcome} after retry (PR #${opened.number})`);
        return { ok: reviewed, result: { repo, prNumber: opened.number, head: pr.head, golden_comments: pr.golden_comments, findings, retried } };
    } catch (err) {
        log.err(`${repo}: ${(err as Error).message}`);
        return { ok: false, result: { repo, head: pr.head, error: (err as Error).message } };
    } finally {
        if (opened) await provider.closePR(opened).catch(() => {});
    }
}

async function main() {
    loadConfig();
    const prs = loadPRs();
    const slug = process.env.FARM_MODEL_SLUG;
    const models = loadTier0Models();
    const model = slug ? models.find((m) => m.slug === slug) : models[0];
    if (!model) throw new Error(`model '${slug}' not in curated list`);

    log.info(`Farm run ${RUN_ID}: ${prs.length} PRs on ${DROPLET.webBaseUrl} (model ${model.slug}) — clones kodus-e2e/<base>-${RUN_ID}`);

    // JIT tenant for this run.
    const email = `farm-${RUN_ID}@kodus.io`;
    const password = process.env.BENCH_TENANT_PASSWORD || process.env.TEST_USER_PASSWORD || "E2eBench!a1b2c3d4";
    await signUp(DROPLET, { email, password }).catch(() => {});
    const session = await login(DROPLET, { email, password });
    log.ok(`tenant ready (team ${session.teamId})`);

    await ensureReviewLicense(session, model);
    await ensureOnboarded(session, prs.map((p) => clonedRepo(p.repo)));

    const s = { apiBaseUrl: DROPLET.apiBaseUrl, accessToken: session.accessToken };
    const tb = await testByok(s, model);
    if (!tb.ok) throw new Error(`test-byok failed: ${tb.code} ${tb.message ?? ""}`);
    await setByokConfig(s, model);
    await resetCodeReviewConfig(DROPLET, session);
    log.ok(`BYOK set + validated (${tb.latencyMs}ms)`);

    // All 50 PRs concurrently — each is a distinct cloned repo, so webhooks
    // never collide (bounded by the slowest single review, not the sum).
    const outcomes = await Promise.all(prs.map((pr) => reviewOnePR(model, pr)));
    const results = outcomes.map((o) => o.result);
    const ok = outcomes.filter((o) => o.ok).length;

    const outPath = join(process.cwd(), "benchmark", `results-farm-${RUN_ID}.json`);
    writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), runId: RUN_ID, model: model.slug, results }, null, 2));
    log.info(`RESULT: ${ok} reviewed, ${prs.length - ok} failed (of ${prs.length}). -> ${outPath}`);
    if (ok === 0) process.exit(1);
}

main().catch((e) => { log.err(String(e?.stack ?? e)); process.exit(1); });
