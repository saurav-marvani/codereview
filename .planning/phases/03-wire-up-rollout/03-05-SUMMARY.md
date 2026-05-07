---
phase: 03-wire-up-rollout
plan: 05
subsystem: platform/use-cases
tags: [instrumentation, observability-prep, phase4-labels, conversation-runtime]

dependency_graph:
  requires:
    - 03-03  # handleConversationViaRuntime with sandboxState
  provides:
    - Phase 4 instrumentation seam in handleConversationViaRuntime
  affects:
    - 03-06  # integration tests will assert commandType label in log

tech_stack:
  added: []
  patterns:
    - module-internal function (non-exported, indirectly tested via log assertions)
    - structured log as Phase 4 instrumentation seam

key_files:
  created: []
  modified:
    - libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case.ts

decisions:
  - "detectCommandType is a module-level function (not class method) — called without this. inside handleConversationViaRuntime; coexists with private detectCommandType(params) class method which has different signature and is called as this.detectCommandType(params)"
  - "this.logger.log used directly (not (this as any).logger) — class declares private readonly logger at line 173 via createLogger()"
  - "PHASE-4 INSTRUMENTATION comment marks the seam precisely; no OTel spans, Prometheus counters, or histogram.record calls added"

metrics:
  duration_minutes: 8
  completed_date: "2026-05-04"
  tasks_completed: 1
  files_modified: 1
---

# Phase 3 Plan 5: Phase 4 Instrumentation Labels Summary

**One-liner:** Structured log emitting sandboxState/byokProvider/commandType labels at lease acquire time, plus `detectCommandType()` regex helper, so Phase 4 can build latency histograms without Phase 3 rework.

## What Was Built

Added Phase 4 instrumentation seam to `handleConversationViaRuntime()`:

**1. `detectCommandType()` module-internal function** (end of file, after class closing brace):
- Regex `/^\s*@kody\s+remember\b/i` to distinguish memory writes from questions
- Returns `'remember' | 'conversation'` string literals
- Non-exported, module-internal — tested indirectly via log assertions in Plan 03-06

**2. Structured log call** immediately after `sandboxState` computation:
- Message: `'Conversation sandbox lease acquired'`
- Labels: `sandboxState`, `sandboxId`, `byokProvider`, `commandType`, `organizationId`, `prKey`
- `// PHASE-4 INSTRUMENTATION:` comment marks the seam
- No metric emission, no histogram.record, no tracer.startSpan

**Label values:**
- `sandboxState`: `'cold-create'` (wasCreated=true) | `'paused-resumed'` (wasCreated=false) | `'null'` (sandbox.type==='null')
- `byokProvider`: `byokConfig?.main?.provider ?? 'kodus-default'`
- `commandType`: `'remember'` (prompt matches @kody remember) | `'conversation'` (everything else)

## Tasks

| # | Name | Status | Commit |
|---|------|--------|--------|
| 1 | Add instrumentation labels to handleConversationViaRuntime | Done | e4da01066 |

## Verification

```
grep -n "sandboxState\|commandType\|byokProvider" chatWithKodyFromGit.use-case.ts
→ All three appear in log call inside handleConversationViaRuntime (lines 1933, 1935, 1936)

grep -n "detectCommandType" chatWithKodyFromGit.use-case.ts
→ Definition at line 2091 — no export keyword

npx jest chatWithKodyFromGit --no-coverage
→ 2 passed, 0 failed
```

## Deviations from Plan

None — plan executed exactly as written.

The plan noted to use `(this as any).logger` if uncertain about logger declaration; file had `private readonly logger = createLogger(...)` at line 173 so `this.logger.log(...)` was used directly — this is correct and cleaner.

## Self-Check

- [x] `libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case.ts` modified with all labels
- [x] `detectCommandType` function at line 2091, no `export` keyword
- [x] Commit e4da01066 exists
- [x] 2 tests pass
- [x] No histogram.record, counter.add, tracer.startSpan added

## Self-Check: PASSED
