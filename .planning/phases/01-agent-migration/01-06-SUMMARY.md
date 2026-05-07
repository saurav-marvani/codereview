---
phase: 01-agent-migration
plan: 06
subsystem: api
tags: [vercel-ai-sdk, zod, agent-loop, extensibility, typescript]

# Dependency graph
requires: []
provides:
  - "AgentLoopInput.doneToolSchema: optional Zod schema override for the findings done-tool (EXT-01)"
  - "AgentLoopInput.initialMessages: optional ModelMessage[] for multi-turn context seeding (EXT-02)"
  - "buildDoneTools() parameterized with optional doneToolSchema — defaults to _findingsSchema"
affects:
  - "Phase 2 conversation wrapper — can now drive runAgentLoop with a custom done-tool schema and injected thread history"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Extension point via optional AgentLoopInput field: additive, zero-behavior-change when field is absent"
    - "ModelMessage[] (ai v6 type) used for multi-turn context injection"

key-files:
  created: []
  modified:
    - "libs/code-review/infrastructure/agents/llm/agent-loop.ts"

key-decisions:
  - "Used ModelMessage (ai v6) rather than CoreMessage (ai v5) — CoreMessage was renamed in the Vercel AI SDK v6 upgrade already in place in this repo"
  - "Verification pass call site (verifySingleFindingWithTools) also updated to pass input.doneToolSchema for consistency, though it only affects .verification tool which ignores the schema override"
  - "_verificationSchema is intentionally NOT parameterized: the verification pass is always review-specific; callers using doneToolSchema for non-review use cases should set skipHeavyPasses:true"

patterns-established:
  - "EXT-01: Optional doneToolSchema in AgentLoopInput — pass a Zod schema to change loop output type without forking the loop"
  - "EXT-02: Optional initialMessages in AgentLoopInput — inject [system, ...initialMessages, user] for multi-turn; falls back to system+prompt (cache-friendly) when absent"
  - "EXT-03: agent-tools.factory.ts untouched — native tools registry stays generic"

# Metrics
duration: 20min
completed: 2026-04-29
---

# Phase 01 Plan 06: Agent Loop Extension Points Summary

**Optional doneToolSchema and initialMessages added to runAgentLoop — non-review callers can now override the output schema and inject multi-turn history without forking the agent loop**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-04-29T00:00:00Z
- **Completed:** 2026-04-29T00:20:00Z
- **Tasks:** 1 of 1
- **Files modified:** 1

## Accomplishments

- Added `doneToolSchema?: z.ZodType` to `AgentLoopInput` — a Phase 2 conversation wrapper can pass `{ reply: z.string() }` instead of the review-specific `FindingsOutput` schema
- Added `initialMessages?: ModelMessage[]` to `AgentLoopInput` — multi-turn thread history can be seeded as `[system, ...initialMessages, user]`; absent = review path unchanged
- Updated `buildDoneTools()` to accept optional `doneToolSchema` parameter — all 4 call sites now pass `input.doneToolSchema`
- Zero behavior change for existing review callers: both fields are optional and default to pre-existing behavior
- All 3004 existing tests pass without modification

## Task Commits

Each task was committed atomically:

1. **Task 1: Parameterize doneToolSchema and inject initialMessages into AgentLoopInput** - `42c5e93fa` (feat)

## Files Created/Modified

- `libs/code-review/infrastructure/agents/llm/agent-loop.ts` - Added `ModelMessage` import, updated `buildDoneTools()` signature, added two optional fields to `AgentLoopInput`, updated all 4 call sites, injected `_seedMessages` spread into main `generateText` call

## Decisions Made

- Used `ModelMessage` (ai v6 type) rather than `CoreMessage` — the Vercel AI SDK was already upgraded to v6 in this repo and `CoreMessage` no longer exists as an export
- All 4 `buildDoneTools()` call sites updated including the `verifySingleFindingWithTools` call that uses `.verification` — consistency is preferable even though the schema override does not affect the verification tool
- `_verificationSchema` intentionally NOT parameterized per the plan design

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Used ModelMessage instead of CoreMessage**
- **Found during:** Task 1 — TypeScript compilation check
- **Issue:** The plan specified `CoreMessage` from `'ai'`, but `ai` v6 renamed it to `ModelMessage`; `tsc` reported `Module '"ai"' has no exported member 'CoreMessage'`
- **Fix:** Replaced `CoreMessage` with `ModelMessage` in import, `AgentLoopInput.initialMessages` field type, and `_seedMessages` variable type
- **Files modified:** `libs/code-review/infrastructure/agents/llm/agent-loop.ts`
- **Verification:** `npx tsc --noEmit` reports zero `agent-loop` errors after fix
- **Committed in:** `42c5e93fa` (Task 1 commit — fix incorporated inline)

---

**Total deviations:** 1 auto-fixed (Rule 3 — blocking type error)
**Impact on plan:** Type rename is cosmetic — `ModelMessage` is the exact same union type as the old `CoreMessage`. No scope creep.

## Issues Encountered

- `CoreMessage` import failed at TypeScript compile time because Vercel AI SDK was already upgraded from v4/v5 (where `CoreMessage` existed) to v6 (where it was renamed to `ModelMessage`). Fixed by using the correct v6 type name.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `runAgentLoop` is now the generic seam the plan describes: review callers pass neither new field and see zero behavior change; a Phase 2 conversation wrapper can call `runAgentLoop` directly with `doneToolSchema` and `initialMessages`
- `agent-tools.factory.ts` is unchanged (EXT-03 satisfied) — native tools registry is still generic
- The only remaining review-coupled element inside `runAgentLoop` is the coverage ledger (which silently no-ops when `changedFiles: []`)

---
*Phase: 01-agent-migration*
*Completed: 2026-04-29*
