---
phase: "02-conversation-primitives"
plan: "05"
subsystem: conversation
tags: [conversation, agent-loop, sandbox, session-manager, memory-tools]

dependency_graph:
  requires:
    - "02-01: additionalTools field on AgentLoopInput (EXT-03)"
    - "02-03: ConversationSessionManager + materializeInitialMessages/appendTurn"
    - "02-04: buildConversationMemoryTools factory"
  provides:
    - "runConversationLoop: plain async function entry point for conversation use case"
    - "ConversationLoopInput / ConversationLoopOutput types"
    - "CONVERSATION_DONE_SCHEMA = z.object({ reply: z.string() })"
  affects:
    - "02-06: integration tests"
    - "phase-03-chat-use-case: caller that owns sandbox lease lifecycle"

tech_stack:
  added: []
  patterns:
    - "Plain async function (not NestJS service) — callable from any service/handler"
    - "NullSandbox detection: sandbox.type === 'null' → remoteCommands:undefined"
    - "Caller-owned sandbox lease: no acquire/release/invalidate inside runConversationLoop"
    - "CONVERSATION_DONE_SCHEMA via doneToolSchema EXT-01 override"
    - "memoryTools spread into additionalTools (EXT-03)"
    - "skipHeavyPasses:true + skipSynthesisRescue:true always set for conversation path"

key_files:
  created:
    - libs/conversation/infrastructure/services/conversation-loop.service.ts
    - libs/conversation/infrastructure/services/conversation-loop.spec.ts
  modified: []

decisions:
  - "sandbox.remoteCommands accessed directly (not cast to any) — SandboxInstance contract exposes .remoteCommands for all types; null path returns undefined by conditional"
  - "byokProvider on ConversationLoopInput passes through to AgentLoopInput (not AgentLoopSecrets) — that is the correct field location confirmed in AgentLoopInput interface"
  - "Smoke test mocks runAgentLoop (not generateText) — appropriate for unit-testing the wiring layer rather than the agent runtime"
  - "Text fallback: output.text used when findings.reply absent — handles NullSandbox single-shot path where done-tool may not be called"

metrics:
  duration: "~8 min"
  completed_date: "2026-05-04"
  tasks_completed: 2
  files_created: 2
  files_modified: 0
---

# Phase 02 Plan 05: runConversationLoop Entry Point Summary

**One-liner:** Plain async function wrapping runAgentLoop for conversation use case — NullSandbox detection, CONVERSATION_DONE_SCHEMA done-tool override, session memory seeding, memory tools wiring, and no sandbox lease ownership.

## What Was Built

`runConversationLoop` in `libs/conversation/infrastructure/services/conversation-loop.service.ts` — the single entry point that Phase 3 will call for every `@kody` conversation turn. It assembles all the Phase 2 primitives into one coordinated call:

1. **NullSandbox detection** — `sandbox.type === 'null'` → `remoteCommands: undefined` → agent runs single-shot (isSelfContained=true). Memory tools still work in this path.
2. **Session seeding** — `sessionManager.materializeInitialMessages(prKey)` called before `runAgentLoop`, injecting up to 20 prior turns as `initialMessages` (EXT-02).
3. **doneToolSchema override** — `CONVERSATION_DONE_SCHEMA = z.object({ reply: z.string() })` replaces the review `_findingsSchema` (EXT-01), so the agent emits a text reply instead of `CodeSuggestion[]`.
4. **Memory tools** — `memoryTools ?? {}` spread into `additionalTools` (EXT-03), giving the agent KODUS_CREATE_MEMORY and KODUS_FIND_MEMORIES.
5. **Reply extraction** — `output.findings.reply` (done-tool path) with fallback to `output.text` (NullSandbox path).
6. **Session persistence** — `sessionManager.appendTurn(prKey, assistantTurn)` after the loop completes, storing reply + tool calls.
7. **No lease management** — zero `acquire/release/invalidate` calls; JSDoc makes caller ownership explicit.

