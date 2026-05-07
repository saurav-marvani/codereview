---
phase: 01-agent-migration
plan: 09
subsystem: webhook
tags: [github, webhook, sandbox, outbox, force-push, jest]

# Dependency graph
requires:
  - phase: 01-agent-migration
    plan: 05
    provides: durable sandbox invalidation via outbox on PR close + GitLab force-push
  - phase: 01-agent-migration
    plan: 08
    provides: decision to pursue GitHub-only best-effort follow-up
  - phase: 01-agent-migration
    plan: 07
    provides: phase test/verification baseline

provides:
  - GitHub synchronize best-effort force-push invalidation heuristic
  - Focused GitHub webhook handler unit tests for force-push invalidation
  - Narrowed phase verification gap: GitHub covered, residual gap reduced to Bitbucket/Azure/Forgejo

affects:
  - .planning/phases/01-agent-migration/01-VERIFICATION.md
  - Future platform follow-ups for Bitbucket/Azure/Forgejo force-push invalidation

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Webhook-local best-effort heuristic using existing CodeManagementService methods"
    - "Focused handler unit spec instead of broad integration duplication"
    - "Fail-open invalidation check: log and continue when heuristic cannot be evaluated"

key-files:
  created:
    - libs/platform/infrastructure/webhooks/github/githubPullRequest.handler.spec.ts
  modified:
    - libs/platform/infrastructure/webhooks/github/githubPullRequest.handler.ts
    - .planning/phases/01-agent-migration/01-VERIFICATION.md

key-decisions:
  - "Did not widen the cross-platform CodeManagementService contract; the heuristic stays GitHub-local"
  - "Used `payload.before` vs current PR commit list as the ancestry surrogate instead of shell git or new API abstraction"
  - "Kept criterion 4 as PARTIAL in verification; GitHub coverage narrows the gap but does not close Bitbucket/Azure/Forgejo"
  - "Used a focused unit spec for invalidation behavior and skipped the existing integration spec because no module wiring changed"

patterns-established:
  - "For provider-specific webhook quirks, prefer handler-local logic over fake generic abstractions"
  - "Regression tests for outbox writes should assert routingKey + payload.reason directly"

# Metrics
duration: 1h
completed: 2026-05-04
---

# Phase 01 Plan 09: GitHub Force-Push Follow-up Summary

**GitHub `pull_request.synchronize` now emits best-effort `sandbox.invalidate` outbox events for rewritten branch history, with focused regression coverage and updated phase verification**

## Performance

- **Duration:** ~1h
- **Completed:** 2026-05-04
- **Tasks:** 4
- **Files modified/created:** 3

## Accomplishments

- Added a best-effort force-push heuristic to [githubPullRequest.handler.ts](/Users/wellingtonsantana/Documents/kodus-git/kodus-ai/libs/platform/infrastructure/webhooks/github/githubPullRequest.handler.ts) using `payload.before` against the current PR commit list
- Added focused unit coverage in [githubPullRequest.handler.spec.ts](/Users/wellingtonsantana/Documents/kodus-git/kodus-ai/libs/platform/infrastructure/webhooks/github/githubPullRequest.handler.spec.ts) for force-push detection, normal synchronize, missing `before`, and existing `pr_closed` behavior
- Updated [01-VERIFICATION.md](/Users/wellingtonsantana/Documents/kodus-git/kodus-ai/.planning/phases/01-agent-migration/01-VERIFICATION.md) so the residual phase gap is now explicitly Bitbucket/Azure/Forgejo rather than “GitHub + others”

## Files Created/Modified

- `libs/platform/infrastructure/webhooks/github/githubPullRequest.handler.ts` — best-effort force-push invalidation during `synchronize`
- `libs/platform/infrastructure/webhooks/github/githubPullRequest.handler.spec.ts` — focused unit spec for GitHub invalidation behavior
- `.planning/phases/01-agent-migration/01-VERIFICATION.md` — re-verification notes updated after GitHub-only follow-up

## Decisions Made

- The heuristic stays inside the GitHub handler because the behavior is provider-specific and does not justify a fake generic interface
- `payload.before` disappearing from the current PR commit list is the minimal useful signal for rewritten history in this codebase
- The handler logs and continues on lookup failure rather than risking webhook processing regressions
- Verification remains honest: criterion 4 is still `PARTIAL`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] EventEmitter mock was incomplete in the new spec**
- **Found during:** TDD RED run of the new GitHub handler spec
- **Issue:** The closed-path regression test crashed because `EventEmitter2.emit` was not mocked
- **Fix:** Added `emit: jest.fn()` to the test module mock
- **Files modified:** `libs/platform/infrastructure/webhooks/github/githubPullRequest.handler.spec.ts`
- **Verification:** The RED state narrowed to the intended missing `force_pushed` outbox write only

---

**Total deviations:** 1 auto-fixed
**Impact on plan:** No scope change. The fix only cleaned the test scaffold so the TDD cycle could proceed correctly.

## Verification

Executed:

```bash
yarn test libs/platform/infrastructure/webhooks/github/githubPullRequest.handler.spec.ts --runInBand
```

Result:

```text
Test Suites: 1 passed, 1 total
Tests:       4 passed, 4 total
```

Not run:

- `test/integration/platformData/save-pull-request-webhook.integration.spec.ts`

Reason:

- The follow-up did not change Nest module wiring or persistence flow shape; the new behavior is isolated to invalidation logic inside the handler and is directly covered by the focused unit spec.

## Next Phase Readiness

- GitHub is no longer part of the residual force-push gap for Phase 01
- Remaining force-push follow-ups, if any, are now clearly limited to Bitbucket, Azure, and Forgejo
- The phase can now be closed either by accepting the remaining provider limitations or by opening additional provider-specific follow-ups

---
*Phase: 01-agent-migration*
*Completed: 2026-05-04*
