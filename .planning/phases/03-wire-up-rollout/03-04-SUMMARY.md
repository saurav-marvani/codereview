---
phase: 03-wire-up-rollout
plan: "04"
subsystem: code-review
tags: [byok, concurrency, conversation, agent-loop, queue-timeout, performance]

# Dependency graph
requires:
  - phase: 02-conversation-primitives
    provides: runConversationLoop, ConversationLoopInput, runAgentLoop, AgentLoopSecrets
  - phase: 03-01
    provides: FEATURE_FLAGS.conversationAgentRuntime, buildPrKey, AcquireResult.wasCreated
provides:
  - byokQueueTimeoutMs field in ConversationLoopInput (60s default for conversation calls)
  - byokQueueTimeoutMs field in AgentLoopSecrets (generic, MAINT-02 compliant)
  - queueTimeoutMs threading through throttledGenerateText to runWithBYOKLimiter at all call sites
  - PERF-03 characterization test confirming [BYOK-QUEUE-TIMEOUT] fires when slot is held
  - Bug fix: BYOKConcurrencyLimiter queueTimeoutMs is now per-task not per-limiter-instance
affects: [03-03, 03-05, 03-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-task queue timeout: BYOKConcurrencyLimiter.run() accepts queueTimeoutMs so review (0=infinite) and conversation (60_000) share the same limiter instance"
    - "MAINT-02: byokQueueTimeoutMs is a generic field in AgentLoopSecrets, not conversation-specific; review callers get undefined → 0 → infinite wait (unchanged)"

key-files:
  created:
    - test/unit/platform/use-cases/byok-queue-timeout.spec.ts
  modified:
    - libs/conversation/infrastructure/services/conversation-loop.service.ts
    - libs/code-review/infrastructure/agents/llm/agent-loop.ts
    - libs/code-review/infrastructure/agents/llm/byok-to-vercel.ts

key-decisions:
  - "03-04: queueTimeoutMs is per-task in BYOKConcurrencyLimiter.run() — moved from constructor/cache to run() parameter so review (queueTimeoutMs=0) and conversation (queueTimeoutMs=60_000) contend on the same shared limiter instance"
  - "03-04: limiter cache key no longer discriminates by queueTimeoutMs — only concurrency (maxConcurrentRequests) determines limiter identity"
  - "03-04: byokQueueTimeoutMs defaults to 60_000 in runConversationLoop (not in AgentLoopSecrets) — conversation always gets bounded queue wait; callers can override to 0 to opt out"

patterns-established:
  - "Per-task queue timeout: pass queueTimeoutMs to limiter.run(), not to limiter constructor, so callers with different timeouts share the same concurrency slot"

# Metrics
duration: 18min
completed: 2026-05-04
---

# Phase 03 Plan 04: BYOK Queue Timeout Threading Summary

**byokQueueTimeoutMs threaded from ConversationLoopInput through AgentLoopSecrets to runWithBYOKLimiter at all throttledGenerateText call sites, with per-task timeout fix ensuring review and conversation share the same BYOK limiter slot**

## Performance

- **Duration:** ~18 min
- **Started:** 2026-05-04T~T00:09Z
- **Completed:** 2026-05-04
- **Tasks:** 2
- **Files modified:** 4 (including byok-to-vercel.ts auto-fix)

## Accomplishments
- `byokQueueTimeoutMs?: number` added to `ConversationLoopInput` with 60s default in `runConversationLoop`
- `byokQueueTimeoutMs?: number` added to `AgentLoopSecrets` as a generic MAINT-02-compliant field
- All 9 `throttledGenerateText` call sites in `agent-loop.ts` forward `queueTimeoutMs: secrets.byokQueueTimeoutMs`
- Inner pass functions (`runCoverageRecoveryPass`, `runLowCoverageSecondChance`, `runSynthesisRescuePass`, `structureVerificationDecisionWithFallbackModel`, `structureWithFallbackModel`) updated with `queueTimeoutMs` parameter threading
- PERF-03 characterization test: 2 tests confirm `[BYOK-QUEUE-TIMEOUT]` fires within 100ms when review holds slot
- Bug fix: `BYOKConcurrencyLimiter` queueTimeoutMs moved from constructor to `run()` so all callers share one limiter

## Task Commits

Each task was committed atomically:

1. **Task 1: Add byokQueueTimeoutMs to ConversationLoopInput and thread through agent-loop** - `b7c0c81f7` (feat)
2. **Task 2: Write BYOK characterization test (PERF-03)** - `86c8c14c5` (test + fix)

**Plan metadata:** (docs commit below)

## Files Created/Modified
- `libs/conversation/infrastructure/services/conversation-loop.service.ts` - Added `byokQueueTimeoutMs?: number` to `ConversationLoopInput`; default 60_000 passed to `runAgentLoop` secrets
- `libs/code-review/infrastructure/agents/llm/agent-loop.ts` - Added `byokQueueTimeoutMs` to `AgentLoopSecrets`; added `queueTimeoutMs` to `throttledGenerateText` signature; threaded through all 9 call sites including inner pass functions
- `libs/code-review/infrastructure/agents/llm/byok-to-vercel.ts` - Bug fix: `BYOKConcurrencyLimiter.run()` now accepts `queueTimeoutMs` as a per-task parameter; removed from constructor and cache key
- `test/unit/platform/use-cases/byok-queue-timeout.spec.ts` - PERF-03: 2-test characterization suite confirming `[BYOK-QUEUE-TIMEOUT]` fires and free-slot path succeeds

## Decisions Made
- `queueTimeoutMs` is per-task in `BYOKConcurrencyLimiter.run()` — not stored on the limiter constructor — so review (queueTimeoutMs=0) and conversation (queueTimeoutMs=60_000) contend on the same shared limiter instance
- Limiter cache key no longer discriminates by `queueTimeoutMs`; only `concurrency` (maxConcurrentRequests) determines limiter identity
- `byokQueueTimeoutMs` defaults to 60_000 in `runConversationLoop` (not in `AgentLoopSecrets`) — conversation always gets bounded queue wait; review callers leave it undefined → 0 → infinite (unchanged behavior)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] BYOKConcurrencyLimiter queueTimeoutMs was per-limiter, not per-task**
- **Found during:** Task 2 (writing PERF-03 test)
- **Issue:** The limiter cache used `queueTimeoutMs` as a discriminator: review with `queueTimeoutMs:0` and conversation with `queueTimeoutMs:100` would get **separate** `BYOKConcurrencyLimiter` instances → no shared concurrency slot → test would not demonstrate contention
- **Fix:** Moved `queueTimeoutMs` from `BYOKConcurrencyLimiter` constructor to `BYOKConcurrencyLimiter.run()` parameter; removed from limiter cache key; `runWithBYOKLimiter` passes it to `limiter.run()` at call time
- **Files modified:** `libs/code-review/infrastructure/agents/llm/byok-to-vercel.ts`
- **Verification:** PERF-03 test passes — review holds slot, conversation times out with `[BYOK-QUEUE-TIMEOUT]` within 100ms
- **Committed in:** `86c8c14c5` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug)
**Impact on plan:** Fix was essential for the test to characterize actual contention behavior. Without it, review and conversation would use separate limiters and the timeout would never fire.

## Issues Encountered
None beyond the auto-fixed bug above.

## Next Phase Readiness
- `byokQueueTimeoutMs` is fully threaded; 03-03 (`handleConversationViaRuntime`) can pass it when calling `runConversationLoop` to complete the PERF-03 mitigation
- 03-05 and 03-06 (feature flag + rollout) are unblocked
- All 16 tests across conversation-loop, agent-loop-extensions, and byok-queue-timeout suites pass

---
*Phase: 03-wire-up-rollout*
*Completed: 2026-05-04*
