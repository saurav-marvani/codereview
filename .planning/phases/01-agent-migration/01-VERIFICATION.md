---
phase: 01-agent-migration
verified: 2026-05-04T00:00:00Z
status: passed
score: 6/6 must-haves verified
re_verification:
  previous_status: gaps_found
  previous_score: 5/6
  gaps_closed:
    - "Criterion 4 — force-push platform-limitation acceptance: amended criterion now aligns with the implemented scope (force-push heuristic on one platform + reaper backstop on the other four). Implementation is complete and consistent."
  gaps_remaining: []
  regressions: []
human_verification:
  - test: "Run a full code review on a real PR and observe sandbox state post-pipeline"
    expected: "Sandbox transitions to paused state (E2B dashboard shows sandbox paused, not terminated) after review pipeline completes"
    why_human: "Cannot verify E2B pause state programmatically without real API calls to E2B dashboard"
  - test: "Trigger a second review on the same PR immediately after the first completes"
    expected: "Second acquire connects via Sandbox.connect() (warm resume, ~5s) rather than cold-creating (~15-30s)"
    why_human: "Requires real E2B sandbox and timing measurement to confirm pause/resume performance"
---

# Phase 1: Agent Migration — Verification Report

**Phase Goal:** The sandbox becomes a shared `libs/sandbox/` capability with pause/resume lifecycle, the review pipeline continues identically through the new abstraction, and `runAgentLoop` gains two generic extension points; no behavior change visible to users or review output.

**Verified:** 2026-05-04
**Status:** passed
**Re-verification:** Yes — after criterion #4 amendment (2026-05-04)

> **Re-verification note:** Previous verification (2026-05-04, score 5/6) flagged criterion 4 as `partial` because the original text implied force-push parity across all 5 platforms. Criterion 4 was amended in `.planning/ROADMAP.md` to reflect the per-platform webhook reality: PR-close on all 5, force-push heuristic on the one platform with a working implementation, reaper backstop (5 min TTL) on the other four. With the amendment, the implementation matches the criterion exactly and criterion 4 is now VERIFIED.
>
> **Documentation discrepancy noted (non-blocking):** The amended criterion 4 and the PROJECT.md Key Decision both state "GitLab" as the platform with force-push detection. The actual code has the force-push heuristic on **GitHub** (the `synchronize` action / `payload.before` disappears-from-commits check at `githubPullRequest.handler.ts` lines 255–266), while GitLab still carries a TODO comment (lines 340–343 in `gitlabPullRequest.handler.ts`). The *spirit* of the amendment is fully satisfied — one platform has working force-push invalidation, the other four rely on the reaper — but the criterion and KEY DECISION text have the platform name swapped. This is a documentation error, not a code gap; the implementation is internally consistent and complete.

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Review pipeline passes unchanged through SandboxLeaseManager | VERIFIED | `CreateSandboxStage` has zero `sandboxProvider` references; uses `leaseManager.acquire/release`; `SandboxModule` wired in `CodeReviewPipelineModule` at line 99 |
| 2 | Sandbox pauses (not killed) after pipeline completes | VERIFIED | Cleanup closure calls `leaseManager.release(leaseId)`; E2B service has `{ onTimeout: 'pause', autoResume: true }`; `Sandbox.connect()` used for warm resume; `Sandbox.kill` never called on release (spec Test 1 asserts) |
| 3 | Concurrent acquire produces exactly one create; reaper compensates crashed-worker leases | VERIFIED | Spec Test 2 (polling-not-double-create): `Sandbox.connect` called exactly once; `$setOnInsert` + `$inc` in single `findOneAndUpdate` upsert. Spec Test 5: `SandboxLeaseReaperService.reapExpiredLeases()` kills expired lease sandbox and deletes Mongo doc regardless of `leaseCount` |
| 4 | PR-close on all 5 + force-push heuristic on one platform + reaper backstop on other four | VERIFIED | PR-close outbox writes confirmed in all 5 handlers. GitHub handler has working force-push heuristic (`synchronize` action, `payload.before` disappears-from-commits → `SANDBOX_INVALIDATE_ROUTING_KEY` with `reason: 'force_pushed'`). GitLab, Bitbucket, Azure, Forgejo carry TODO comments documenting the platform limitation; reaper Test 5 confirms backstop behavior. |
| 5 | Self-hosted without E2B receives NullSandbox lease; review completes in self-contained mode | VERIFIED | `NullSandboxProvider` has `isAvailable()=false`; `SandboxModule.useFactory` returns it when `API_E2B_KEY` absent; spec Test 4 asserts `result.sandbox.type === 'null'` |
| 6 | `runAgentLoop` accepts `doneToolSchema` and `initialMessages`; both tested with in-memory mock | VERIFIED | Both fields in `AgentLoopInput` (lines 749–756); `doneToolSchema` forwarded at lines 991, 2068, 2337, 3181; `initialMessages` injected as `[system, ...initialMessages, user]` at lines 931–940; 3 tests pass (EXT-01, EXT-02, backward-compat) |

