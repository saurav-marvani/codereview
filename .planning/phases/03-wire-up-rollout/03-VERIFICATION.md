---
phase: 03-wire-up-rollout
verified: 2026-05-04T00:00:00Z
status: passed
score: 6/6 must-haves verified
re_verification: false
---

# Phase 3: Wire-up & Rollout Verification Report

**Phase Goal:** Live `@kody` PR-comment traffic is routed through `runConversationLoop` (and thus through the review agent runtime with sandbox and native tools) behind a feature flag, with instant fallback to the legacy `ConversationAgentProvider` path when the flag is off.
**Verified:** 2026-05-04
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC-1: Flag ON delivers runtime reply — `@kody` reaches `handleConversationViaRuntime` → lease acquired → `runConversationLoop` called → reply returned | VERIFIED | `chatWithKodyFromGit.use-case.ts:1873-1874` dispatches to `handleConversationViaRuntime`; `1941-1958` calls `runConversationLoop` and returns `result.reply`; Test 1 (7/7 pass) |
| 2 | SC-2: Multi-turn persistence — second `@kody` on same PR sees prior turn via `materializeInitialMessages` from `ConversationSessionManager` | VERIFIED | `conversation-loop.service.ts:91-92` calls `input.sessionManager.materializeInitialMessages(input.prKey)`; `sessionManager` wired at `chatWithKodyFromGit.use-case.ts:1948`; `prKey` stable across calls (`org-1:repo-42:7` confirmed by Test 7) |
| 3 | SC-3: Flag OFF = legacy fallback — `conversationAgentUseCase.execute()` runs unchanged, new path not touched | VERIFIED | `chatWithKodyFromGit.use-case.ts:1877-1883` legacy fallback code present; `posthog.isInitialized` guard at `1863` ensures self-hosted default; Test 2 + Test 3 (flag flip) pass |
| 4 | SC-4: Sandbox lease reuse — `wasCreated: false` on second acquire, sandboxState labeled 'paused-resumed' | VERIFIED | `sandbox-lease-manager.service.ts:376,396` returns `wasCreated: false` on joiner path; `AcquireResult.wasCreated` in contract; `chatWithKodyFromGit.use-case.ts:1913-1918` derives sandboxState from it; Test 4 asserts `sandboxState='paused-resumed'` in error log |
| 5 | SC-5: BYOK contention bounded — conversation queues with `queueTimeoutMs: 60_000` and fails politely instead of hanging | VERIFIED | `conversation-loop.service.ts:127` defaults `byokQueueTimeoutMs` to `60_000`; `byok-to-vercel.ts:451` confirms `DEFAULT_LIMITER_QUEUE_TIMEOUT_MS=0` (review gets infinite); PERF-03 test (2/2 pass) confirms `[BYOK-QUEUE-TIMEOUT]` fires; `chatWithKodyFromGit.use-case.ts:1963-1966` catches and returns user-visible string |
| 6 | CONV-05: Memory non-regression — `KODUS_FIND_MEMORIES` and `KODUS_CREATE_MEMORY` tools available via `buildConversationMemoryTools` | VERIFIED | `conversation-tools.factory.ts:39,116` defines both tools; `chatWithKodyFromGit.use-case.ts:1949-1953` passes `buildConversationMemoryTools(this.kodyRulesService, orgId, teamId)` to `runConversationLoop`; `conversation-loop.service.ts:114` spreads into `additionalTools`; `agent-loop.ts:915` merges into tool set; Test 6 asserts both keys present |

