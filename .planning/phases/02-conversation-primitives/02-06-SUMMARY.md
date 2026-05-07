---
phase: "02-conversation-primitives"
plan: "06"
subsystem: conversation
tags: [conversation, tests, tdd, memory-tools, agent-loop, maint-02]

dependency_graph:
  requires:
    - "02-01: additionalTools EXT-03"
    - "02-04: buildConversationMemoryTools"
    - "02-05: runConversationLoop"
  provides:
    - "TEST-02: run-conversation-loop.spec.ts (7 tests)"
    - "TEST-03: memory-regression.spec.ts (5 tests)"
  affects:
    - "phase-03: integration readiness verified before live traffic"

tech_stack:
  added: []
  patterns:
    - "jest.mock('ai') with jest.requireActual — same pattern as Phase 1 agent-loop-extensions.spec.ts"
    - "createMockRemoteCommands() from test/fixtures — no E2B mock invented"
    - "makeDoneToolResponse(): toolCalls[submitResult] for done-tool extraction path (E2B tests)"
    - "makeTextResponse(): plain text for isSelfContained=true path (NullSandbox tests)"
    - "In-memory store pattern for cross-invocation persistence (SC-2)"

key_files:
  created:
    - test/unit/conversation/run-conversation-loop.spec.ts
    - test/unit/conversation/memory-regression.spec.ts
  modified:
    - libs/code-review/infrastructure/agents/llm/agent-loop.ts

decisions:
  - "makeDoneToolResponse uses toolCalls:[{toolName:submitResult}] not text JSON — done-tool extraction path required for E2B E2E tests; text JSON falls back to raw string in output.text"
  - "NullSandbox test asserts reply.length > 0 not exact string — isSelfContained=true skips done-tool, text used directly; exact value depends on tryParseFindings fallback chain"
  - "Rule 1 fix: !skipHeavyPasses guard added to verify check at agent-loop.ts:1849 — findings.suggestions undefined crash when doneToolSchema overrides _findingsSchema on E2B sandbox"

metrics:
  duration: "~6 min"
  completed_date: "2026-05-04"
  tasks_completed: 2
  files_created: 2
  files_modified: 1
---

# Phase 02 Plan 06: Integration Tests Summary

**One-liner:** TEST-02 (7 tests) and TEST-03 (5 tests) validate all Phase 2 success criteria — done-tool reply extraction, message-history seeding, NullSandbox path, cross-invocation persistence, MAINT-02 grep guard, and memory adapter behavior — using mocked LLM and createMockRemoteCommands().

## What Was Built

Two test files that complete Phase 2 test coverage:

**`test/unit/conversation/run-conversation-loop.spec.ts` (TEST-02, 7 tests):**
- SC-1 happy path: done-tool extraction returns plain text reply (not CodeSuggestion[])
- SC-1 message-history: seeded prior turn appears in generateText messages array
- SC-1 tool-call sequencing: done-tool submitResult fires, reply extracted, toolCalls array returned
- SC-4 NullSandbox: completes without throwing, returns non-empty reply
- SC-4 NullSandbox tools: generateText receives no grep/readFile tools (isSelfContained=true)
- SC-2 cross-invocation persistence: second call receives first turn via sessionManager
- SC-5 MAINT-02: static grep CI guard — review pipeline stages have zero additionalTools references

**`test/unit/conversation/memory-regression.spec.ts` (TEST-03, 5 tests):**
- SC-3 explicit create: action:created returned with link and confirmation message
- SC-3 implicit capture: createOrUpdateMemory called with correct organizationId (Pitfall 3)
- SC-3 duplicate detection: action:skipped forwarded correctly
- SC-3 pending approval: requiresApproval:true reflected in output
- SC-3 findMemories: array passthrough with correct org binding

## Performance

- **Duration:** ~6 min
- **Started:** 2026-05-04T20:05:37Z
- **Completed:** 2026-05-04T20:11:00Z
- **Tasks:** 2
- **Files created:** 2
- **Files modified:** 1 (Rule 1 bug fix)

## Task Commits

1. **Task 1: TEST-02 + Rule 1 bug fix** — `4c8d48c90` (test)
2. **Task 2: TEST-03** — `99f725686` (test)

## Files Created/Modified

