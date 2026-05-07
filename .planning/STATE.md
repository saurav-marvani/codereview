# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-05-04)

**Core value:** Every interaction with Kody — review or conversation — should have the same depth of context and reasoning as a senior engineer pair-reviewing the PR alongside the user.
**Current focus:** Phase 4 — Observability & UX Decision (pending research)

## Current Position

Phase: 4 of 4 (Observability & UX Decision)
Plan: pending research
Status: Phase 3 complete + verified (passed 6/6 by gsd-verifier on 2026-05-04); ready for `/gsd:research-phase 4`
Last activity: 2026-05-04 — Phase 3 verifier passed 6/6: SC-1..5 + CONV-05 covered with code + test evidence; `@kody` traffic now routes through `runConversationLoop` behind `API_CONVERSATION_RUNTIME_ENABLED` env override / `conversationAgentRuntime` PostHog flag with instant fallback to legacy `conversationAgentUseCase`. Phase 4 will instrument latency and lock in the sync-vs-async UX decision.

Progress: [███████░░░] 75% (Phase 1 + Phase 2 + Phase 3 complete; Phase 4 pending)

## Performance Metrics

**Velocity:**
- Total plans completed: 19
- Average duration: 10.3 min
- Total execution time: 3.27 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01-agent-migration | 7 | 111 min | 15.9 min |
| 02-conversation-primitives | 6 | 35 min | 5.8 min |
| 03-wire-up-rollout | 6 | 50 min | 8.3 min |

**Recent Trend:**
- Last 5 plans: 03-02 (2 min), 03-03 (12 min), 03-04 (18 min), 03-05 (8 min), 03-06 (8 min)
- Trend: stabilized after 03-04 BYOK fix; smaller per-plan touches as the wire-up settled

