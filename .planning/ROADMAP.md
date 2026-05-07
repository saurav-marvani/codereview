# Roadmap: Kodus AI — Conversation Runtime Integration Milestone

## Overview

This milestone restructures the sandbox layer into a shared capability and plugs `@kody` PR-comment conversations into the review agent runtime. Phase 1 extracts `libs/sandbox/` and builds `SandboxLeaseManager` (with E2B pause/resume and Mongo lease coordination), then adds the two generic extension points to `runAgentLoop` — all with zero user-visible change. Phase 2 builds conversation-specific primitives (`runConversationLoop`, `ConversationSessionManager`, MCP-vs-native reconciliation) in isolation. Phase 3 routes live `@kody` traffic through the new wrapper behind a feature flag. Phase 4 instruments real traffic and locks in the sync-vs-async UX decision.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3, 4): Planned milestone work
- Decimal phases (N.1, N.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundations — Sandbox Capability + Runtime Extensibility** ✓ Complete (2026-05-04) - Extract `libs/sandbox/` module, build `SandboxLeaseManager` with E2B pause/resume + Mongo lease coordination + outbox invalidation, refactor review pipeline to consume through the new layer, add `doneToolSchema` + `initialMessages` extension points, deliver in-memory `RemoteCommands` mock and lease integration tests; zero user-visible change
- [x] **Phase 2: Conversation Primitives** ✓ Complete (2026-05-04) - Build `runConversationLoop` wrapper, `ConversationSessionManager` for Mongo thread persistence, and resolve MCP-vs-native tool reconciliation; no live traffic routed yet
- [x] **Phase 3: Wire-up & Rollout** ✓ Complete (2026-05-04) - Route `@kody` PR-comment traffic through the new wrapper behind a feature flag with real-time fallback to the legacy path
- [ ] **Phase 4: Observability & UX Decision** - Instrument end-to-end latency, measure against real traffic, and make a data-backed sync-vs-async UX decision

## Phase Details

### Phase 1: Foundations — Sandbox Capability + Runtime Extensibility
**Goal**: The sandbox becomes a shared `libs/sandbox/` capability with pause/resume lifecycle, the review pipeline continues identically through the new abstraction, and `runAgentLoop` gains two generic extension points; no behavior change visible to users or review output
**Depends on**: Nothing (first phase)
**Requirements**: SBX-01, SBX-02, SBX-03, SBX-04, SBX-05, SBX-06, EXT-01, EXT-02, EXT-03, TEST-01, TEST-04
**Success Criteria** (what must be TRUE):
  1. The full existing code review test suite passes unchanged after the refactor — `CreateSandboxStage` and `CodeReviewPipelineObserver` now go through `SandboxLeaseManager` but review output is identical
  2. After a review pipeline completes, the sandbox transitions to paused state (not killed) — verifiable by observing that `sandbox.kill()` is no longer called unconditionally and that a subsequent acquire connects via `Sandbox.connect()` rather than cold-creating
  3. A concurrent acquire-on-the-same-`prKey` test drives two simultaneous `SandboxLeaseManager.acquire()` calls and confirms that exactly one create (not two) occurs; the reaper cron compensates for a simulated crashed-worker lease within its TTL window
  4. PR-close webhook events trigger `SandboxLeaseManager.invalidate(prKey)` on all 5 platforms (GitHub, GitLab, Bitbucket, Azure DevOps, Forgejo). Force-push webhook events trigger invalidation on GitHub (the only platform whose webhook lets us detect a force-push — via the `before` SHA disappearing from the PR commit list in `synchronize` events); on the other 4 platforms the reaper cron (5 min TTL) acts as backstop, cleaning stale sandboxes within the TTL window. Verified by the outbox integration test and the reaper test in `sandbox-lease-manager.spec.ts`
  5. A self-hosted instance with `E2B_API_KEY` absent receives a `NullSandbox` lease from `SandboxLeaseManager` and the review pipeline completes in self-contained mode (unchanged behavior)
  6. A test calls `runAgentLoop` with a custom `doneToolSchema` (e.g., `{ reply: z.string() }`) and the loop uses that schema for its done-tool; a separate test seeds `initialMessages` and confirms those messages appear at step 0; both tests use the in-memory `RemoteCommands` mock with no E2B dependency
**Plans**: 7 plans

Plans:
- [x] 01-01-PLAN.md — Extract libs/sandbox/ directory tree, move ISandboxProvider + 3 provider impls, create SandboxModule with useFactory DI, convert libs/code-review barrel to re-export
- [x] 01-02-PLAN.md — Build Mongoose sandbox_leases schema, atomic upsert repository, SandboxLeaseManager service (acquire/release/invalidate), wire SANDBOX_LEASE_MANAGER_TOKEN into SandboxModule
- [x] 01-03-PLAN.md — Add lifecycle: {onTimeout: 'pause', autoResume: true} to both Sandbox.create() call sites; add pauseAfterIdle() and connectExisting() to E2BSandboxService
- [x] 01-04-PLAN.md — Refactor CreateSandboxStage to inject ISandboxLeaseManager; cleanup closure calls release() not kill(); verify full review test suite passes unchanged
- [x] 01-05-PLAN.md — Build SandboxLeaseReaperService (@Cron/5min + DistributedLockService); hook PR-close and force-push in all 5 webhook handlers to emit SandboxInvalidateEvent via EventEmitter2
- [x] 01-06-PLAN.md — Add doneToolSchema? and initialMessages? to AgentLoopInput; parameterize buildDoneTools(); inject initialMessages as [system, ...initialMessages, user] when provided
- [x] 01-07-PLAN.md — Create createMockRemoteCommands() fixture; write agent-loop extension tests (EXT-01, EXT-02); write SandboxLeaseManager integration tests (acquire/release, concurrent race, invalidate, NullSandbox, reaper)

### Phase 2: Conversation Primitives
**Goal**: All conversation-specific infrastructure exists and is tested in isolation — the `runConversationLoop` wrapper, Mongo thread-state persistence via `ConversationSessionManager`, and a documented MCP-vs-native tool reconciliation decision — but no live `@kody` traffic is routed through it yet
**Depends on**: Phase 1
**Requirements**: CONV-02, CONV-03, STATE-01, STATE-02, MAINT-01, MAINT-02, TEST-02, TEST-03
**Success Criteria** (what must be TRUE):
  1. `runConversationLoop` called with a mock LLM + in-memory `RemoteCommands` mock + seeded message history returns a text reply (not `CodeSuggestion[]`); the test asserts message-history correctness, tool-call sequencing, and final text output
  2. `ConversationSessionManager` persists and reloads a thread across two simulated `@kody` invocations with no shared in-process state between calls; the second invocation sees the first turn in its `initialMessages`
  3. Memory creation (`@kody remember ...`) produces the same observable confirmation and stored memory under the chosen MCP-vs-native integration approach; regression tests cover explicit remember, implicit capture, and duplicate detection
  4. In a self-hosted environment where `SandboxLeaseManager` returns a `NullSandbox` lease, `runConversationLoop` completes without throwing and returns a text reply (single-step LLM, no native tools)
  5. No review-side files (`agent-loop.ts`, `agent-tools.factory.ts`, `base-code-review-agent.provider.ts`) gain conversation-specific branches; all conversation logic lives in `runConversationLoop` and `ConversationSessionManager`
**Plans**: 6 plans

Plans:
- [x] 02-01-PLAN.md — Add additionalTools? field to AgentLoopInput; merge into tools object in runAgentLoop; write EXT-03 test asserting extra tools appear in generateText call
- [x] 02-02-PLAN.md — Create libs/conversation/ scaffold: domain contracts, ConversationThread Mongoose schema (TTL 90d on updatedAt), atomic $push repository, ConversationModule skeleton
- [x] 02-03-PLAN.md — Implement ConversationSessionManager (load/appendTurn/materializeInitialMessages with 20-turn truncation); wire as CONVERSATION_SESSION_MANAGER_TOKEN; 6 unit tests with mocked repo
- [x] 02-04-PLAN.md — Build buildConversationMemoryTools factory (Option A adapter): wraps IKodyRulesService.createOrUpdateMemory + findMemories as mkTool-compatible; 5 unit tests covering explicit/implicit/duplicate-detection
- [x] 02-05-PLAN.md — Implement runConversationLoop: NullSandbox detection, materializeInitialMessages seeding, runAgentLoop call with CONVERSATION_DONE_SCHEMA, appendTurn on reply, return { reply, steps, toolCalls }
- [x] 02-06-PLAN.md — Write TEST-02 (run-conversation-loop.spec.ts: 6 tests covering SC-1/SC-2/SC-4/SC-5) and TEST-03 (memory-regression.spec.ts: 5 tests covering SC-3)

### Phase 3: Wire-up & Rollout
**Goal**: Live `@kody` PR-comment traffic is routed through `runConversationLoop` (and thus through the review agent runtime with sandbox and native tools) behind a feature flag, with instant fallback to the legacy `ConversationAgentProvider` path when the flag is off
**Depends on**: Phase 2
**Requirements**: CONV-01, CONV-04, CONV-05, RLLT-01, RLLT-02, PERF-02, PERF-03
**Success Criteria** (what must be TRUE):
  1. A developer posting `@kody why is this file excluded from review?` in a PR comment (flag on) receives a reply that references actual repo content (grep results, file reads) — depth the legacy MCP-only path cannot provide
  2. A follow-up `@kody` on the same PR thread (flag on) correctly references what was said in the prior exchange — multi-turn context is live in production
  3. An operator flipping the feature flag off for an org reverts all `@kody` replies for that scope to the legacy path immediately, without redeploy; flipping it back switches to the new path immediately
  4. Sandbox cold-start cost is paid only once per PR thread — subsequent `@kody` comments resume from pause (confirmed by observing that `SandboxLeaseManager.acquire` returns a connected-not-created sandbox and the p95 resume time is under 5s)
  5. Review and conversation invocations sharing a worker process under a BYOK concurrency-limited provider are characterized for deadlock risk before Phase 3 ships; if a deadlock is observed, a mitigation is in place
**Plans**: 6 plans

Plans:
- [x] 03-01-PLAN.md — Add conversationAgentRuntime to FEATURE_FLAGS; document API_CONVERSATION_RUNTIME_ENABLED in .env.example; extract buildPrKey helper; add wasCreated to AcquireResult
- [x] 03-02-PLAN.md — Wire SandboxModule and ConversationModule into PlatformModule.imports (critical NestJS DI prerequisite)
- [x] 03-03-PLAN.md — Inject new deps into ChatWithKodyFromGitUseCase; implement handleConversationViaRuntime with try/finally lease lifecycle; add flag-dispatch to handleConversation
- [x] 03-04-PLAN.md — Thread byokQueueTimeoutMs through ConversationLoopInput → AgentLoopSecrets → throttledGenerateText → runWithBYOKLimiter; write PERF-03 BYOK characterization test
- [x] 03-05-PLAN.md — Add Phase 4 instrumentation labels (sandboxState, byokProvider, commandType) to handleConversationViaRuntime; add detectCommandType helper with tests
- [x] 03-06-PLAN.md — Write 6 integration tests (dispatch, legacy fallback, flag flip, sandbox reuse label, lease-leak prevention, memory regression under flag-on)

### Phase 4: Observability & UX Decision
**Goal**: End-to-end `@kody` reply latency is instrumented, measured against real (or realistic staging) traffic, and a documented decision selects synchronous or async UX — with the async path implemented if the data demands it
**Depends on**: Phase 3
**Requirements**: OBS-01, OBS-02, PERF-01
**Success Criteria** (what must be TRUE):
  1. A latency metric for the conversation runtime path (webhook-in to reply-posted) is emitted and queryable, segmented by Git provider, command type (question / remember / other), sandbox reuse state at acquire (cold-create / paused-resumed / running), and tool-call count
  2. A decision document (in PROJECT.md Key Decisions or a linked doc) records measured p50/p95 latency for cold-start and warm-resumed paths, states the latency budget threshold, and declares sync or async UX as the outcome
  3. If async UX is chosen: a developer triggering a slow `@kody` reply sees a placeholder comment appear within 2s of the webhook and the comment updates in place when the agent finishes; if sync is chosen, this criterion is satisfied by the measurement confirming p95 is within the stated budget
**Plans**: TBD

Plans:
- [ ] 04-01: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundations — Sandbox Capability + Runtime Extensibility | 7/7 | ✓ Complete | 2026-05-04 |
| 2. Conversation Primitives | 6/6 | ✓ Complete | 2026-05-04 |
| 3. Wire-up & Rollout | 0/6 | Not started | - |
| 4. Observability & UX Decision | 0/TBD | Not started | - |
