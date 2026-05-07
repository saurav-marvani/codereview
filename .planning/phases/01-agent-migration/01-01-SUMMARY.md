---
phase: 01-agent-migration
plan: 01
subsystem: infra
tags: [nestjs, e2b, sandbox, module-extraction, dependency-injection]

# Dependency graph
requires: []
provides:
  - libs/sandbox/ module with domain contracts (ISandboxProvider, ISandboxLeaseManager, ISandboxLease)
  - SandboxModule exporting SANDBOX_PROVIDER_TOKEN via useFactory DI
  - libs/code-review/domain/contracts/sandbox.provider.ts re-export barrel (zero consumer impact)
affects:
  - 01-02 (SandboxLeaseManager lives in libs/sandbox/)
  - 01-03 (E2B pause/resume lifecycle adds to E2BSandboxService in libs/sandbox/)
  - all consumers of SANDBOX_PROVIDER_TOKEN (unchanged via barrel)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - re-export barrel for zero-impact module extraction
    - NestJS @Module with useFactory for provider selection by env config

key-files:
  created:
    - libs/sandbox/domain/contracts/sandbox.provider.ts
    - libs/sandbox/domain/contracts/sandbox-lease-manager.contract.ts
    - libs/sandbox/domain/interfaces/sandbox-lease.interface.ts
    - libs/sandbox/infrastructure/providers/e2b-sandbox.service.ts
    - libs/sandbox/infrastructure/providers/local-sandbox.service.ts
    - libs/sandbox/infrastructure/providers/null-sandbox.service.ts
    - libs/sandbox/modules/sandbox.module.ts
  modified:
    - libs/code-review/domain/contracts/sandbox.provider.ts (converted to re-export barrel)
    - libs/code-review/modules/codebase.module.ts (imports SandboxModule, removes useFactory)

key-decisions:
  - "RemoteCommands kept in @libs/code-review for now; SandboxInstance.remoteCommands still references it via import — will move in a later plan when collectCrossFileContexts.service.ts is extracted"
  - "libs/code-review/domain/contracts/sandbox.provider.ts converted to re-export barrel to avoid touching all 18 existing consumers"
  - "SandboxModule imports only ConfigService — no MongooseModule yet (added in Plan 01-02 with SandboxLeaseManager)"

patterns-established:
  - "Re-export barrel pattern: when extracting a domain contract to a new lib, leave a barrel at the old path so consumers do not need to change"
  - "SandboxModule owns provider selection logic (env-driven useFactory); consumers import module, not factory"

# Metrics
duration: 9min
completed: 2026-05-04
---

# Phase 01 Plan 01: Sandbox Module Extraction Summary

**Extracted sandbox capability from libs/code-review/ into a standalone libs/sandbox/ NestJS module with domain contracts, provider implementations, SandboxModule DI, and a re-export barrel preserving all 18 existing consumers**

## Performance

- **Duration:** ~9 min
- **Started:** 2026-05-04T14:10:58Z
- **Completed:** 2026-05-04T14:18:53Z
- **Tasks:** 2
- **Files modified:** 9 (7 created, 2 modified)

## Accomplishments

- Created `libs/sandbox/` module with full directory tree: domain/contracts, domain/interfaces, infrastructure/providers, modules
- Established domain contracts: `ISandboxProvider`, `ISandboxLeaseManager` (for Plan 01-02), `ISandboxLease`
- Moved E2BSandboxService, LocalSandboxService, NullSandboxProvider to `libs/sandbox/infrastructure/providers/` with updated imports
- Created `SandboxModule` exporting `SANDBOX_PROVIDER_TOKEN` via env-driven `useFactory` — identical logic to the one removed from CodebaseModule
- Converted `libs/code-review/domain/contracts/sandbox.provider.ts` to a one-line re-export barrel; all 18 consumers compile unchanged
- Updated `CodebaseModule` to import `SandboxModule` and removed the now-redundant `useFactory` block and provider imports

## Task Commits

1. **Task 1: Create libs/sandbox/ directory tree and domain contracts** - `7201a563a` (feat)
2. **Task 2: Move provider implementations to libs/sandbox/ and wire SandboxModule** - `87a6ab2e2` (feat)

**Plan metadata:** _(docs commit follows)_

## Files Created/Modified

- `libs/sandbox/domain/contracts/sandbox.provider.ts` - ISandboxProvider, SandboxInstance, CreateSandboxParams, SANDBOX_PROVIDER_TOKEN
- `libs/sandbox/domain/contracts/sandbox-lease-manager.contract.ts` - ISandboxLeaseManager, AcquireResult, SANDBOX_LEASE_MANAGER_TOKEN
- `libs/sandbox/domain/interfaces/sandbox-lease.interface.ts` - ISandboxLease interface
- `libs/sandbox/infrastructure/providers/e2b-sandbox.service.ts` - E2BSandboxService (ISandboxProvider), imports from @libs/sandbox
- `libs/sandbox/infrastructure/providers/local-sandbox.service.ts` - LocalSandboxService (ISandboxProvider), imports from @libs/sandbox
- `libs/sandbox/infrastructure/providers/null-sandbox.service.ts` - NullSandboxProvider + NULL_SANDBOX_INSTANCE, imports from @libs/sandbox
- `libs/sandbox/modules/sandbox.module.ts` - SandboxModule with useFactory; exports SANDBOX_PROVIDER_TOKEN
- `libs/code-review/domain/contracts/sandbox.provider.ts` - Converted to `export * from '@libs/sandbox/domain/contracts/sandbox.provider'`
- `libs/code-review/modules/codebase.module.ts` - Imports SandboxModule; removed E2B/Local/Null provider imports and useFactory

## Decisions Made

- `RemoteCommands` stays in `@libs/code-review` for now (it is imported by both the new sandbox providers and by collectCrossFileContexts.service). Will move when collectCrossFileContexts.service.ts is extracted in a later plan.
- Re-export barrel chosen over updating all 18 consumers — safer, zero diff to any consumer file.
- `SandboxModule` has no MongooseModule dependency yet — Plan 01-02 adds it when `SandboxLeaseManager` (and its Mongo schema) is implemented.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. Pre-existing TypeScript errors in `apps/cli`, `apps/api`, and unrelated `libs/` files were present before this plan and are out of scope per SCOPE BOUNDARY rule.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `libs/sandbox/` is ready to host `SandboxLeaseManager` (Plan 01-02)
- `ISandboxLeaseManager` contract and `ISandboxLease` interface are already in place for Plan 01-02 to implement
- `E2BSandboxService` in `libs/sandbox/` is ready for pause/resume lifecycle (Plan 01-03)
- All existing review pipeline consumers remain unaffected

## Self-Check: PASSED

All 9 files confirmed on disk. Commits 7201a563a and 87a6ab2e2 verified in git log. Zero TypeScript errors in libs/sandbox/ and the two modified libs/code-review/ files.

---
*Phase: 01-agent-migration*
*Completed: 2026-05-04*
