---
phase: 03-wire-up-rollout
plan: 01
subsystem: infra
tags: [posthog, feature-flags, sandbox, typescript]

# Dependency graph
requires:
  - phase: 02-conversation-primitives
    provides: runConversationLoop wrapper + ConversationSessionManager built in Phase 2
provides:
  - FEATURE_FLAGS.conversationAgentRuntime ('conversation-agent-runtime') in posthog registry
  - buildPrKey(orgId, repoId, prNumber) canonical helper exported from sandbox contract
  - AcquireResult.wasCreated boolean field for Phase 4 instrumentation
  - API_CONVERSATION_RUNTIME_ENABLED env override documented in .env.example
affects:
  - 03-02-PLAN
  - 03-03-PLAN
  - 04-instrumentation

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Feature flag registration: add entry to FEATURE_FLAGS object in posthog/index.ts — type-safe via as const"
    - "prKey canonical form: '{orgId}:{repoId}:{prNumber}' produced by buildPrKey helper, not inline template literals"
    - "AcquireResult shape: wasCreated:true for cold-create (creator path), wasCreated:false for joiner/connect paths"

key-files:
  created: []
  modified:
    - libs/common/utils/posthog/index.ts
    - libs/sandbox/domain/contracts/sandbox-lease-manager.contract.ts
    - libs/sandbox/infrastructure/services/sandbox-lease-manager.service.ts
    - .env.example

key-decisions:
  - "wasCreated boolean set on all three return sites in sandbox-lease-manager.service.ts: handleCreatorPath returns true; connectToExisting (both no-key and E2B paths) returns false"
  - "buildPrKey added to sandbox contract (not a new file) — co-located with AcquireResult and ISandboxLeaseManager for discoverability"
  - "conversationAgentRuntime placed after agentReview in FEATURE_FLAGS — keeps semantically related agent-runtime flags adjacent"

patterns-established:
  - "Env override pattern: API_{FEATURE}_ENABLED= with PostHog bypass comment, matching the existing API_AGENT_REVIEW_ENABLED= convention"

# Metrics
duration: 2min
completed: 2026-05-04
---

# Phase 3 Plan 01: Wire-up Rollout — Foundations Summary

**FEATURE_FLAGS.conversationAgentRuntime registered, buildPrKey helper extracted from inline template literals, and AcquireResult.wasCreated added for Phase 4 cold-create vs paused-resume labeling**

## Performance

- **Duration:** 2 min
- **Started:** 2026-05-04T21:30:03Z
- **Completed:** 2026-05-04T21:32:04Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments
- Added `conversationAgentRuntime: 'conversation-agent-runtime'` to `FEATURE_FLAGS` in posthog registry — type-safe, ready for Plan 03-03 flag check
- Documented `API_CONVERSATION_RUNTIME_ENABLED` env override in `.env.example` matching existing `API_AGENT_REVIEW_ENABLED` convention
- Exported `buildPrKey(organizationId, repositoryId, prNumber)` from `sandbox-lease-manager.contract.ts` — canonical prKey helper callable by Plan 03-03 webhook handlers
- Added `wasCreated: boolean` to `AcquireResult` interface — creator path returns `true`, all joiner/connect paths return `false`
- All 5 existing `sandbox-lease-manager.spec` tests pass unchanged

## Task Commits

Each task was committed atomically:

1. **Task 1: Add conversationAgentRuntime to FEATURE_FLAGS and document env override** - `0bfc8feb4` (feat)
2. **Task 2: Extract buildPrKey helper and add wasCreated to AcquireResult** - `3b5fcc140` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `libs/common/utils/posthog/index.ts` - Added `conversationAgentRuntime: 'conversation-agent-runtime'` after `agentReview` entry
- `libs/sandbox/domain/contracts/sandbox-lease-manager.contract.ts` - Added `wasCreated: boolean` to `AcquireResult`; added `buildPrKey` exported function
- `libs/sandbox/infrastructure/services/sandbox-lease-manager.service.ts` - Set `wasCreated: true` in creator path, `wasCreated: false` in both joiner/connect returns
- `.env.example` - Added `API_CONVERSATION_RUNTIME_ENABLED=` block after `API_AGENT_REVIEW_ENABLED=`

## Decisions Made
- `wasCreated` boolean set on all three return sites in `sandbox-lease-manager.service.ts`: `handleCreatorPath` returns `true`; `connectToExisting` (both no-key and E2B paths) returns `false`
- `buildPrKey` added to sandbox contract (not a new file) — co-located with `AcquireResult` and `ISandboxLeaseManager` for discoverability by Plan 03-03 callers
- `conversationAgentRuntime` placed after `agentReview` in `FEATURE_FLAGS` — keeps semantically related agent-runtime flags adjacent

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None — TypeScript check confirmed pre-existing errors in unrelated test files only (`cli-config.controller.spec.ts`, `team-cli-key.controller.spec.ts`, `classifyOrphanedSessions.cron.spec.ts`, `apps/cli` tests). No new errors introduced by this plan.

## User Setup Required

None — no external service configuration required. The `.env.example` change is documentation only.

## Next Phase Readiness
- `FEATURE_FLAGS.conversationAgentRuntime` ready for import in Plan 03-03 flag check
- `buildPrKey` ready for import in Plan 03-03 `chatWithKodyFromGit.use-case.ts`
- `AcquireResult.wasCreated` ready for Phase 4 instrumentation label emission
- No blockers for Plans 03-02 through 03-06

---
*Phase: 03-wire-up-rollout*
*Completed: 2026-05-04*