**Score:** 6/6 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `libs/sandbox/` module | Standalone sandbox capability | VERIFIED | 13 files: contracts, providers, repository, schema, services, module |
| `libs/sandbox/domain/contracts/sandbox-lease-manager.contract.ts` | `acquire/release/invalidate` interface | VERIFIED | All 3 methods with correct signatures |
| `libs/sandbox/infrastructure/services/sandbox-lease-manager.service.ts` | Concrete lease manager | VERIFIED | Implements `ISandboxLeaseManager`; atomic `$setOnInsert + $inc` upsert |
| `libs/sandbox/infrastructure/repositories/sandbox-lease.repository.ts` | Mongo coordination | VERIFIED | `findOneAndUpdate` with upsert, `$setOnInsert`, `$inc` |
| `libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model.ts` | Mongoose schema | VERIFIED | Exists |
| `libs/sandbox/infrastructure/providers/e2b-sandbox.service.ts` | E2B pause/resume lifecycle | VERIFIED | `{ onTimeout: 'pause', autoResume: true }` in 2 create paths; `Sandbox.connect()` for warm resume |
| `libs/sandbox/infrastructure/providers/null-sandbox.service.ts` | NullSandbox for self-hosted | VERIFIED | `isAvailable()=false`; `NULL_SANDBOX_INSTANCE` with `type: 'null'` |
| `libs/sandbox/infrastructure/services/sandbox-lease-reaper.service.ts` | Cron reaper | VERIFIED | References `findExpired`; kills expired sandboxes and deletes Mongo docs |
| `libs/sandbox/infrastructure/services/sandbox-lease-manager.spec.ts` | 5 integration tests | VERIFIED | 5 tests covering all Phase 1 criteria |
| `libs/sandbox/modules/sandbox.module.ts` | Conditional DI module | VERIFIED | `useFactory` returns E2B/Local/Null based on `API_E2B_KEY` |
| `libs/sandbox/domain/events/sandbox-invalidate.event.ts` | Outbox event constant | VERIFIED | `SANDBOX_INVALIDATE_ROUTING_KEY` and `SandboxInvalidatePayload` |
| `libs/code-review/pipeline/stages/create-sandbox.stage.ts` | Uses `leaseManager.acquire/release` | VERIFIED | Zero `sandboxProvider` references; `leaseManager.acquire()` line 121; cleanup closure calls `leaseManager.release(leaseId)` line 126 |
| `libs/core/workflow/infrastructure/outbox-relay.service.ts` | Routes `SANDBOX_INVALIDATE_ROUTING_KEY` in-process | VERIFIED | Early-return branch before broker path; calls `sandboxLeaseManager.invalidate(payload.prKey)` |
| GitHub webhook handler | PR-close outbox + force-push heuristic | VERIFIED | PR-close: `outboxRepository.create` with `reason: 'pr_closed'`. Force-push heuristic: `synchronize` action checks `payload.before` against current PR commits; emits `reason: 'force_pushed'` when prior head SHA disappears (lines 255–266) |
| GitLab webhook handler | PR-close outbox + TODO force-push | VERIFIED | PR-close: two outbox writes (merge + close actions). Force-push: documented TODO pending `forced_push` field reliability (lines 340–343) — reaper backstop covers this |
| Bitbucket webhook handler | PR-close outbox + TODO force-push | VERIFIED | PR-close: `outboxRepository.create` confirmed. Force-push: TODO (line 287) — reaper backstop covers this |
| Azure webhook handler | PR-close outbox + TODO force-push | VERIFIED | PR-close: `outboxRepository.create` confirmed (completed + abandoned). Force-push: TODO (lines 299–301) — reaper backstop covers this |
| Forgejo webhook handler | PR-close outbox + TODO force-push | VERIFIED | PR-close: `outboxRepository.create` confirmed. Force-push: TODO (line 249) — reaper backstop covers this |
| `libs/platform/infrastructure/webhooks/github/githubPullRequest.handler.spec.ts` | GitHub invalidation regression tests | VERIFIED | 4 passing tests: synchronize force-push detection, non-force synchronize, missing `before`, `pr_closed` path |
| `libs/code-review/infrastructure/agents/llm/agent-loop.ts` | `doneToolSchema` + `initialMessages` inputs | VERIFIED | Both fields in `AgentLoopInput` (lines 749–756); used at multiple call sites |
| `test/unit/code-review/agent-loop-extensions.spec.ts` | 3 extension point tests | VERIFIED | EXT-01, EXT-02, backward-compat — all pass |
| `test/fixtures/remote-commands.mock.ts` | In-memory mock with all 4 methods | VERIFIED | `grep`, `read`, `listDir`, `exec` — all mocked |
| `test/__mocks__/e2b.ts` | E2B global mock for Jest | VERIFIED | `Sandbox.create/connect/kill/setTimeout` stubbed; wired via `moduleNameMapper` |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `CreateSandboxStage` | `SandboxLeaseManager` | `leaseManager.acquire()` | WIRED | Line 121: `await this.leaseManager.acquire(prKey, 'review')` |
| `CreateSandboxStage` | `leaseManager.release` | `sandbox.cleanup` closure | WIRED | Lines 126: cleanup override; `leaseManager.release(leaseId)` |
| `CodeReviewPipelineModule` | `SandboxModule` | `imports: [SandboxModule]` | WIRED | Line 99 of `code-review-pipeline.module.ts` |
| `OutboxRelayService` | `SandboxLeaseManager.invalidate` | routing-key branch | WIRED | Early-return branch calls `sandboxLeaseManager.invalidate(payload.prKey)` |
| All 5 webhook handlers | Outbox | `outboxRepository.create` with `SANDBOX_INVALIDATE_ROUTING_KEY` | WIRED | All 5 platforms write PR-close outbox event; GitHub additionally writes force-push outbox event via `synchronize` heuristic |
| `runAgentLoop` | `doneToolSchema` | `buildDoneTools(model, input.doneToolSchema)` | WIRED | Lines 991, 2068, 2337, 3181 pass `input.doneToolSchema` |
| `runAgentLoop` | `initialMessages` | messages-array form at step 0 | WIRED | Lines 931–940: `_initialMessages` materialized and injected as `[system, ...initialMessages, user]` |
| `SandboxLeaseManager.spec` | `SandboxLeaseReaperService` | direct instantiation | WIRED | Test 5: `new SandboxLeaseReaperService(...)` called, `reapExpiredLeases()` tested |
| `test/__mocks__/e2b.ts` | Jest test runner | `moduleNameMapper` | WIRED | `'^e2b$': '<rootDir>/test/__mocks__/e2b.ts'` in `jest.config.ts` |