*Updated after each plan completion*
| Phase 03-wire-up-rollout P01 | 2 | 2 tasks | 4 files |
| Phase 03-wire-up-rollout P04 | 18 | 2 tasks | 4 files |
| Phase 03-wire-up-rollout P02 | 2 | 1 tasks | 1 files |
| Phase 03-wire-up-rollout P03 | 12 | 2 tasks | 2 files |
| Phase 03-wire-up-rollout P05 | 8 | 1 tasks | 1 files |
| Phase 03-wire-up-rollout P06 | 8 | 1 tasks | 1 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Reframe 2026-05-04]: Previous roadmap Phase 1 ("Runtime Extensibility") was missing the sandbox prerequisite. New Phase 1 combines sandbox extraction (`libs/sandbox/`, `SandboxLeaseManager`) AND runtime extension points (`doneToolSchema`, `initialMessages`) because both are runtime-side, non-user-facing prerequisites that must ship together before conversation primitives can be built on top.
- [Reframe 2026-05-04]: Sandbox lifecycle is now E2B pause/resume (`onTimeout: 'pause'`, `autoResume: true`) — NOT a Mongo finite-state-machine. Mongo carries only lease coordination (atomic upsert keyed on `prKey`) and a reaper for crashed-worker cleanup. No Redis.
- [01-06 2026-04-29]: Used ModelMessage (ai v6) rather than CoreMessage — the SDK was already upgraded to v6; CoreMessage no longer exists. Zero semantic difference.
- [01-06 2026-04-29]: _verificationSchema intentionally NOT parameterized — the verification pass is always review-specific; non-review callers should set skipHeavyPasses:true to bypass it.
- [Pending]: MCP-vs-native tool integration approach (adapter / separate-call / routing layer) — decision deferred to Phase 2 research.
- [Pending]: Sync vs async UX — deferred to Phase 4 measurement.
- [Phase 01-agent-migration]: libs/sandbox/ module extracted from libs/code-review/ using re-export barrel pattern; SandboxModule owns SANDBOX_PROVIDER_TOKEN useFactory
- [01-02 2026-05-04]: INVALIDATED added to lease state enum beyond RESEARCH.md Pattern 2 (CREATING/READY/PAUSED) — required to guard mid-create race: force-push marks INVALIDATED, creator path kills orphaned sandbox
- [01-02 2026-05-04]: SandboxLeaseModel does not extend Mongoose Document (uses plain class pattern) — avoids TS2416 type incompatibility with Document<ObjectId>; identical runtime behavior
- [01-02 2026-05-04]: In-memory Map<leaseId,prKey> for release routing is acceptable for single-worker Phase 1; distributed release deferred to later plan
- [01-03 2026-05-04]: lifecycle: { onTimeout: 'pause', autoResume: true } on both Sandbox.create() call sites; autoResume must be explicit (SDK default is false — Sandbox.connect() throws on paused sandboxes without it)
- [01-03 2026-05-04]: pauseAfterIdle uses static Sandbox.setTimeout() — correct API for adjusting timeout on existing sandbox without needing an active connection
- [01-03 2026-05-04]: connectExisting returns Sandbox (not SandboxInstance) — SandboxLeaseManager owns the higher-level wrapping
- [Phase 01-agent-migration]: CreateSandboxStage now injects ISandboxLeaseManager; cleanup calls release() not kill(); prKey={orgId}:{repoId}:{prNumber}
- [Phase 01-04]: isAvailable() guard removed from CreateSandboxStage — lease manager handles null sandbox path internally
- [Phase 01-05]: Sandbox invalidation consumed in-process by OutboxRelayService routing-key branch — never published to RabbitMQ, eliminates two-consumer race condition
- [Phase 01-05]: Reaper scans ALL expired leases (no leaseCount filter) — handles crashed-worker cleanup (RESEARCH.md Pitfall 3)
- [01-07 2026-05-04]: EXT-01 test avoids finishReason:tool-calls response — findings.suggestions crash when custom schema lacks suggestions field; text-based result with valid JSON used instead
- [01-07 2026-05-04]: Global e2b mock extended with kill/connect/setTimeout — jest.mock(e2b, factory) in tests is overridden by moduleNameMapper; global mock is the only viable interception point
- [01-07 2026-05-04]: Concurrent acquire test asserts Sandbox.connect called once (joiner path) instead of createSandboxWithRepo — without cloneParams the manager takes null-sandbox path, not E2B create path
- [02-01 2026-05-04]: additionalTools typed as Record<string, any> to keep agent-loop.ts generic; specific tool schemas live in callers not the loop
- [02-01 2026-05-04]: Spread order is buildAgentTools first then additionalTools — caller override allowed but review callers prohibited by JSDoc constraint
- [02-01 2026-05-04]: isSelfContained runs after additionalTools merge — NullSandbox+additionalTools correctly yields isSelfContained=false (prevents premature single-shot termination for conversation callers)
- [02-02 2026-05-04]: ConversationModule skeleton exports only ConversationThreadRepository in Plan 02-02; CONVERSATION_SESSION_MANAGER_TOKEN provider and export deferred to Plan 02-03 to avoid empty provider errors
- [02-02 2026-05-04]: TTL on updatedAt (not createdAt) — active PRs reset TTL on each @kody interaction, keeping threads alive through long review cycles
- [02-03 2026-05-04]: ConversationSessionManager injects ConversationThreadRepository (not InjectModel directly) — service stays unaware of Mongoose internals; consistent with repository pattern
- [02-03 2026-05-04]: MAX_HISTORY_TURNS = 20 hardcoded (not env-configurable) — deterministic by design; no process.env.CONVERSATION_MAX_HISTORY_TURNS wired in earlier plans
- [02-04 2026-05-04]: buildConversationMemoryTools is a plain function (not NestJS service) — callers inject IKodyRulesService via KODY_RULES_SERVICE_TOKEN; avoids MCP layer gated behind API_MCP_SERVER_ENABLED
- [02-04 2026-05-04]: organizationId/teamId are per-call parameters (not closed-over at construction) — Pitfall 3 prevention for concurrent requests with different org contexts
- [02-04 2026-05-04]: JSON Schema inputSchema (not Zod) — Anthropic rejects Zod-generated schemas (missing type field); jsonSchema() from ai package produces correct raw schema
- [02-05 2026-05-04]: runConversationLoop is a plain async function (not NestJS service) — callable from any Phase 3 handler without DI setup
- [02-05 2026-05-04]: sandbox.remoteCommands accessed directly (not cast to any) — SandboxInstance contract exposes .remoteCommands for all types; NullSandbox branch returns undefined via conditional
- [02-05 2026-05-04]: Text fallback (output.text) when findings.reply absent — handles NullSandbox single-shot path where done-tool may not fire
- [02-05 2026-05-04]: Smoke test mocks runAgentLoop (not generateText) — correct level for testing the wiring layer without the full agent runtime
- [02-06 2026-05-04]: makeDoneToolResponse uses toolCalls:[{toolName:submitResult}] not text JSON — done-tool extraction path required for E2B E2E tests; text JSON falls back to raw string in output.text
- [02-06 2026-05-04]: NullSandbox test asserts reply.length > 0 not exact string — isSelfContained=true skips done-tool, text used directly via tryParseFindings fallback chain
- [02-06 2026-05-04]: Rule 1 fix in agent-loop.ts line 1849 — !skipHeavyPasses guard added to verify check; findings.suggestions?.length with optional chaining prevents crash when doneToolSchema overrides _findingsSchema on E2B sandbox
- [Phase 03-01]: wasCreated boolean set on all three return sites in sandbox-lease-manager.service.ts: handleCreatorPath returns true; connectToExisting (both no-key and E2B paths) returns false
- [Phase 03-01]: buildPrKey added to sandbox contract (not a new file) — co-located with AcquireResult and ISandboxLeaseManager for discoverability
- [Phase 03-01]: conversationAgentRuntime placed after agentReview in FEATURE_FLAGS — keeps semantically related agent-runtime flags adjacent
- [Phase 03-02]: forwardRef used for SandboxModule and ConversationModule in PlatformModule — consistent with existing pattern, prevents circular dependency
- [Phase 03-02]: Neither SandboxModule nor ConversationModule added to PlatformModule exports — ChatWithKodyFromGitUseCase is the only consumer and it lives inside PlatformModule
- [Phase 03-03]: posthog.isInitialized guard preserves self-hosted default: no PostHog key + no env override = legacy path runs (mirrors agentReview flag pattern)
- [Phase 03-03]: handleConversationViaRuntime catches errors returning user-visible string — never re-throws to comment-posting layer (Pitfall 7)
- [03-04 2026-05-04]: queueTimeoutMs is per-task in BYOKConcurrencyLimiter.run() — moved from constructor to run() parameter — so review (queueTimeoutMs=0) and conversation (queueTimeoutMs=60_000) share the same limiter and contend correctly
- [03-04 2026-05-04]: limiter cache key no longer discriminates by queueTimeoutMs; only concurrency (maxConcurrentRequests) determines limiter identity
- [03-04 2026-05-04]: byokQueueTimeoutMs defaults to 60_000 in runConversationLoop (not in AgentLoopSecrets) — conversation always gets bounded queue wait; review callers leave undefined → 0 → infinite (unchanged)
- [Phase 03-05]: detectCommandType is module-level (not class method) — coexists with private class method by different call site
- [Phase 03-05]: PHASE-4 INSTRUMENTATION comment marks seam; no OTel spans or metric emission in Phase 3
- [03-06 2026-05-04]: Test 7 (CONV-05) captures sessionManager from firstCallArgs.sessionManager and sets mockResolvedValue on it — avoids clearAllMocks fragility with Once values; runConversationLoop mock never calls materializeInitialMessages so assertion calls it explicitly
- [03-06 2026-05-04]: Test 4 (PERF-02) forces error path to capture logger.error metadata.sandboxState='paused-resumed' — the only interception point without restructuring the use case
- [03-06 2026-05-04]: chat-with-kody-runtime-dispatch.spec.ts is the Phase 3 automated health signal (7 tests, 531 lines); byok-queue-timeout.spec.ts (Plan 03-04) covers SC-5

### Pending Todos

None yet.

### Blockers/Concerns

- Phase 1 is the only phase that can land safely as an isolated change. Phases 2 and 3 must ship together for any user-visible effect.
- Phase 4 depends on real traffic through Phase 3 — do not start Phase 4 instrumentation before Phase 3 is in production.
- BYOK concurrency limiter is per-process global — review and conversation on the same worker could contend; characterize in Phase 3 before rollout.

## Session Continuity

Last session: 2026-05-04
Stopped at: Completed 03-wire-up-rollout/03-06-PLAN.md — Phase 3 complete; 7 integration tests for runtime dispatch (chat-with-kody-runtime-dispatch.spec.ts); all 5 SC covered; 0 regressions in existing spec; Phase 3 ready for verifier.
Resume file: None
