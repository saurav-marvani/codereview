---
phase: 01-agent-migration
plan: 02
subsystem: infra
tags: [nestjs, mongoose, mongodb, e2b, sandbox, lease-manager, atomic-upsert]

# Dependency graph
requires:
  - phase: 01-agent-migration
    plan: 01
    provides: "libs/sandbox/ module with ISandboxLeaseManager contract, SANDBOX_LEASE_MANAGER_TOKEN, ISandboxProvider, SandboxModule"

provides:
  - SandboxLeaseModel Mongoose schema with sandbox_leases collection and INVALIDATED state
  - SandboxLeaseRepository with atomic upsertAcquire (single findOneAndUpdate with $setOnInsert + $inc)
  - SandboxLeaseManager implementing ISandboxLeaseManager — acquire/release/invalidate
  - SANDBOX_LEASE_MANAGER_TOKEN provided and exported from SandboxModule

affects:
  - 01-04 (CreateSandboxStage will inject SANDBOX_LEASE_MANAGER_TOKEN instead of SANDBOX_PROVIDER_TOKEN)
  - 01-05 (SandboxLeaseReaper will use SandboxLeaseRepository.findExpired)
  - all callers that need sandbox reuse across review and conversation consumers

# Tech tracking
tech-stack:
  added: []
  patterns:
    - Atomic Mongoose upsert with $setOnInsert + $inc in single findOneAndUpdate for concurrency-safe lease creation
    - INVALIDATED state in lease enum to handle mid-create race (Pitfall 5): invalidate() marks INVALIDATED, create path kills orphan
    - In-memory Map<leaseId,prKey> for single-worker release routing (Phase 1 acceptable; replace with Redis in later phase)
    - Soft-drain pattern: Sandbox.setTimeout(60s) before lease doc deletion lets in-flight tool calls finish naturally
    - release() sets idle timeout (Sandbox.setTimeout 5min) instead of kill — sandbox pauses on idle

key-files:
  created:
    - libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model.ts
    - libs/sandbox/infrastructure/repositories/sandbox-lease.repository.ts
    - libs/sandbox/infrastructure/services/sandbox-lease-manager.service.ts
  modified:
    - libs/sandbox/modules/sandbox.module.ts (added MongooseModule.forFeature, SandboxLeaseRepository, SANDBOX_LEASE_MANAGER_TOKEN)

key-decisions:
  - "State enum includes INVALIDATED (not in original RESEARCH.md Pattern 2) to handle mid-create race: force-push while create in-flight marks INVALIDATED; creator path detects and kills orphan before completing"
  - "buildSandboxInstance helper added to SandboxLeaseManager for connected (joiner-path) sandboxes — E2BSandboxService.createSandboxWithRepo still owns the full clone setup; joiner path reconnects to existing sandbox"
  - "Sandbox.kill() only appears in creator path for mid-create INVALIDATED orphan cleanup; release() uses only Sandbox.setTimeout()"
  - "In-memory Map<leaseId,prKey> is acceptable for single-worker Phase 1; distributed release (Redis/Mongo) deferred to later plan"

patterns-established:
  - "SandboxLeaseManager.acquire() always wraps sandbox.cleanup to call release(leaseId) — callers never call sandbox.kill() directly"
  - "upsertAcquire: leaseCount===1 after upsert means creator; leaseCount>1 means joiner — single atomic determination"

# Metrics
duration: 18min
completed: 2026-05-04
---

# Phase 01 Plan 02: SandboxLeaseManager Summary

**Atomic MongoDB lease coordination for E2B sandbox reuse with INVALIDATED mid-create race guard, idle-timeout-based release, and soft-drain invalidation**

## Performance

- **Duration:** ~18 min
- **Started:** 2026-05-04T14:23:15Z
- **Completed:** 2026-05-04T14:41:00Z
- **Tasks:** 2
- **Files modified:** 4 (3 created, 1 modified)

## Accomplishments

- Created `SandboxLeaseModel` Mongoose schema for `sandbox_leases` collection with `INVALIDATED` state to guard against the mid-create race (RESEARCH.md Pitfall 5)
- Created `SandboxLeaseRepository` with atomic `upsertAcquire` — single `findOneAndUpdate` call containing both `$setOnInsert` and `$inc: { leaseCount: 1 }` so concurrent callers are correctly identified as creator (leaseCount===1) vs joiner (leaseCount>1) without a separate read-then-write
- Created `SandboxLeaseManager` implementing `ISandboxLeaseManager`; creator path calls `createSandboxWithRepo`, joiner path polls up to 30s then connects via `Sandbox.connect()`; `release()` sets 5-min idle timeout instead of calling `kill()`; `invalidate()` uses 60s soft-drain via `Sandbox.setTimeout()` before deleting the Mongo doc
- Updated `SandboxModule` to register `SandboxLeaseModel`, `SandboxLeaseRepository`, and `SANDBOX_LEASE_MANAGER_TOKEN`; exports both `SANDBOX_PROVIDER_TOKEN` and `SANDBOX_LEASE_MANAGER_TOKEN`