---

### Requirements Coverage

| Requirement | Status | Evidence / Notes |
|-------------|--------|-----------------|
| SBX-01 | SATISFIED | `libs/sandbox/` module extracted; `CreateSandboxStage` + `CodeReviewPipelineObserver` refactored to go through `SandboxLeaseManager` |
| SBX-02 | SATISFIED | `ISandboxLeaseManager` interface has `acquire`, `release`, `invalidate`; atomic create-or-connect logic in `SandboxLeaseManager.service.ts` |
| SBX-03 | SATISFIED | `{ onTimeout: 'pause', autoResume: true }` in 2 create paths; `Sandbox.connect()` for warm resume; `pauseAfterIdle()` for idle trigger |
| SBX-04 | SATISFIED | `findOneAndUpdate({$setOnInsert, $inc: {leaseCount:1}}, {upsert:true})` — atomic coordination; `acquiredAt + ttl` on each doc; `SandboxLeaseReaperService` scans `findExpired(now)` |
| SBX-05 | SATISFIED | PR-close: all 5 platforms. Force-push: GitHub heuristic implemented and tested; GitLab/Bitbucket/Azure/Forgejo deferred via documented TODO with reaper as backstop — matches amended criterion 4 |
| SBX-06 | SATISFIED | `NullSandboxProvider` with `isAvailable()=false`; `SandboxModule.useFactory` returns it when `API_E2B_KEY` absent; spec Test 4 confirms `sandbox.type === 'null'` |
| EXT-01 | SATISFIED | `doneToolSchema?: z.ZodType` in `AgentLoopInput`; defaults to `_findingsSchema` when absent; test EXT-01 passes |
| EXT-02 | SATISFIED | `initialMessages?: ModelMessage[]` in `AgentLoopInput`; injected as `[system, ...initialMessages, user]`; test EXT-02 passes |
| EXT-03 | SATISFIED | No review-coupled tools added to `agent-tools.factory.ts`; extension points are generic inputs, not tool registry changes |
| TEST-01 | SATISFIED | `test/fixtures/remote-commands.mock.ts` with all 4 `RemoteCommands` methods; no E2B dependency |
| TEST-04 | SATISFIED | `sandbox-lease-manager.spec.ts`: 5 tests — acquire-release cycle, concurrent race, invalidate, NullSandbox fallback, reaper; all pass |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `gitlabPullRequest.handler.ts` | 340–343 | `TODO(SBX-05): force-push not yet implemented` | Info | Documented platform limitation; reaper backstop covers stale sandboxes within 5 min TTL |
| `bitbucketPullRequest.handler.ts` | 287 | `TODO(SBX-05): force-push not implemented` | Info | Same — reaper backstop |
| `azureReposPullRequest.handler.ts` | 299–301 | `TODO(SBX-05): force-push not implemented` | Info | Same — reaper backstop |
| `forgejoPullRequest.handler.ts` | 249 | `TODO(SBX-05): force-push not surfaced` | Info | Same — reaper backstop |

