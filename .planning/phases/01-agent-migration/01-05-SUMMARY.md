---
phase: 01-agent-migration
plan: 05
subsystem: infra
tags: [outbox, sandbox, webhook, e2b, distributed-lock, cron, nestjs]

# Dependency graph
requires:
  - phase: 01-02
    provides: SandboxLeaseManager + SandboxLeaseRepository + SandboxModule with SANDBOX_LEASE_MANAGER_TOKEN
  - phase: 01-04
    provides: CreateSandboxStage using ISandboxLeaseManager.release() instead of kill()
provides:
  - SandboxLeaseReaperService: @Cron(EVERY_5_MINUTES) with DistributedLockService, scans ALL expired leases
  - OutboxRelayService: processMessage() routing-key branch for in-process sandbox invalidation
  - SANDBOX_INVALIDATE_ROUTING_KEY constant + SandboxInvalidatePayload type
  - All 5 webhook handlers (GitHub, GitLab, Bitbucket, Azure, Forgejo) write outbox on PR close
  - GitLab handler also writes outbox for force-push events
affects:
  - 01-06
  - 01-07
  - apps/worker (SandboxModule now in code-review role imports)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - outbox pattern for durable in-process event routing (no RabbitMQ for sandbox invalidation)
    - routing-key branching inside OutboxRelayService before broker publish path
    - DistributedLockService + @Cron for crash-safe reaper

key-files:
  created:
    - libs/sandbox/domain/events/sandbox-invalidate.event.ts
    - libs/sandbox/infrastructure/services/sandbox-lease-reaper.service.ts
  modified:
    - libs/core/workflow/infrastructure/outbox-relay.service.ts
    - apps/worker/src/worker.module.ts
    - libs/platform/infrastructure/webhooks/github/githubPullRequest.handler.ts
    - libs/platform/infrastructure/webhooks/gitlab/gitlabPullRequest.handler.ts
    - libs/platform/infrastructure/webhooks/bitbucket/bitbucketPullRequest.handler.ts
    - libs/platform/infrastructure/webhooks/azure/azureReposPullRequest.handler.ts
    - libs/platform/infrastructure/webhooks/forgejo/forgejoPullRequest.handler.ts

key-decisions:
  - "Sandbox invalidation is consumed in-process by OutboxRelayService via routing-key branch — never published to RabbitMQ, eliminates two-consumer race condition"
  - "No SandboxInvalidateConsumerService — the relay loop owns all READY rows; routing-key decides disposition before any broker call"
  - "Reaper scans ALL expired leases (not filtered by leaseCount) to handle crashed-worker cleanup (RESEARCH.md Pitfall 3)"
  - "Azure: outbox written for both status=completed (merged) and status=abandoned (closed without merge)"
  - "GitHub, Forgejo, Bitbucket: TODO comment added for force-push — not surfaced distinctly by those platform webhooks"
  - "GitLab: force-push outbox write added because GitLab exposes push.force flag in webhook payload"

patterns-established:
  - "Outbox routing-key branch: early-return before observability span + broker connectivity check"
  - "Webhook handler outbox write: fire-and-catch pattern (non-blocking, logs warn on failure) for non-critical durability layer"
  - "Azure close detection: prStatus === 'completed' || prStatus === 'abandoned' covers both merge and close paths"

# Metrics
duration: 25min
completed: 2026-05-04
---

# Phase 01 Plan 05: Sandbox Invalidation via Outbox Pattern Summary

**SandboxLeaseReaperService (5-min cron with DistributedLockService) + in-process outbox branch in OutboxRelayService + 5 webhook handlers writing 'sandbox.invalidate' outbox events on PR close — no RabbitMQ, no race condition**

## Performance

- **Duration:** ~25 min (continuation execution)
- **Started:** 2026-05-04T (continuation agent)
- **Completed:** 2026-05-04
- **Tasks:** 2 (Task 1 committed by prior executor at 584324630; Task 2 completed here)
- **Files modified:** 9 (2 created, 7 modified)

