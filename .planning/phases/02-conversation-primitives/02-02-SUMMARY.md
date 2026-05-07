---
phase: 02-conversation-primitives
plan: "02"
subsystem: database
tags: [mongodb, mongoose, nestjs, conversation, atomic-push, ttl]

# Dependency graph
requires:
  - phase: 01-agent-migration
    provides: "SandboxLeaseModel schema pattern + SandboxModule for MongooseModule.forFeature template"
provides:
  - "conversation_threads MongoDB collection (ConversationThreadModel + ConversationThreadSchema)"
  - "ConversationThreadRepository with atomic $push appendTurn (concurrent-safe)"
  - "CONVERSATION_SESSION_MANAGER_TOKEN symbol + IConversationSessionManager interface"
  - "ConversationTurn type and IConversationThread interface"
  - "ConversationModule NestJS skeleton (MongooseModule.forFeature wired)"
affects:
  - 02-03-conversation-session-manager
  - 02-04-run-conversation-loop
  - phase-03-chat-use-case

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Mongoose @Schema plain-class pattern (_id as prKey string, no Document extension)"
    - "MongoDB TTL index on updatedAt (expireAfterSeconds: 7776000) for auto-expiry"
    - "Atomic $push + $set + $setOnInsert with upsert: true for concurrent-safe append"
    - "NestJS module skeleton with MongooseModule.forFeature and placeholder comments for next plan"

key-files:
  created:
    - libs/conversation/domain/contracts/conversation-session-manager.contract.ts
    - libs/conversation/domain/interfaces/conversation-thread.interface.ts
    - libs/conversation/infrastructure/repositories/schemas/conversation-thread.model.ts
    - libs/conversation/infrastructure/repositories/conversation-thread.repository.ts
    - libs/conversation/modules/conversation.module.ts
  modified: []

key-decisions:
  - "ConversationModule skeleton exports only ConversationThreadRepository in Plan 02-02; CONVERSATION_SESSION_MANAGER_TOKEN provider and export added in Plan 02-03 to avoid empty provider errors"
  - "TTL on updatedAt (not createdAt) so active PRs keep their thread alive through the full review cycle"
  - "No imports from libs/code-review/modules/ — conversation lib is standalone to prevent circular deps (Pitfall 8)"

patterns-established:
  - "Pattern: ConversationTurn embedded array with $push atomicity — two concurrent appendTurn calls both succeed, neither is lost"
  - "Pattern: CONVERSATION_SESSION_MANAGER_TOKEN Symbol for NestJS DI (mirrors SANDBOX_LEASE_MANAGER_TOKEN)"

# Metrics
duration: 3min
completed: 2026-05-04
---

# Phase 2 Plan 02: ConversationThread Schema Summary

**`conversation_threads` MongoDB collection with atomic $push repository and NestJS ConversationModule skeleton — the Mongo persistence foundation for multi-turn PR thread history**

## Performance

- **Duration:** 3 min
- **Started:** 2026-05-04T14:47:42Z
- **Completed:** 2026-05-04T14:50:55Z
- **Tasks:** 2
- **Files created:** 5

## Accomplishments

- Established `libs/conversation/` standalone library directory structure (domain/contracts, domain/interfaces, infrastructure/repositories/schemas, infrastructure/repositories, modules)
- Created `ConversationThreadModel` Mongoose schema with embedded `turns[]` array, `_id: prKey` string key, TTL index on `updatedAt` (7776000 s = 90 days), mirroring `SandboxLeaseModel` pattern exactly
- Created `ConversationThreadRepository.appendTurn` using atomic `$push + $set + $setOnInsert` with `upsert: true` — two concurrent appends to the same prKey cannot lose each other's data
- Created `ConversationModule` NestJS skeleton registering schema via `MongooseModule.forFeature`, providing `ConversationThreadRepository`, with placeholder comments for Plan 02-03 additions

## Task Commits

Each task was committed atomically:

1. **Task 1: Create domain contracts and schema** - `d40b3e16b` (feat)
2. **Task 2: Create repository and ConversationModule skeleton** - `e5844acd8` (feat)

**Plan metadata:** TBD (docs: complete plan)

## Files Created/Modified

- `libs/conversation/domain/contracts/conversation-session-manager.contract.ts` — `CONVERSATION_SESSION_MANAGER_TOKEN` symbol, `ConversationTurn` type, `IConversationSessionManager` interface
- `libs/conversation/domain/interfaces/conversation-thread.interface.ts` — `IConversationThread` shape (prKey, turns, createdAt, updatedAt)
- `libs/conversation/infrastructure/repositories/schemas/conversation-thread.model.ts` — Mongoose schema with embedded turns array, TTL index on updatedAt (90 days)
- `libs/conversation/infrastructure/repositories/conversation-thread.repository.ts` — `findByPrKey` + atomic `appendTurn` ($push upsert)
- `libs/conversation/modules/conversation.module.ts` — NestJS module skeleton with MongooseModule.forFeature

## Decisions Made

- **ConversationModule skeleton only exports ConversationThreadRepository**: Plan spec says `CONVERSATION_SESSION_MANAGER_TOKEN` is added in Plan 02-03. Skeleton comments mark the addition point clearly.
- **TTL on updatedAt**: Active PRs get their thread TTL refreshed on each `@kody` interaction. Using `createdAt` would delete threads from long-running PRs that started 90+ days ago.
- **No imports from `libs/code-review/modules/`**: Verified with grep — zero circular dep risk (Pitfall 8 prevention).

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. TypeScript check confirmed zero errors in `libs/conversation/` files. The 3141 pre-existing TS errors in the wider codebase are unrelated and out-of-scope.

## Self-Check: PASSED

All 5 files verified present:
- FOUND: libs/conversation/domain/contracts/conversation-session-manager.contract.ts
- FOUND: libs/conversation/domain/interfaces/conversation-thread.interface.ts
- FOUND: libs/conversation/infrastructure/repositories/schemas/conversation-thread.model.ts
- FOUND: libs/conversation/infrastructure/repositories/conversation-thread.repository.ts
- FOUND: libs/conversation/modules/conversation.module.ts

Commits verified:
- FOUND: d40b3e16b (Task 1)
- FOUND: e5844acd8 (Task 2)

## User Setup Required

None - no external service configuration required. MongoDB collection is created automatically on first `appendTurn` (upsert). TTL index is created by Mongoose on startup.

## Next Phase Readiness

- `ConversationThreadRepository` is ready for injection into `ConversationSessionManager` (Plan 02-03)
- `ConversationModule` is ready to receive `CONVERSATION_SESSION_MANAGER_TOKEN` provider in Plan 02-03
- `CONVERSATION_SESSION_MANAGER_TOKEN` token is exported from contract file, ready for DI injection in Plan 02-03 and Phase 3 use case

---
*Phase: 02-conversation-primitives*
*Completed: 2026-05-04*
