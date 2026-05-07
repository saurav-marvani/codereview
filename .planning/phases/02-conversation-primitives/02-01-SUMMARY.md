---
phase: 02-conversation-primitives
plan: "01"
subsystem: agent-loop
tags: [ai-sdk, agent-loop, extension-points, tools, conversation]

# Dependency graph
requires:
  - phase: 01-agent-migration
    provides: EXT-01 (doneToolSchema) and EXT-02 (initialMessages) on AgentLoopInput

provides:
  - EXT-03: additionalTools optional field on AgentLoopInput allowing non-review callers to inject extra tools into the generateText call

affects:
  - 02-02-conversation-primitives (ConversationAgentService will use additionalTools to inject memory tools)
  - future surfaces needing to extend the agent tool set without forking agent-loop.ts

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Optional extension field pattern: add optional field to AgentLoopInput with JSDoc constraining callers; spread into tools with nullish coalescing guard"

key-files:
  created: []
  modified:
    - libs/code-review/infrastructure/agents/llm/agent-loop.ts
    - test/unit/code-review/agent-loop-extensions.spec.ts

key-decisions:
  - "additionalTools uses Record<string, any> (not a typed union) to remain generic — specific tool types live in the caller, not agent-loop.ts"
  - "Spread order is buildAgentTools first, then additionalTools — caller can override native tools if needed, though review callers MUST NOT"
  - "isSelfContained check runs after merge: if remoteCommands is undefined AND additionalTools provided, isSelfContained=false — correct for conversation+memory tools on NullSandbox"

patterns-established:
  - "MAINT-02: additionalTools must never appear in libs/code-review/pipeline/stages/ — verified by grep guard in plan"
  - "EXT-03 test pattern: assert callArgs.tools contains injected key, not mock.execute was called"

# Metrics
duration: 8min
completed: 2026-05-04
---

# Phase 02 Plan 01: Agent Loop additionalTools Extension Point Summary

**Generic `additionalTools` spread on `AgentLoopInput` (EXT-03) lets non-review callers inject memory and other tools into `runAgentLoop` without forking the runtime.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-05-04T19:40:00Z
- **Completed:** 2026-05-04T19:48:56Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Added `additionalTools?: Record<string, any>` to `AgentLoopInput` with JSDoc labeling it for non-review callers only (EXT-03)
- Merged `additionalTools` into the tools object inside `runAgentLoop` via `{ ...buildAgentTools(...), ...(input.additionalTools ?? {}) }`
- Added EXT-03 integration test; all 4 tests in agent-loop-extensions.spec.ts pass
- MAINT-02 verified: zero references to `additionalTools` in `libs/code-review/pipeline/stages/`

## Task Commits

Each task was committed atomically:

1. **Task 1: Add additionalTools field to AgentLoopInput and merge in runAgentLoop** - `95faa8f73` (feat)
2. **Task 2: Write additionalTools integration test** - `8adfddb5f` (test)

**Plan metadata:** (docs commit below)

## Files Created/Modified

- `libs/code-review/infrastructure/agents/llm/agent-loop.ts` — Added `additionalTools?: Record<string, any>` field to `AgentLoopInput` interface (line 762) and replaced bare `buildAgentTools(...)` call with object spread merge (line 898-907)
- `test/unit/code-review/agent-loop-extensions.spec.ts` — Added EXT-03 test asserting `TEST_EXTRA_TOOL` appears in `callArgs.tools` passed to `generateText`

## Decisions Made

- `additionalTools` typed as `Record<string, any>` (not a narrower union) — keeps agent-loop.ts generic; specific tool schemas live in callers, not the loop
- Spread order is `buildAgentTools` output first, then `additionalTools` — allows caller override if ever needed, while review callers are explicitly prohibited from setting the field
- `isSelfContained` runs after the merge: a NullSandbox conversation caller that provides `additionalTools` will correctly get `isSelfContained=false`, preventing premature loop termination

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

Minor: Jest CLI flag `--testPathPattern` was replaced by `--testPathPatterns` (plural) in the installed Jest version. Used the correct flag; no impact on implementation.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- EXT-03 is the only review-side file change in Phase 2; it is complete
- Plan 02-02 (ConversationAgentService) can now call `runAgentLoop` with `additionalTools` to inject memory/session tools
- MAINT-02 constraint is verified and documented — future contributors must not add `additionalTools` to review pipeline stages

---
*Phase: 02-conversation-primitives*
*Completed: 2026-05-04*