**Score:** 6/6 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `libs/common/utils/posthog/index.ts` | `conversationAgentRuntime` in `FEATURE_FLAGS` | VERIFIED | Line 14: `conversationAgentRuntime: 'conversation-agent-runtime'` |
| `.env.example` | `API_CONVERSATION_RUNTIME_ENABLED` documented | VERIFIED | Line 291: `API_CONVERSATION_RUNTIME_ENABLED=` |
| `libs/sandbox/domain/contracts/sandbox-lease-manager.contract.ts` | `buildPrKey` helper + `wasCreated` in `AcquireResult` | VERIFIED | Lines 5-34: both present with JSDoc |
| `libs/platform/modules/platform.module.ts` | `SandboxModule` + `ConversationModule` in imports | VERIFIED | Lines 38-39, 66-67: both imported with `forwardRef()` |
| `libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case.ts` | `handleConversation` dispatch + `handleConversationViaRuntime` + 4 new DI injections | VERIFIED | Lines 1841-1989 implement both methods; Lines 181-190 inject all 4 deps |
| `libs/conversation/infrastructure/services/conversation-loop.service.ts` | `byokQueueTimeoutMs` field + 60s default | VERIFIED | Line 47: field declared; Line 127: `?? 60_000` default |
| `libs/code-review/infrastructure/agents/llm/agent-loop.ts` | `byokQueueTimeoutMs` in `AgentLoopSecrets`, threaded to all `throttledGenerateText` sites | VERIFIED | Line 801: field in secrets; all 9 call sites forward `queueTimeoutMs: secrets.byokQueueTimeoutMs` |
| `libs/code-review/infrastructure/agents/llm/byok-to-vercel.ts` | `BYOKConcurrencyLimiter.run()` accepts per-task `queueTimeoutMs`; `DEFAULT=0` | VERIFIED | Lines 451, 466-470: default 0, per-task param in `run()` |
| `test/unit/platform/use-cases/chat-with-kody-runtime-dispatch.spec.ts` | 7 integration tests covering all SCs | VERIFIED | 7/7 tests pass (1.576s runtime) |
| `test/unit/platform/use-cases/byok-queue-timeout.spec.ts` | PERF-03 characterization: review holds slot → conversation times out | VERIFIED | 2/2 tests pass (0.592s runtime) |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `handleConversation()` | `handleConversationViaRuntime()` | `useNewRuntime` boolean from env override or PostHog | WIRED | `chatWithKodyFromGit.use-case.ts:1873-1874` |
| `handleConversation()` | `conversationAgentUseCase.execute()` | `!useNewRuntime` fallback | WIRED | Lines 1877-1883 |
| `handleConversationViaRuntime()` | `runConversationLoop` | direct import + `try` block | WIRED | Lines 12, 1941-1956 |
| `runConversationLoop` | `sessionManager.materializeInitialMessages` | `input.sessionManager` injected from use case | WIRED | `conversation-loop.service.ts:91-92` |
| `runConversationLoop` | `appendTurn` | after loop, before return | WIRED | `conversation-loop.service.ts:149` |
| `runConversationLoop` | BYOK limiter with `queueTimeoutMs: 60_000` | `byokQueueTimeoutMs` threaded through `AgentLoopSecrets` → `throttledGenerateText` → `runWithBYOKLimiter` | WIRED | `conversation-loop.service.ts:127` → `agent-loop.ts:801,975` → `byok-to-vercel.ts:634,641` |
| `handleConversationViaRuntime` finally block | `leaseManager.release(leaseId)` | `finally` clause (Pitfall 1 prevention) | WIRED | `chatWithKodyFromGit.use-case.ts:1985-1987` |
| `buildConversationMemoryTools` → `KODUS_FIND_MEMORIES` + `KODUS_CREATE_MEMORY` | `runConversationLoop` `additionalTools` | `memoryTools` field → `additionalTools` spread in `runAgentLoop` | WIRED | `conversation-loop.service.ts:114` → `agent-loop.ts:915` |

---

### Requirements Coverage

