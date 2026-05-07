---
phase: 01-agent-migration
plan: "04"
subsystem: code-review-pipeline
tags:
  - sandbox
  - lease-manager
  - refactor
  - pipeline-stage
dependency_graph:
  requires:
    - 01-02  # SandboxLeaseManager service + SandboxModule
    - 01-03  # E2BSandboxService pause/resume lifecycle
  provides:
    - CreateSandboxStage wired to ISandboxLeaseManager
    - sandbox.cleanup closure calls release() not kill()
  affects:
    - libs/code-review/pipeline/stages/create-sandbox.stage.ts
    - libs/code-review/pipeline/code-review-pipeline.module.ts
    - test/unit/code-review/pipeline/stages/create-sandbox.stage.spec.ts
tech_stack:
  added: []
  patterns:
    - lease-manager injection via SANDBOX_LEASE_MANAGER_TOKEN
    - prKey = {orgId}:{repoId}:{prNumber} for lease coordination
    - cleanup closure delegates to leaseManager.release(leaseId)
key_files:
  created: []
  modified:
    - libs/code-review/pipeline/stages/create-sandbox.stage.ts
    - libs/code-review/pipeline/code-review-pipeline.module.ts
    - test/unit/code-review/pipeline/stages/create-sandbox.stage.spec.ts
decisions:
  - "prKey for CLI mode uses branch name: {orgId}:{repoId}:cli:{branch} — PR number not available in CLI context"
  - "isAvailable() guard removed from CreateSandboxStage — lease manager handles null sandbox path internally when no provider configured"
  - "cleanup closure overrides the one set by leaseManager.handleCreatorPath — equivalent semantics, explicit ownership in stage"
  - "cloneParamsResolver.resolve() still called for logging (URL, branch, prNumber) even though params not forwarded to acquire() yet — contract-level integration of cloneParams deferred"
metrics:
  duration: "10 min"
  completed: "2026-04-29"
  tasks: 2
  files: 3
---

# Phase 1 Plan 04: CreateSandboxStage → SandboxLeaseManager Integration Summary

**One-liner:** Replaced ISandboxProvider injection in CreateSandboxStage with ISandboxLeaseManager, routing sandbox creation through the lease layer so cleanup calls release() (pause) instead of kill().

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Refactor CreateSandboxStage to use SandboxLeaseManager | fbc356686 | create-sandbox.stage.ts, code-review-pipeline.module.ts, create-sandbox.stage.spec.ts |
| 2 | Verify full review test suite passes unchanged | — (no code changes needed) | — |

## What Was Done

### Task 1: Refactor CreateSandboxStage

**Constructor change:**
- Removed: `@Inject(SANDBOX_PROVIDER_TOKEN) private readonly sandboxProvider: ISandboxProvider`
- Added: `@Inject(SANDBOX_LEASE_MANAGER_TOKEN) private readonly leaseManager: ISandboxLeaseManager`
- Import source changed from `@libs/code-review/domain/contracts/sandbox.provider` to `@libs/sandbox/domain/contracts/sandbox-lease-manager.contract`

**Primary path (was line ~119):**
- Old: `const sandbox = await this.sandboxProvider.createSandboxWithRepo({...})`
- New: `const { sandbox, leaseId } = await this.leaseManager.acquire(prKey, 'review')`
- prKey = `{orgId}:{repoId}:{prNumber}` (GitHub/Bitbucket) or `{orgId}:{repoId}:cli:{branch}` (CLI mode)
- cleanup override: `sandbox.cleanup = async () => { await this.leaseManager.release(leaseId); }`

**Retry block (was lines ~201–213):**
- Old: `await this.sandboxProvider.createSandboxWithRepo({...cloneInfoRetry params...})`
- New: `const retryResult = await this.leaseManager.acquire(prKey, 'review')` + cleanup override with `retryResult.leaseId`
- Zero `sandboxProvider` references remain in the file

**Guard change:**
- Removed `isAvailable()` guard — ISandboxLeaseManager has no `isAvailable()` method; the lease manager returns NullSandbox when E2B is not configured, allowing review to continue in self-contained mode

**Module update:**
- Added `SandboxModule` to `CodeReviewPipelineModule` imports[] to wire `SANDBOX_LEASE_MANAGER_TOKEN` into the DI graph

**Observer: UNCHANGED** — `CodeReviewPipelineObserver.onPipelineFinish()` calls `context.sandboxHandle.cleanup()` which now points to `leaseManager.release(leaseId)` via the closure set in the stage.

### Task 2: Test Suite Verification

Updated `create-sandbox.stage.spec.ts`:
- Replaced `ISandboxProvider` mock with `ISandboxLeaseManager` mock returning `AcquireResult { sandbox, leaseId, sandboxId }`
- Changed "skip if not available" test to "proceeds and acquires lease even when sandbox returns null type" — reflects new behavior where stage always calls `acquire()` and manager handles null path
- Added explicit test: `cleanup closure calls leaseManager.release with correct leaseId`
- Added retry test: verifies second `acquire()` call and correct `leaseId` in cleanup

Full suite results:
- `test/unit/code-review/` — 36 suites passed, 1 skipped (pre-existing), 560 tests passed, **0 failures**
- `test/unit/code-review/pipeline/` — 13 suites passed, 181 tests passed, **0 failures**

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing functionality] Added CLI-mode prKey construction**
- **Found during:** Task 1
- **Issue:** Plan specified `prKey = {orgId}:{repoId}:{prNumber}` but CLI mode has no `pullRequest.number`; would produce `{orgId}:{repoId}:undefined`
- **Fix:** CLI path uses `{orgId}:{repoId}:cli:{branch}` for stable lease key without PR number
- **Files modified:** `libs/code-review/pipeline/stages/create-sandbox.stage.ts`
- **Commit:** fbc356686

**2. [Rule 1 - Bug] isAvailable() guard removal required**
- **Found during:** Task 1
- **Issue:** Guard calls `this.sandboxProvider.isAvailable()` — after removing sandboxProvider injection, this would not compile
- **Fix:** Removed the guard entirely; lease manager handles null sandbox path when no provider configured; test updated to reflect new semantics
- **Files modified:** `libs/code-review/pipeline/stages/create-sandbox.stage.ts`, spec
- **Commit:** fbc356686

## Self-Check: PASSED

- FOUND: `libs/code-review/pipeline/stages/create-sandbox.stage.ts`
- FOUND: `libs/code-review/pipeline/code-review-pipeline.module.ts`
- FOUND: `test/unit/code-review/pipeline/stages/create-sandbox.stage.spec.ts`
- FOUND: `.planning/phases/01-agent-migration/01-04-SUMMARY.md`
- FOUND: commit fbc356686