## Accomplishments

- SandboxLeaseReaperService reaps ALL expired sandbox leases every 5 minutes via DistributedLockService advisory lock, handling the crashed-worker cleanup case (RESEARCH.md Pitfall 3)
- OutboxRelayService.processMessage() now branches on SANDBOX_INVALIDATE_ROUTING_KEY before the RabbitMQ publish path, calling sandboxLeaseManager.invalidate(prKey) in-process — eliminates the two-consumer race condition described in the plan objective
- All 5 webhook handlers (GitHub, GitLab, Bitbucket, Azure, Forgejo) inject IOutboxMessageRepository and write a durable outbox message on PR close; GitLab additionally writes on force-push

## Task Commits

1. **Task 1: Create event constant + SandboxLeaseReaperService; wire OutboxRelayService** - `584324630` (feat — prior executor)
2. **Task 2: Wire 5 webhook handlers to write SANDBOX_INVALIDATE outbox events** - `b7da1d5f6` (feat)

## Files Created/Modified

- `libs/sandbox/domain/events/sandbox-invalidate.event.ts` — SANDBOX_INVALIDATE_ROUTING_KEY constant + SandboxInvalidatePayload type
- `libs/sandbox/infrastructure/services/sandbox-lease-reaper.service.ts` — @Cron(EVERY_5_MINUTES) reaper with DistributedLockService, scans findExpired(now)
- `libs/core/workflow/infrastructure/outbox-relay.service.ts` — early-return routing-key branch before broker path; injects ISandboxLeaseManager
- `apps/worker/src/worker.module.ts` — SandboxModule added to code-review role imports for SANDBOX_LEASE_MANAGER_TOKEN resolution
- `libs/platform/infrastructure/webhooks/github/githubPullRequest.handler.ts` — outbox write on action==='closed'; force-push TODO comment
- `libs/platform/infrastructure/webhooks/gitlab/gitlabPullRequest.handler.ts` — outbox write on MR close + force-push (2 writes)
- `libs/platform/infrastructure/webhooks/bitbucket/bitbucketPullRequest.handler.ts` — outbox write on PR close
- `libs/platform/infrastructure/webhooks/azure/azureReposPullRequest.handler.ts` — outbox write for status=completed and status=abandoned; force-push TODO comment
- `libs/platform/infrastructure/webhooks/forgejo/forgejoPullRequest.handler.ts` — outbox write on CLOSED action; force-push TODO comment

## Decisions Made

- Sandbox invalidation consumed in-process by OutboxRelayService (routing-key branch) — never published to RabbitMQ. Eliminates the race condition where two consumers competed for READY outbox rows.
- No SandboxInvalidateConsumerService — zero matches confirmed in codebase.
- Reaper queries findExpired(now) without leaseCount filter — intentional, handles crashed-worker case where leaseCount never reached zero.
- Azure handler writes outbox for both `completed` (merged) and `abandoned` (explicitly closed) statuses — both semantically terminate the PR lifecycle.
- Webhook outbox writes use fire-and-catch pattern (non-blocking .catch() logs warn) — the write is best-effort durability; the reaper is the backstop.

## Deviations from Plan

None — plan executed exactly as written. The continuation context accurately described what was done and what remained.

## Issues Encountered

- Pre-existing TypeScript errors in apps/cli, apps/web, and test spec files were present before Phase 1 began. None of these are in files touched by this plan. Logged as out-of-scope per scope boundary rule.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- 01-05 complete: all durability mechanisms for sandbox lifecycle are in place (reaper + outbox invalidation + 5 handlers)
- 01-07 (final plan in phase) can now proceed — all Wave 3 prerequisites satisfied
- The outbox pattern established here (routing-key branching before broker) is the canonical approach for in-process event routing; future plans adding similar in-process events should follow this pattern

---
*Phase: 01-agent-migration*
*Completed: 2026-05-04*