## Performance

- **Duration:** ~8 min
- **Started:** 2026-05-04T20:00:00Z
- **Completed:** 2026-05-04T20:08:00Z
- **Tasks:** 2
- **Files created:** 2
- **Files modified:** 0

## Task Commits

1. **Task 1: Implement runConversationLoop** — `db1349f0a` (feat)
2. **Task 2: Smoke test (happy path)** — `a256b60d2` (test)

## Files Created/Modified

- `libs/conversation/infrastructure/services/conversation-loop.service.ts` — `runConversationLoop` async function + `ConversationLoopInput` / `ConversationLoopOutput` types + `CONVERSATION_DONE_SCHEMA` constant (164 lines)
- `libs/conversation/infrastructure/services/conversation-loop.spec.ts` — 3 smoke tests: happy path, NullSandbox remoteCommands:undefined, text fallback (158 lines)

## Decisions Made

- **`sandbox.remoteCommands` accessed directly (not cast to `any`):** `SandboxInstance` exposes `.remoteCommands` on all types; the NullSandbox branch simply returns `undefined` via the conditional — no cast needed, TypeScript is happy.
- **`byokProvider` on `ConversationLoopInput` passes to `AgentLoopInput`** (not `AgentLoopSecrets`): confirmed by reading the interface at line 734 — `byokProvider` is an input field, not a secret.
- **Smoke test mocks `runAgentLoop` directly:** This is the correct level for unit-testing the wiring layer. Mocking `generateText` (as EXT-01 tests do) would test the agent runtime itself — out of scope here.
- **Text fallback (`output.text`):** Required for the NullSandbox single-shot path where the agent returns a plain text response rather than calling the done-tool.

## Deviations from Plan

None — plan executed exactly as written. The plan's template code used `(input.sandbox as any).remoteCommands` but the actual `SandboxInstance` interface exposes `.remoteCommands` directly, so the cast was unnecessary and removed (minor improvement, same behavior).

## Test Results

3/3 smoke tests pass (0.633 s):
- happy path — returns `{ reply, steps, toolCalls }`, calls appendTurn, passes initialMessages
- NullSandbox path — passes `remoteCommands: undefined` to runAgentLoop
- text fallback — falls back to `output.text` when `findings.reply` absent

## Self-Check: PASSED

Files verified:
- FOUND: libs/conversation/infrastructure/services/conversation-loop.service.ts
- FOUND: libs/conversation/infrastructure/services/conversation-loop.spec.ts

Commits verified:
- FOUND: db1349f0a (feat(02-05): implement runConversationLoop)
- FOUND: a256b60d2 (test(02-05): smoke test for runConversationLoop happy path)

Success criteria:
- [x] `runConversationLoop` exported as plain async function
- [x] Returns `{ reply, steps, toolCalls }` — never `CodeSuggestion[]`
- [x] NullSandbox path via `sandbox.type === 'null'` → `remoteCommands: undefined`
- [x] No `acquire/release/invalidate` calls (grep confirmed)
- [x] `sessionManager.materializeInitialMessages` before loop
- [x] `sessionManager.appendTurn` after loop
- [x] `buildConversationMemoryTools` output spread via `additionalTools`
- [x] Smoke test passes (3/3)
- [x] No unrelated files committed
- [x] No review-side files modified (MAINT-01 and MAINT-02 verified)

## Next Phase Readiness

- Phase 3 (`ChatUseCase`) can now call `runConversationLoop(input)` after acquiring a sandbox lease, wrapping in try/finally with `leaseManager.release(leaseId)`.
- All Phase 2 primitives complete: `additionalTools` (02-01), `ConversationModule` (02-02), `ConversationSessionManager` (02-03), `buildConversationMemoryTools` (02-04), `runConversationLoop` (02-05).
- Plan 02-06 (integration tests) is the remaining Phase 2 task.

---
*Phase: 02-conversation-primitives*
*Completed: 2026-05-04*