## Task Commits

Each task was committed atomically:

1. **Task 1: Create Mongoose lease schema and repository** - `89d2053f0` (feat)
2. **Task 2: Implement SandboxLeaseManager and wire into SandboxModule** - `2912ae271` (feat)

**Plan metadata:** _(docs commit follows)_

## Files Created/Modified

- `libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model.ts` - SandboxLeaseModel @Schema with collection 'sandbox_leases', INVALIDATED state, expiresAt and sandboxId indexes
- `libs/sandbox/infrastructure/repositories/sandbox-lease.repository.ts` - SandboxLeaseRepository with atomic upsertAcquire, decrementLease, updateReady, markInvalidated, findByPrKey, findExpired, delete
- `libs/sandbox/infrastructure/services/sandbox-lease-manager.service.ts` - SandboxLeaseManager, SandboxCreateTimeoutError, idle timeout and soft-drain logic
- `libs/sandbox/modules/sandbox.module.ts` - Added MongooseModule.forFeature, SandboxLeaseRepository provider, SANDBOX_LEASE_MANAGER_TOKEN useClass and export

## Decisions Made

- `INVALIDATED` added to the state enum (extends RESEARCH.md Pattern 2 which only had CREATING/READY/PAUSED): needed to handle force-push/pr-close arriving while create is still in-flight. Without it, invalidate() would delete the doc and the finishing creator would write a lease with no associated document, orphaning the E2B sandbox.
- `buildSandboxInstance()` helper added to joiner path to wrap a connected E2B `Sandbox` object into a `SandboxInstance`. This was not in the original plan but required by the joiner connect path — a Rule 3 (blocking) deviation.
- `Sandbox.kill()` used only in the one case the plan explicitly requires: mid-create INVALIDATED orphan cleanup. `release()` exclusively calls `Sandbox.setTimeout()`.
- `SandboxLeaseModel` does not extend `Document` — using the `KodyRulesModel` pattern (plain class with `@Schema/@Prop`) avoids TS2416 type-incompatibility with Mongoose's typed `Document<ObjectId>` base class.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TypeScript TS2416/TS2612 on `_id: string` in SandboxLeaseModel**

- **Found during:** Task 1 (Create Mongoose lease schema)
- **Issue:** `extends Document` makes `_id: string` incompatible with base `Document<ObjectId>`, generating TS2416 (property not assignable) and TS2612 (will overwrite base property) errors
- **Fix:** Removed `extends Document` — adopted the `KodyRulesModel` pattern (plain class decorated with `@Schema/@Prop`). `Model<SandboxLeaseModel>` in the repository works identically without the Document inheritance.
- **Files modified:** `libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model.ts`
- **Verification:** `npx tsc --noEmit 2>&1 | grep "libs/sandbox"` returns empty
- **Committed in:** `89d2053f0` (Task 1 commit)

**2. [Rule 2 - Missing Critical] Added `buildSandboxInstance()` helper for joiner-path sandbox wrapping**

- **Found during:** Task 2 (Implement SandboxLeaseManager)
- **Issue:** The joiner connect path calls `Sandbox.connect(sandboxId)` which returns an E2B `Sandbox` instance, but the service must return a `SandboxInstance`. No helper was specified in the plan for this conversion.
- **Fix:** Added private `buildSandboxInstance(e2bSandbox, prKey, leaseId)` method that wraps the connected E2B sandbox into a `SandboxInstance` with release-bound cleanup. Implements all `remoteCommands` methods using the connected sandbox's `commands.run()` API.
- **Files modified:** `libs/sandbox/infrastructure/services/sandbox-lease-manager.service.ts`
- **Verification:** Zero TypeScript errors in sandbox files; joiner path compiles cleanly
- **Committed in:** `2912ae271` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 bug fix, 1 missing critical functionality)
**Impact on plan:** Both auto-fixes necessary for correctness and completeness. No scope creep.

## Issues Encountered

None beyond the two auto-fixed deviations above. Pre-existing TypeScript errors in unrelated files (libs/agents, libs/cli-review, libs/code-review, etc.) were present before this plan and are out of scope per SCOPE BOUNDARY rule.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `SANDBOX_LEASE_MANAGER_TOKEN` is now provided and exported from `SandboxModule` — Plan 01-04 can inject it into `CreateSandboxStage`
- `SandboxLeaseRepository.findExpired()` is ready for the reaper cron service (Plan 01-05)
- `SandboxLeaseManager.invalidate()` is ready for the event-emitter consumer (Plan 01-05)
- The `cloneParams?: CreateSandboxParams` argument on `acquire()` provides the Plan 01-04 integration seam — when supplied, the creator path calls `createSandboxWithRepo` with the real params

## Self-Check: PASSED

All 4 files confirmed on disk. Commits 89d2053f0 and 2912ae271 verified in git log. Zero TypeScript errors in `libs/sandbox/` files.

---
*Phase: 01-agent-migration*
*Completed: 2026-05-04*
