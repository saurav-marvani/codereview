---
phase: 03-wire-up-rollout
plan: "03"
subsystem: platform/conversation-dispatch
tags: [feature-flag, conversation, runtime, byok, sandbox, lease]
dependency_graph:
  requires:
    - 03-01  # FEATURE_FLAGS.conversationAgentRuntime, buildPrKey, AcquireResult.wasCreated
    - 03-02  # SandboxModule + ConversationModule wired into PlatformModule
  provides:
    - handleConversationViaRuntime private method in ChatWithKodyFromGitUseCase
    - flag-checked dispatch in handleConversation()
  affects:
    - "@kody comment routing for all git platforms (GitHub, GitLab, Bitbucket, Azure)"
    - "03-06 integration test — wires against real NestJS DI graph"
tech_stack:
  added: []
  patterns:
    - "env-override → posthog feature flag → legacy fallback (mirrors code-review-pipeline.provider.ee.ts)"
    - "try/finally lease release (Pitfall 1: lease leak prevention)"
    - "byokToVercelModel(byokConfig ?? undefined) for model resolution"
key_files:
  modified:
    - libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case.ts
    - libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case.spec.ts
decisions:
  - "[03-03] posthog.isInitialized guard preserves self-hosted default: no PostHog key + no env override = legacy path (same pattern as agentReview flag in code-review-pipeline.provider.ee.ts)"
  - "[03-03] handleConversationViaRuntime catches BYOK queue errors with specific user message vs generic fallback — Pitfall 7: never re-throw to comment-posting layer"
  - "[03-03] logger accessed via (this as any).logger ?? console — avoids private field access restriction while preserving structured logging when available"
  - "[03-03] sandboxState label (null/cold-create/paused-resumed) computed eagerly before try block for Phase 4 instrumentation without additional await"
metrics:
  duration: "~12 min"
  completed: "2026-05-04"
  tasks: 2
  files: 2
---

# Phase 3 Plan 03: Conversation Runtime Flag Dispatch Summary

**One-liner:** Feature-flag dispatch in `handleConversation()` routes `@kody` webhook traffic through `runConversationLoop` (sandbox + BYOK + session memory) when `conversationAgentRuntime` flag is on, with guaranteed lease release in `finally`.

## What Was Built

### Task 1: New DI injections in ChatWithKodyFromGitUseCase

Added four new constructor parameters with `@Inject` decorators:
- `leaseManager: ISandboxLeaseManager` (SANDBOX_LEASE_MANAGER_TOKEN)
- `sessionManager: IConversationSessionManager` (CONVERSATION_SESSION_MANAGER_TOKEN)
- `kodyRulesService: IKodyRulesService` (KODY_RULES_SERVICE_TOKEN)
- `permissionValidationService: PermissionValidationService`

New imports added: `byokToVercelModel`, `posthog`, `FEATURE_FLAGS`, `runConversationLoop`, `buildConversationMemoryTools`, all contract tokens.

**Commit:** `dec35a0a4`

### Task 2: Flag dispatch + handleConversationViaRuntime

**`handleConversation()` — new flag dispatch logic:**
1. Read `API_CONVERSATION_RUNTIME_ENABLED` env override (self-hosted admin force-on)
2. If not set, check `posthog.isInitialized` → call `posthog.isFeatureEnabled(conversationAgentRuntime, orgId, ...)`
3. Flag ON → delegate to `handleConversationViaRuntime()`
4. Flag OFF / posthog uninitialized → legacy `conversationAgentUseCase.execute()` (unchanged)

**`handleConversationViaRuntime()` — new runtime path:**
1. Build `prKey` via `buildPrKey(orgId, repoId, prNumber)`
2. `leaseManager.acquire(prKey, 'conversation', 5 * 60 * 1000)` — 5 min TTL
3. `permissionValidationService.getBYOKConfig(orgAndTeamData)` → `byokToVercelModel(byokConfig ?? undefined)`
4. `runConversationLoop({ model, systemPrompt, userPrompt, prKey, sandbox, sessionManager, memoryTools, ... })`
5. Return `result.reply`
6. **catch:** BYOK queue errors → specific user message; all other errors → generic message (never re-throw)
7. **finally:** `leaseManager.release(leaseId)` — unconditional

`CONVERSATION_SYSTEM_PROMPT` module-level constant added before the class.

**Test file updated:** Added posthog mock (`isInitialized: false`) + 4 new DI mock args to constructor call — keeps all 2 existing tests passing on legacy path.

**Commit:** `94c634cad`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Existing spec broken by new required constructor parameters**
- **Found during:** Task 2 (running existing tests)
- **Issue:** `chatWithKodyFromGit.use-case.spec.ts` instantiated the class with 3 args; adding 4 new required params caused TypeScript/Jest instantiation failure
- **Fix:** Added posthog jest.mock + 4 new mock objects (leaseManager, sessionManager, kodyRulesService, permissionValidationService) to the spec; updated `new ChatWithKodyFromGitUseCase(...)` call with all 7 args
- **Files modified:** `chatWithKodyFromGit.use-case.spec.ts`
- **Outcome:** Both existing tests pass; flag stays on legacy path (posthog.isInitialized=false in mock)

## Self-Check: PASSED

- FOUND: `libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case.ts`
- FOUND: `libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case.spec.ts`
- FOUND: commit `dec35a0` (Task 1 — DI injections)
- FOUND: commit `94c634c` (Task 2 — flag dispatch + runtime method)
- `handleConversationViaRuntime` appears 3 times (call site + definition + error log)
- `finally { leaseManager.release(leaseId) }` confirmed present
- `conversationAgentUseCase.execute` still present (legacy path unchanged)
- `byokToVercelModel` imported and called with `byokConfig ?? undefined`
- Comment posting code in `handleConversationFlow()` NOT modified
- 2 existing tests pass

## Success Criteria Verification

- [x] Flag ON → `handleConversationViaRuntime` called → `runConversationLoop` called with real `LanguageModel` (via `byokToVercelModel`)
- [x] Flag OFF → `conversationAgentUseCase.execute()` called (legacy, unchanged)
- [x] Self-hosted with no PostHog key: `posthog.isInitialized === false` → `useNewRuntime` stays false → legacy path runs
- [x] `runConversationLoop` error → user-visible string returned (never re-thrown)
- [x] `leaseManager.release(leaseId)` in `finally` — cannot be skipped
- [x] Multi-turn: `sessionManager` passed into `runConversationLoop` which calls `materializeInitialMessages(prKey)` (Phase 2 implementation)
- [x] All existing `ChatWithKodyFromGitUseCase` tests pass
