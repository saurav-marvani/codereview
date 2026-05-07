# Requirements: Kodus AI — Conversation Runtime Integration Milestone

**Defined:** 2026-04-30
**Updated:** 2026-05-04 (post-E2B-SDK audit + sandbox layer reframe — sandbox is now a shared capability via `libs/sandbox/` + `SandboxLeaseManager`, lifecycle uses E2B pause/resume, no Redis)
**Core Value:** Every interaction with Kody — review or conversation — should have the same depth of context and reasoning as a senior engineer pair-reviewing the PR alongside the user.
**Tracking issue:** [kodustech/kodus-ai#1025](https://github.com/kodustech/kodus-ai/issues/1025)

## v1 Requirements

This milestone has two intertwined arcs:

1. **Restructure the sandbox layer**: extract it from the code review pipeline into a shared `libs/sandbox/` module owned by a `SandboxLeaseManager`, with lifecycle backed by E2B pause/resume.
2. **Plug `@kody` PR conversations into the review agent runtime** so a conversational reply has access to the runtime's native tools (grep, readFile, type-check, cross-file refs, doc search) inside that managed sandbox.

The previous version of this file framed it only as the second arc; the first emerged after auditing E2B SDK features and recognizing that sandbox is a property of the PR, not of code review.

### Sandbox Capability (Shared Across Consumers)

- [x] **SBX-01**: Sandbox capability is extracted into a standalone `libs/sandbox/` module. `ISandboxProvider`, the existing providers (`E2BSandboxService`, `LocalSandboxService`, `NullSandboxService`), and the new `SandboxLeaseManager` live there. Both code review pipeline and the conversation flow consume from this module — review's existing `CreateSandboxStage` and `CodeReviewPipelineObserver.onPipelineFinish` are refactored to acquire/release leases through `SandboxLeaseManager` instead of provisioning the sandbox directly.
- [x] **SBX-02**: `SandboxLeaseManager` exposes `acquire(prKey, consumer, leaseTtlMs)`, `release(leaseId)`, and `invalidate(prKey)`. `acquire` creates a sandbox or connects to an existing one (resuming it from pause if needed) atomically; `release` returns the lease and lets the idle timeout drive the next state; `invalidate` kills the sandbox and removes coordination state.
- [x] **SBX-03**: E2B sandboxes are created with `lifecycle: { onTimeout: 'pause', autoResume: true }`. Idle behavior drives the sandbox into pause via `setTimeout` (cheap storage-only cost); subsequent acquires call `Sandbox.connect(sandboxId)` which auto-resumes. The legacy "create and kill at end of pipeline" semantics are no longer the default.
- [x] **SBX-04**: Lease coordination uses a MongoDB collection (e.g. `sandbox_leases`) keyed on `{org}:{repo}:{pr}`. Race-safe acquire via atomic `findOneAndUpdate({_id: prKey}, {$setOnInsert: {state: 'CREATING'}}, {upsert: true})`. Each lease entry carries its own `acquiredAt + ttl` so a lightweight reaper cron can clean up leases dropped by crashed workers; no Redis is introduced.
- [x] **SBX-05**: PR-close and force-push events trigger sandbox invalidation via the outbox pattern: webhook handlers write outbox events in their existing transactions, and an outbox worker calls `SandboxLeaseManager.invalidate(prKey)` to kill the sandbox and delete the Mongo doc. Stale sandboxes (post-force-push) never serve another `@kody`.
- [x] **SBX-06**: Self-hosted deployments without E2B configured continue working: when `E2B_API_KEY` is absent, `SandboxLeaseManager` returns a `NullSandbox` lease that callers detect and fall back to self-contained mode (single-shot agent, no native tools). Both review and conversation honor this fallback identically.

### Runtime Extensibility (Generic, Benefits Both Review and Conversation)

- [x] **EXT-01**: `runAgentLoop` accepts an optional `doneToolSchema` in `AgentLoopInput`; when absent, defaults to the existing `_findingsSchema` (zero behavior change for review)
- [x] **EXT-02**: `runAgentLoop` accepts an optional `initialMessages` in `AgentLoopInput` to seed multi-turn context; when absent, defaults to `[system, user]` (zero behavior change for review)
- [x] **EXT-03**: Native tools registry remains generic — conversation does not introduce review-coupled tools into `agent-tools.factory.ts`; if a conversation-only tool is needed, it goes through the same `mkTool` contract and is gated by capability checks consistent with existing tools

### Conversation Runtime Integration

- [x] **CONV-01**: `@kody` PR-comment replies are produced by invoking `runAgentLoop` (the same loop that powers code review) with conversation-specific inputs (system prompt, user prompt assembled from comment + thread, `initialMessages` for multi-turn context, native tools registry)
- [x] **CONV-02**: A `runConversationLoop` wrapper exposes a conversation-shaped API on top of `runAgentLoop` (text output instead of `CodeSuggestion[]`, no coverage ledger, no `changedFiles` requirement); the underlying `runAgentLoop` is reused unchanged except for `doneToolSchema` and `initialMessages` (see EXT-01, EXT-02)
- [x] **CONV-03**: Memory creation (`@kody remember ...`, explicit and implicit) keeps its observable behavior — same triggers, same confirmations, same in-PR responses — under whichever MCP-vs-native integration approach phase research selects
- [x] **CONV-04**: Conversation has access to the runtime's native tools (`grep`, `readFile`, `listDir`, `findFile`, `checkTypes`, `readReference`, `searchDocs`) within the leased sandbox
- [x] **CONV-05**: Multi-turn conversation works — a follow-up `@kody` reply on the same PR thread sees the prior `@kody` interactions in its context (via `initialMessages`)

### Thread State Persistence

- [x] **STATE-01**: Conversation thread messages are persisted across `@kody` interactions on a PR in MongoDB alongside the existing PR conversation collections (no new datastore unless research finds the existing one unsuitable)
- [x] **STATE-02**: A `ConversationSessionManager` (or equivalent) loads the thread on each `@kody` invocation, materializes `initialMessages` for `runAgentLoop`, and persists the new turn back

### Performance

- [ ] **PERF-01**: A latency budget for `@kody` reply latency is defined and enforced via measurement (target TBD in observability phase; if sync p95 exceeds the budget, async UX with status placeholder is mandatory; if within budget, sync UX is preferred)
- [ ] **PERF-02**: Sandbox reuse via E2B pause/resume measurably cuts the per-comment cold-start cost on conversation thread N>1 — the second `@kody` on a PR resumes from pause in <5s instead of cold-creating in 15–30s
- [x] **PERF-03**: BYOK concurrency limiter (`runWithBYOKLimiter`) does not deadlock review and conversation invocations against each other when both run on the same worker process — characterized via test, mitigated if observed

### Maintainability

- [x] **MAINT-01**: Zero forking of the runtime — all phase deliverables either reuse existing seams or extract new generic seams (benefiting both review and conversation); no parallel `runAgentLoop` variant, no parallel sandbox lifecycle layer, no parallel tools registry
- [x] **MAINT-02**: Conversation-specific code lives in conversation-specific files (`runConversationLoop`, `ConversationSessionManager`) — no review-side files gain conversation branches; review continues to depend only on the generic seams + `libs/sandbox/`

### Testability

- [x] **TEST-01**: An in-memory `RemoteCommands` mock is delivered, capable of driving multi-step `runAgentLoop` exchanges; usable in tests for both review and conversation
- [x] **TEST-02**: `runConversationLoop` has end-to-end tests that drive the full loop (mock LLM + mock RemoteCommands + golden traces) and assert message-history correctness, tool-call sequencing, and final text output
- [x] **TEST-03**: Memory creation regression tests covering: explicit `@kody remember ...`, implicit-intent capture, duplicate-detection, MCP-vs-native integration approach (per phase research decision)
- [x] **TEST-04**: `SandboxLeaseManager` has integration tests covering acquire-then-release-cycle, race-safe acquire across simulated concurrent calls, lease leak via crashed-worker simulation (reaper compensates), and PR-close-triggered invalidation through the outbox pattern

### Rollout

- [x] **RLLT-01**: The new conversation runtime path is gated behind a feature flag (org-level minimum, per-provider granularity if cheap to add)
- [x] **RLLT-02**: Disabling the flag reverts to the legacy `ConversationAgentProvider` (slim MCP-only path) for that scope, in real time, without redeploy

### Observability & UX Decision

- [ ] **OBS-01**: End-to-end latency of the conversation runtime path (webhook in → reply posted) is instrumented and emitted as a metric, segmented by provider, command type (question / remember / other), sandbox state at acquire (cold-create / warm-running / paused-resumed), and tool-call count
- [ ] **OBS-02**: A latency-impact decision is documented with measured data — pick sync (if p95 within budget) or async UX (status placeholder + edit-in-place when ready)

## v2 Requirements

Deferred to a future milestone. Tracked here so we don't lose them.

### Conversation Surface Expansion

- **CONV-V2-01**: Conversational surface beyond PR comments (web chat UI, CLI conversation) routed through the same runtime path
- **CONV-V2-02**: Persistent thread context across multiple PRs (e.g., remember a clarification from PR #100 when reviewing PR #150 in the same repo)

### Conversation Features

- **CMD-V2-01**: Slash commands inside `@kody` messages (e.g., `/test`, `/explain`, `/review-again`)
- **CMD-V2-02**: Cross-message file diffing ("compare this with my previous reply")

### Performance / Cost

- **PERF-V2-01**: Sandbox warm pool — pre-allocated sandboxes with repos pre-cloned, eliminating cold-start at the cost of base infrastructure spend (only consider if pause/resume isn't fast enough in production measurements)
- **PERF-V2-02**: Lazy sandbox provisioning — provision only when a tool call actually needs the sandbox, not at conversation start

## Out of Scope

| Feature | Reason |
|---------|--------|
| Migrating the dedicated code review pipeline | Already runs through this runtime — nothing to migrate |
| Web chat / CLI conversation parity | Different surface; separate milestone after PR-comment path is stable |
| New conversational features (slash commands, multi-turn re-ask, message-cross-diff) | Out of scope for this integration; capture as v2 |
| Replacing `@kodus/flow` types with another runtime | The integration is *toward* this runtime, not away from it |
| Replacing E2B with another sandbox | `ISandboxProvider` keeps the abstraction; swap is future work |
| Sandbox warm pool | Infra investment; v2 if cold-start dominates after pause/resume work |
| Rebuilding memory creation logic | The MCP tool already does it; reconcile, don't replace |
| Redis | Mongo + outbox cover coordination needs without new infra |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SBX-01 | Phase 1 | Complete |
| SBX-02 | Phase 1 | Complete |
| SBX-03 | Phase 1 | Complete |
| SBX-04 | Phase 1 | Complete |
| SBX-05 | Phase 1 | Complete |
| SBX-06 | Phase 1 | Complete |
| EXT-01 | Phase 1 | Complete |
| EXT-02 | Phase 1 | Complete |
| EXT-03 | Phase 1 | Complete |
| TEST-01 | Phase 1 | Complete |
| TEST-04 | Phase 1 | Complete |
| CONV-02 | Phase 2 | Complete |
| CONV-03 | Phase 2 | Complete |
| STATE-01 | Phase 2 | Complete |
| STATE-02 | Phase 2 | Complete |
| MAINT-01 | Phase 2 | Complete |
| MAINT-02 | Phase 2 | Complete |
| TEST-02 | Phase 2 | Complete |
| TEST-03 | Phase 2 | Complete |
| CONV-01 | Phase 3 | Complete (2026-05-04) |
| CONV-04 | Phase 3 | Complete (2026-05-04) |
| CONV-05 | Phase 3 | Complete (2026-05-04) |
| RLLT-01 | Phase 3 | Complete (2026-05-04) |
| RLLT-02 | Phase 3 | Complete (2026-05-04) |
| PERF-02 | Phase 3 | Pending (deferred to Phase 4 — needs real-traffic latency measurement to verify <5s warm-resume claim) |
| PERF-03 | Phase 3 | Complete (2026-05-04) |
| OBS-01 | Phase 4 | Pending |
| OBS-02 | Phase 4 | Pending |
| PERF-01 | Phase 4 | Pending |

**Coverage:**
- v1 requirements: 29 total
- Mapped to phases: 29
- Unmapped: 0

---
*Requirements defined: 2026-04-30*
*Last updated: 2026-05-04 after E2B SDK feature audit + sandbox layer reframe*
