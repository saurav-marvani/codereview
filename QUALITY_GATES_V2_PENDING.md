# Quality Gates v2 — Pending Work

> **Temporary file.** Tracks what was left unfinished when `chore/quality-gates`
> was split: the merge-to-main branch (`chore/quality-gates`) ships the E2E
> framework + scripts + app-side fixes **without** the CI workflow files, and
> this branch (`quality-gates-v2`) continues from here with the workflows and
> the open items below. Delete this file once the items are triaged into real
> issues / done.

Last updated: 2026-05-23.

---

## Branch split summary

- `chore/quality-gates` → **merging to main.** Contains: the `tests/e2e/`
  framework, `scripts/selfhosted/*`, `scripts/e2e/*`, all the app-side
  reliability fixes (see "App-side fixes already landed"), and the matrix
  YAMLs. The 5 CI workflow files were **removed** from it (reverted to main's
  state) so half-stabilized CI doesn't land on main.
- `quality-gates-v2` → **this branch.** Carries the 5 workflow files forward
  and is where the pending work below continues.

### Workflow files that live here (not on main)

| File | State vs main | Purpose |
|---|---|---|
| `.github/workflows/e2e-cloud.yml` | new | Cloud E2E matrix runner |
| `.github/workflows/e2e-self-hosted-matrix.yml` | new | Self-hosted E2E matrix runner |
| `.github/workflows/e2e-suite-tests.yml` | new | Unit/integration suite for the E2E framework |
| `.github/workflows/selfhosted-promote.yml` | new | Retag RC → customer-visible tag after E2E green |
| `.github/workflows/selfhosted-build-push.yml` | modified (~401 lines) | RC-tagging build/push |

These were intentionally kept off main because the self-hosted matrix is not
yet 100% green in CI shape (see Bitbucket item below) and the promote workflow
gates releases on that matrix.

---

## Open items

### 1. Bitbucket cell fails in the full matrix (BLOCKER for green CI)

**Status:** root-caused, fix designed, NOT applied.

Bitbucket passes in isolation (single-cell `bitbucket-only.yml` probe = 5/6,
the 6th fixed by the 5s branch-create wait; `smoke` = pass) but fails 0/5 in
the full matrix. Cause: the matrix creates a **fresh tenant per cell**, so the
Bitbucket cell's `registerRepo` triggers a historical-PR backfill in
background; that backfill + the review pipeline + the scenario's own polling
all hit the **same** Bitbucket app-password token concurrently and blow the
per-endpoint burst window → `429` cascade.

GitHub/GitLab are unaffected (much higher API budgets).

**Designed fix (not yet applied):** use a **persistent** tenant for the
Bitbucket cell in the matrix (like `smoke` does) instead of a fresh one, so
`registerRepo` doesn't re-trigger backfill. ~1 line in
`tests/e2e/lib/runner.ts` (`resolveTenantForCell`). Trade-off: less per-run
isolation for Bitbucket; acceptable to fit Bitbucket's tight rate limit.

Alternatives considered: (a) two rotating BB tokens; (b) accept BB as
quarantined/flaky and run it separately. Parallelizing the matrix does NOT
help — all droplets share the one BB token.

### 2. Production bug — Bitbucket backfill rate-limit (FILED)

GitHub issue **kodustech/kodus-ai#1165**. Backfill can silently 429 against
Bitbucket, dropping dashboard history + degrading the first review. Partially
mitigated by the app-side fixes below; proper fix (per-token rate limiter,
backfill only newly-added repos, stop masking 429 as "0 commits") is tracked
in the issue.

### 3. Parallel matrix architecture (OPTIMIZATION, not a blocker)

Run one droplet per provider so cells run in parallel (wall-time ~60min →
~15min) and cross-cell license-state pollution becomes impossible. Estimated
8–12h. Does **not** fix the Bitbucket token issue (single shared token). Design
notes:

- Per-provider state files: `selfhosted-vm-matrix-<provider>.json`.
- `tests/e2e/lib/runner.ts` `envForTarget(target, provider)` → resolve
  `SELFHOSTED_API_BASE_URL_<PROVIDER>` with fallback to the shared var.
- Group cells by provider; run providers in parallel via `Promise.allSettled`,
  cells within a provider serial (preserve license-state ordering).
- `scripts/e2e/run.sh`: `--auto-provision-per-provider` provisions N droplets
  in parallel and exports per-provider URLs.
- `selfhosted:deploy-all` / `selfhosted:destroy-all` helpers.

A partial start of the `envForTarget(target, provider)` change was reverted to
keep `chore/quality-gates` clean — redo it here.

### 4. `MCP_MANAGER_URL` hostname wrong on self-hosted (COSMETIC)

Worker logs `ECONNREFUSED 127.0.0.1:3101` because the env points at
`localhost` instead of `kodus-mcp-manager:3101`. `errorSeverity='partial'` so
the pipeline continues and `BusinessLogicValidationStage` just skips ("no
task-management MCP connected"). No test impact today, but a self-hosted
customer who connects Jira/Linear via MCP would silently get no
business-logic validation. Fix the compose/env var.

### 5. license-attribution × license-free coverage

`license-free` was removed from `license-attribution.appliesTo` for
self-hosted (commit `6902865b9`) because the "trial ended" notice is
structurally unreachable on self-hosted (only the cloud path emits it). The
**cloud** `free`/`trial` notice path is still asserted but has not been
re-validated end-to-end recently. Confirm a cloud run exercises it.

### 6. authMode App matrix coverage

From the project plan: App authMode coverage was "next" and is not yet in the
matrix. Add a self-hosted github-app cell (the cloud github-app cell exists in
`full.yml`).

---

## App-side fixes already landed (on `chore/quality-gates`, will reach main)

| Commit | Fix |
|---|---|
| `188eff487` | per-seat-license-toggle teardown clears install-wide license (CE mode) so the next cell isn't blocked; kody-rules rule reworded to defeat LLM "intentional fixture" excuse; sso preflight fail-fast |
| `6902865b9` | drop `license-free` from license-attribution on self-hosted (notice unreachable there) |
| `97842c63f` | `with429Retry` helper (honours Retry-After + jittered backoff); wrap hot BB/GitLab calls; cut kody-rules PR fan-out 5→2 |
| `2c3203695` | remove redundant synchronous `generateKodyRules` from `finishOnboarding` (was holding the HTTP request open while hammering the provider) |
| `cda9c4457` | cap historical backfill to 10 PRs, 2s apart, patient retry |
| `08bd7918f` | wait 5s after BB throwaway-branch create before opening the PR (dodge BB commits-indexing race that made ValidateNewCommitsStage skip with "0 commits") |

## Test status snapshot (2026-05-23, single-droplet matrix)

| Cell | Result |
|---|---|
| github × {code-review, onboarding-webhook, kody-rules, license-attribution, per-seat} | 5/5 PASS (stable across 4 runs) |
| gitlab × same 5 | 5/5 PASS (stable across 4 runs) |
| bitbucket — isolated (`bitbucket-only.yml` probe + smoke) | PASS (6/6 with the 5s fix) |
| bitbucket — in full matrix | 0/5 (item #1) |
| github × license-free | SKIP (item #5, by design) |

## Useful artifacts

- `tests/e2e/matrix/bitbucket-only.yml` — single-cell BB isolation probe (added here).
- `tests/e2e/matrix/repaired-cells.yml` — focused set covering the cells that failed on 2026-05-23.
- `tests/e2e/matrix/full-no-sso.yml` — full matrix minus SSO (for when `SH_LICENSE_KEY` is absent).