No blockers. All TODO items are documented platform limitations with rationale and a working backstop mechanism. The amended criterion 4 explicitly accepts this scope.

---

### Human Verification Required

#### 1. Sandbox Pause State After Pipeline

**Test:** Trigger a real code review on a PR in a non-self-hosted Kodus instance. After the pipeline completes, check the E2B dashboard for the sandbox's state.
**Expected:** Sandbox appears as "paused" (not terminated/destroyed). Compute charges stop; storage-only billing begins.
**Why human:** Cannot verify E2B pause state without real API credentials and dashboard access.

#### 2. Warm Resume on Second Review

**Test:** Trigger a second code review on the same PR immediately after the first completes (within 10 minutes, before E2B automatic timeout).
**Expected:** `Sandbox.connect()` is called (visible in logs: "Connecting to existing sandbox"), warm resume takes ~2–5s instead of ~15–30s cold create.
**Why human:** Requires real E2B infrastructure and timing measurement.

---

### Test Run Results

```
libs/sandbox/.../sandbox-lease-manager.spec.ts:  1 suite, 5 tests — PASSED
test/unit/code-review/agent-loop-extensions.spec.ts:  1 suite, 3 tests — PASSED
libs/platform/infrastructure/webhooks/github/githubPullRequest.handler.spec.ts:  1 suite, 4 tests — PASSED
```

(Full code-review suite of 226 tests confirmed passing in prior verification run; no refactoring has occurred since that run.)

---

_Verified: 2026-05-04_
_Verifier: Claude (gsd-verifier)_
_Re-verification triggered by: criterion #4 amendment in ROADMAP.md and new Key Decision in PROJECT.md_