| Requirement | Status | Evidence |
|-------------|--------|---------|
| RLLT-01 — Feature flag for org/repo-level rollout | SATISFIED | `FEATURE_FLAGS.conversationAgentRuntime` in registry; env override `API_CONVERSATION_RUNTIME_ENABLED`; PostHog org+repo-granularity call at `use-case.ts:1864-1869` |
| RLLT-02 — Flag flip with no redeploy; instant fallback | SATISFIED | Flag checked once per webhook at `handleConversation()` entry; `isInitialized` guard means self-hosted defaults to legacy; Test 3 (flag flip) verified |
| CONV-05 — Multi-turn context via `materializeInitialMessages` | SATISFIED | `sessionManager` wired into `runConversationLoop`; `prKey` stable; `materializeInitialMessages` called at turn start; `appendTurn` at turn end |
| PERF-03 — BYOK contention bounded; no infinite hang | SATISFIED | `byokQueueTimeoutMs: 60_000` default in `runConversationLoop`; per-task timeout fix in `BYOKConcurrencyLimiter.run()`; BYOK error caught and returned as user string; PERF-03 test passes |
| OBS-01 / OBS-02 (instrumentation labels) | SCAFFOLDED | Phase 4 labels (`sandboxState`, `byokProvider`, `commandType`) emitted in structured log at `use-case.ts:1928-1939`; actual metric aggregation deferred to Phase 4 (by design) |

---

### Anti-Patterns Found

None detected. Specific checks run:

- `try/finally` for lease release: PRESENT at `use-case.ts:1985-1987`
- BYOK error caught, not re-thrown: CONFIRMED at `use-case.ts:1959-1984`
- Flag check at entry only (not mid-loop): CONFIRMED — `useNewRuntime` set once at top of `handleConversation()`
- `handleConversationViaRuntime` does not call `codeManagementService` directly: CONFIRMED — returns `string`, posting code unchanged in `handleConversationFlow()`
- No TODO/FIXME in Phase 3 critical path: CONFIRMED

---

### Human Verification Required

None. All Phase 3 success criteria are fully verifiable programmatically via code inspection and test execution.

The following items are intentionally deferred to Phase 4 (not gaps):
- Actual latency measurement (OBS-01 p50/p95 data)
- Sync-vs-async UX decision (requires real traffic)
- End-to-end smoke test with a live E2B sandbox and real LLM call

---

### Summary

Phase 3 goal is fully achieved. All 6 must-haves verified with code evidence and passing tests:

1. **SC-1 (Flag ON → runtime)**: `handleConversation()` evaluates env override then PostHog flag; routes to `handleConversationViaRuntime()` which acquires lease, calls `runConversationLoop`, returns reply string. 7 tests pass.

2. **SC-2 (Multi-turn)**: `ConversationSessionManager` injected into use case and passed through to `runConversationLoop`, which calls `materializeInitialMessages(prKey)` at start and `appendTurn` at end. `prKey` is stable across webhook invocations. Test 7 confirms wiring identity.

3. **SC-3 (Flag OFF = legacy)**: `posthog.isInitialized` guard ensures self-hosted instances without PostHog key AND without env override stay on legacy path. `conversationAgentUseCase.execute()` invoked unchanged. Tests 2 and 3 cover flag OFF and flag-flip scenarios.

4. **SC-4 (Sandbox reuse)**: `SandboxLeaseManager.acquire()` returns `wasCreated: false` for joiner path (lines 376, 396 of service). `AcquireResult.wasCreated` field in contract. Use case derives `sandboxState='paused-resumed'` label. Test 4 confirms this instrumentation.

5. **SC-5 (BYOK contention bounded)**: `byokQueueTimeoutMs` defaults to `60_000` in `runConversationLoop` (not overridable to 0 by accident). Bug fixed: `BYOKConcurrencyLimiter` now accepts per-task timeout so review (0=infinite) and conversation (60s) share one limiter instance. BYOK timeout error caught in `handleConversationViaRuntime` and returned as user-visible apology string. PERF-03 test confirms timeout fires within 100ms when slot held.

6. **CONV-05 (Memory tools)**: `KODUS_FIND_MEMORIES` and `KODUS_CREATE_MEMORY` present in `buildConversationMemoryTools` output; passed as `memoryTools` to `runConversationLoop`; spread into `additionalTools` for `runAgentLoop`; merged into tool set at `agent-loop.ts:915`. Test 6 confirms both keys present when `kodyRulesService` is wired.

---

_Verified: 2026-05-04_
_Verifier: Claude (gsd-verifier)_
