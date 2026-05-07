---
phase: 01-agent-migration
plan: 03
subsystem: infra
tags: [e2b, sandbox, pause-resume, lifecycle, nestjs]

# Dependency graph
requires:
  - phase: 01-agent-migration/01-01
    provides: E2BSandboxService at libs/sandbox/infrastructure/providers/e2b-sandbox.service.ts

provides:
  - Both Sandbox.create() call sites patched with lifecycle { onTimeout: 'pause', autoResume: true }
  - pauseAfterIdle(sandboxId, idleMs) method on E2BSandboxService for SandboxLeaseManager release path
  - connectExisting(sandboxId) method on E2BSandboxService for SandboxLeaseManager acquire path

affects:
  - 01-02 (SandboxLeaseManager callers of pauseAfterIdle/connectExisting)
  - 01-04, 01-05, 01-07 (anything calling createSandboxWithRepo)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "E2B pause/resume: lifecycle: { onTimeout: 'pause', autoResume: true } on every Sandbox.create() call"
    - "autoResume MUST be explicit — SDK default is false; Sandbox.connect() throws on paused sandboxes without it"
    - "Sandbox.setTimeout(sandboxId, idleMs, { apiKey }) for per-sandbox idle window updates"
    - "Sandbox.connect(sandboxId, { apiKey }) auto-resumes paused sandboxes"

key-files:
  created: []
  modified:
    - libs/sandbox/infrastructure/providers/e2b-sandbox.service.ts

key-decisions:
  - "lifecycle: { onTimeout: 'pause', autoResume: true } added to both Sandbox.create() overloads; autoResume is explicit, not inherited from SDK default (which is false)"
  - "pauseAfterIdle uses static Sandbox.setTimeout() — correct API for updating idle timeout on an existing sandbox without reconnecting"
  - "connectExisting returns Sandbox directly (not SandboxInstance) — lease manager owns the SandboxInstance wrapping"

patterns-established:
  - "Pattern: every Sandbox.create() in this codebase carries lifecycle config — search for Sandbox.create without lifecycle as a review checklist item"
  - "Pattern: autoResume comment above every Sandbox.create() call site to explain the non-obvious requirement"

# Metrics
duration: 4min
completed: 2026-05-04
---

# Phase 01 Plan 03: E2B Sandbox Lifecycle Summary

**E2BSandboxService patched with `lifecycle: { onTimeout: 'pause', autoResume: true }` on both `Sandbox.create()` call sites, plus `pauseAfterIdle()` and `connectExisting()` methods for `SandboxLeaseManager` to call**

## Performance

- **Duration:** 4 min
- **Started:** 2026-05-04T15:26:56Z
- **Completed:** 2026-05-04T15:30:28Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Both `Sandbox.create()` overloads (template path and no-template path) now include `lifecycle: { onTimeout: 'pause', autoResume: true }` — sandboxes pause instead of being killed on timeout
- `autoResume: true` is explicit and commented at each call site; omitting it is the most common SDK pitfall (SDK default is `false`, causing `Sandbox.connect()` to throw on paused sandboxes)
- `pauseAfterIdle(sandboxId, idleMs)` added — calls `Sandbox.setTimeout()` to set a per-sandbox idle window; called by `SandboxLeaseManager.release()` when leaseCount hits 0
- `connectExisting(sandboxId)` added — calls `Sandbox.connect()` which auto-resumes paused sandboxes; called by `SandboxLeaseManager.acquire()` when state is `READY`
- `createSandboxWithRepo()` public signature unchanged — no existing callers affected

## Task Commits

1. **Task 1: Add lifecycle config to Sandbox.create() calls and new connect/pause methods** - `327a93ee5` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `libs/sandbox/infrastructure/providers/e2b-sandbox.service.ts` - Added lifecycle config to both Sandbox.create() call sites; added pauseAfterIdle() and connectExisting() public methods

## Decisions Made
- Used `Sandbox.setTimeout()` static method for `pauseAfterIdle()` — this is the correct API for adjusting timeout on an existing sandbox without needing to reconnect. The instance `setTimeout()` method requires an active connection, which is unnecessary here.
- `connectExisting()` returns `Sandbox` (not `SandboxInstance`) because `SandboxLeaseManager` is responsible for wrapping it in the higher-level interface. Keeping concerns separated.
- `autoResume: true` added as explicit field (even though it is part of `lifecycle`) to satisfy the SDK type which allows omission with a `false` default — being explicit defends against future SDK changes.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `E2BSandboxService` is now the complete foundation for `SandboxLeaseManager` (Plan 01-02): `pauseAfterIdle()` and `connectExisting()` match the method signatures expected by `SandboxLeaseManager`
- All existing callers of `createSandboxWithRepo()` continue to work unchanged
- Plan 01-04 (SandboxModule NestJS wiring) can proceed — service API is stable

---
*Phase: 01-agent-migration*
*Completed: 2026-05-04*