- `test/unit/conversation/run-conversation-loop.spec.ts` — 7 tests for runConversationLoop E2E
- `test/unit/conversation/memory-regression.spec.ts` — 5 tests for buildConversationMemoryTools
- `libs/code-review/infrastructure/agents/llm/agent-loop.ts` — Line 1849: Rule 1 verify guard fix

## Decisions Made

- **`makeDoneToolResponse()` uses toolCalls with submitResult:** The agent-loop's `extractDoneToolResult` only fires when `result.toolCalls` contains `toolName: 'submitResult'`. Without this, `output.findings.reply` is absent and the service falls back to `output.text` (raw JSON string). E2B path tests need the done-tool pattern to get clean text replies.

- **NullSandbox reply assertion uses `.length > 0`:** For `isSelfContained=true`, the agent-loop skips done-tool extraction and returns `output.text` directly. The exact text depends on the `tryParseFindings` fallback chain; testing "non-empty string" is the correct invariant rather than exact value equality.

- **Rule 1 fix committed with Task 1:** The bug was discovered while writing the tool-call sequencing test (Task 1), so it belongs in the same commit.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Crash in agent-loop verify guard when doneToolSchema overrides _findingsSchema**

- **Found during:** Task 1 (tool-call sequencing test)
- **Issue:** Line 1849 `if (!isSelfContained && findings.suggestions.length > 0)` crashes with `TypeError: Cannot read properties of undefined (reading 'length')` when doneToolSchema=CONVERSATION_DONE_SCHEMA and sandbox.type='e2b'. `findings.suggestions` is undefined because CONVERSATION_DONE_SCHEMA produces `{ reply }` not `{ suggestions }`.
- **Fix:** Changed to `if (!isSelfContained && !skipHeavyPasses && (findings.suggestions?.length ?? 0) > 0)` — adds `!skipHeavyPasses` guard (conversation always sets `skipHeavyPasses:true`) and safe optional chaining.
- **Files modified:** `libs/code-review/infrastructure/agents/llm/agent-loop.ts` line 1849
- **Commit:** `4c8d48c90`

## Phase 2 Success Criteria Coverage

| SC | Test | Test File | Pass |
|----|------|-----------|------|
| SC-1 happy path | returns text reply not CodeSuggestion[] | run-conversation-loop.spec.ts | ✓ |
| SC-1 history | seeded turn in generateText messages | run-conversation-loop.spec.ts | ✓ |
| SC-2 persistence | second call sees first turn | run-conversation-loop.spec.ts | ✓ |
| SC-3 memory | explicit/implicit/duplicate/approval/find | memory-regression.spec.ts | ✓ |
| SC-4 NullSandbox | single-shot, no native tools | run-conversation-loop.spec.ts | ✓ |
| SC-5 MAINT-02 | grep guard for additionalTools | run-conversation-loop.spec.ts | ✓ |

## Self-Check: PASSED

Files verified:
- FOUND: test/unit/conversation/run-conversation-loop.spec.ts
- FOUND: test/unit/conversation/memory-regression.spec.ts

Commits verified:
- FOUND: 4c8d48c90 (test(02-06): TEST-02 runConversationLoop end-to-end tests)
- FOUND: 99f725686 (test(02-06): TEST-03 memory creation regression tests)

Test run: 12/12 tests pass (7 + 5)

Success criteria:
- [x] run-conversation-loop.spec.ts: 7 tests covering SC-1, SC-2, SC-4, SC-5
- [x] memory-regression.spec.ts: 5 tests covering SC-3
- [x] All tests use mock LLM and createMockRemoteCommands() — zero real external dependencies
- [x] All Phase 2 success criteria have at least one automated test
- [x] MAINT-02 grep guard passes (no additionalTools in review pipeline stages)
- [x] No unrelated files committed

## Phase 2 Completion

All 6 plans complete. Phase 2 primitives:
- 02-01: additionalTools field (EXT-03)
- 02-02: ConversationModule + ConversationThreadRepository
- 02-03: ConversationSessionManager (load/appendTurn/materializeInitialMessages)
- 02-04: buildConversationMemoryTools (KODUS_CREATE_MEMORY, KODUS_FIND_MEMORIES)
- 02-05: runConversationLoop (NullSandbox, CONVERSATION_DONE_SCHEMA, session wiring)
- 02-06: Integration tests (TEST-02 + TEST-03) ← this plan

Phase 3 (ChatUseCase) can now be built on verified primitives.

---
*Phase: 02-conversation-primitives*
*Completed: 2026-05-04*
