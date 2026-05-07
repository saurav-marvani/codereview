---
phase: 03-wire-up-rollout
plan: 02
subsystem: infra
tags: [nestjs, di, platform-module, sandbox, conversation]

# Dependency graph
requires:
  - phase: 02-conversation-primitives
    provides: ConversationModule with CONVERSATION_SESSION_MANAGER_TOKEN exported
  - phase: 01-agent-migration
    provides: SandboxModule with SANDBOX_LEASE_MANAGER_TOKEN exported
provides:
  - PlatformModule.imports wired with SandboxModule and ConversationModule via forwardRef
  - SANDBOX_LEASE_MANAGER_TOKEN resolvable from ChatWithKodyFromGitUseCase DI scope
  - CONVERSATION_SESSION_MANAGER_TOKEN resolvable from ChatWithKodyFromGitUseCase DI scope
affects: [03-03, 03-04, 03-05]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "forwardRef() wrapping for new module imports in PlatformModule — consistent with existing pattern"

key-files:
  created: []
  modified:
    - libs/platform/modules/platform.module.ts

key-decisions:
  - "forwardRef used for both SandboxModule and ConversationModule — consistent with all existing PlatformModule imports; prevents circular dependency at startup"
  - "Neither module added to exports array — ChatWithKodyFromGitUseCase is the sole consumer and lives inside PlatformModule"

patterns-established:
  - "New DI tokens needed by PlatformModule consumers must be wired via forwardRef() in the imports array"

# Metrics
duration: 2min
completed: 2026-05-04
---

# Phase 03 Plan 02: Wire SandboxModule + ConversationModule into PlatformModule Summary

**SandboxModule and ConversationModule added to PlatformModule imports via forwardRef, enabling NestJS to resolve SANDBOX_LEASE_MANAGER_TOKEN and CONVERSATION_SESSION_MANAGER_TOKEN from ChatWithKodyFromGitUseCase's DI scope**

## Performance

- **Duration:** 2 min
- **Started:** 2026-05-04T00:01:43Z
- **Completed:** 2026-05-04T00:03:17Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Added `SandboxModule` and `ConversationModule` import statements to `platform.module.ts`
- Wired both modules into `PlatformModule.imports` array using `forwardRef(() => ...)` pattern
- TypeScript compiles without new errors in the modified file
- Existing `chatWithKodyFromGit.use-case.spec` tests pass (2/2)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add SandboxModule and ConversationModule to PlatformModule imports** - `951b0b606` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `libs/platform/modules/platform.module.ts` - Added two import statements and two forwardRef entries in imports array

## Decisions Made
- `forwardRef` wrapping used for both new modules, consistent with every other module import already in PlatformModule; prevents circular-dependency detection at module init time
- Neither module added to the `exports` array — only `ChatWithKodyFromGitUseCase` (a PlatformModule-internal provider) needs these tokens, so re-export is unnecessary

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. Pre-existing TypeScript errors in test files (unrelated to this change) were confirmed as pre-existing via targeted grep on `platform.module.ts` — no errors in the modified file.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `SANDBOX_LEASE_MANAGER_TOKEN` and `CONVERSATION_SESSION_MANAGER_TOKEN` are now resolvable in PlatformModule scope
- Plan 03-03 can now inject both tokens into `ChatWithKodyFromGitUseCase` without NestJS throwing "Can't resolve dependencies"
- Plans 03-03 and 03-04 can proceed in parallel (different files, no conflict)

---
*Phase: 03-wire-up-rollout*
*Completed: 2026-05-04*
