# Phase 3: Wire-up & Rollout — Research

**Researched:** 2026-05-04
**Domain:** NestJS use-case dispatch, PostHog feature flags, SandboxLeaseManager lifecycle, BYOK concurrency limiter
**Confidence:** HIGH (all findings verified against live source files in working tree)

---

## Summary

Phase 3 inserts a feature-flag branch inside an existing private method of `ChatWithKodyFromGitUseCase`. The dispatch seam is `handleConversation()` (lines 1810–1823), called from `processCommand()` (lines 1782–1800), which itself is called only from `handleConversationFlow()` (lines 780–784). The flag check goes into `handleConversation()`: when `conversationAgentRuntime` flag is on, route to the new path; when off, call `this.conversationAgentUseCase.execute()` as today.

The BYOK concurrency limiter (`limiterCache`, `BYOKConcurrencyLimiter`) is a module-level singleton keyed by `{orgId}::{provider}::{apiKey}::{baseURL}::{model}`. Both review and conversation share the same limiter instance when they use the same BYOK provider account. The default queue timeout is 0 (infinite wait). This is the deadlock risk: review holds a slot for minutes while conversation blocks forever. Mitigation: pass a bounded `queueTimeoutMs` (e.g. 60 000 ms) when conversation calls `runWithBYOKLimiter` — conversation fails fast with an error that can be caught and turned into a polite PR comment, rather than hanging indefinitely.

There is no shared `buildPrKey` helper yet. The pattern `${organizationId}:${repositoryId}:${prNumber}` appears verbatim in five webhook handlers and in `create-sandbox.stage.ts:89–91`. Phase 3 must add this helper to `libs/sandbox/domain/contracts/sandbox-lease-manager.contract.ts` or a new `libs/sandbox/domain/utils/pr-key.ts` and use it consistently.

**Primary recommendation:** Add `conversationAgentRuntime` to `FEATURE_FLAGS`, add `API_CONVERSATION_RUNTIME_ENABLED` env override (mirrors `API_AGENT_REVIEW_ENABLED` pattern), insert the flag check inside `handleConversation()`, wire `SandboxModule` and `ConversationModule` into `PlatformModule`, and pass `queueTimeoutMs: 60_000` on all `runWithBYOKLimiter` calls from `runConversationLoop`.

---

## Standard Stack

### Core (Phase 1 + Phase 2 deliverables — already exist, do not recreate)

| Symbol | File | Purpose |
|--------|------|---------|
| `runConversationLoop` | `libs/conversation/infrastructure/services/conversation-loop.service.ts` | The agent loop entry point for conversation turns |
| `ISandboxLeaseManager` / `SANDBOX_LEASE_MANAGER_TOKEN` | `libs/sandbox/domain/contracts/sandbox-lease-manager.contract.ts` | Acquire/release sandbox leases |
| `SandboxModule` | `libs/sandbox/modules/sandbox.module.ts` | NestJS module that exports `SANDBOX_LEASE_MANAGER_TOKEN` |
| `ConversationSessionManager` / `CONVERSATION_SESSION_MANAGER_TOKEN` | `libs/conversation/infrastructure/services/conversation-session-manager.service.ts` | Mongo-backed thread persistence; `appendTurn` is atomic `$push` (concurrent-safe) |
| `ConversationModule` | `libs/conversation/modules/conversation.module.ts` | NestJS module that exports `CONVERSATION_SESSION_MANAGER_TOKEN` |
| `buildConversationMemoryTools` | `libs/conversation/infrastructure/services/conversation-tools.factory.ts` | Memory tool factory; returns `{}` when `kodyRulesService` is absent (self-hosted safe) |

### Existing codebase symbols that Phase 3 wires together

| Symbol | File | Purpose |
|--------|------|---------|
| `posthog.isFeatureEnabled` | `libs/common/utils/posthog/index.ts:38–59` | Feature flag evaluation; returns `true` when PostHog key is absent (safe default) |
| `FEATURE_FLAGS` | `libs/common/utils/posthog/index.ts:4–15` | Registry to extend with `conversationAgentRuntime` |
| `ChatWithKodyFromGitUseCase` | `libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case.ts` | Dispatch seam for all `@kody` traffic — `handleConversation()` is the insertion point |
| `ConversationAgentUseCase` | `libs/agents/application/use-cases/conversation-agent.use-case.ts` | Legacy fallback — unchanged, called when flag is off |
| `PlatformModule` | `libs/platform/modules/platform.module.ts` | Parent NestJS module — must add `SandboxModule` + `ConversationModule` to imports |
| `PermissionValidationService.getBYOKConfig` | `libs/ee/shared/services/permissionValidation.service.ts:593` | Fetch org BYOK config to pass into `runConversationLoop` |
| `runWithBYOKLimiter` | `libs/code-review/infrastructure/agents/llm/byok-to-vercel.ts:605–642` | Process-global BYOK concurrency limiter (shared by review + conversation) |

### Installation

No new packages. All required libraries are already in the monorepo. The only change is NestJS module wiring.

---

## Architecture Patterns

### Pattern 1: Feature-flag dispatch inside `handleConversation()`

**What:** Insert an if-branch at lines 1810–1823 of `chatWithKodyFromGit.use-case.ts`. When the flag is on, acquire a sandbox lease, call `runConversationLoop`, post the reply using the existing `codeManagementService` call chain. When off, call `this.conversationAgentUseCase.execute()` as today.

**Template:** `libs/core/providers/code-review-pipeline.provider.ee.ts:58–96` — the `agentReview` flag pattern. Identical structure: env override first, then `posthog.isFeatureEnabled`, then dispatch.

**Seam — the exact location of the if-branch:**

```typescript
// chatWithKodyFromGit.use-case.ts  lines 1810–1823 today (legacy path)
private async handleConversation(context: {
    prepareContext: any;
    organizationAndTeamData: OrganizationAndTeamData;
    thread: any;
}): Promise<string> {
    const { prepareContext, organizationAndTeamData, thread } = context;
    // ↑ INSERT flag check here before the legacy call
    return await this.conversationAgentUseCase.execute({
        prompt: prepareContext.userQuestion,
        organizationAndTeamData,
        prepareContext: prepareContext,
        thread: thread,
    });
}
```

**New shape (illustrative — not the plan itself):**

```typescript
private async handleConversation(context: {...}): Promise<string> {
    const { prepareContext, organizationAndTeamData, thread } = context;

    const featureIdentifier =
        organizationAndTeamData.organizationId ?? 'unknown';
    const repositoryId = prepareContext.repository?.id;

    const envOverride = process.env.API_CONVERSATION_RUNTIME_ENABLED?.toLowerCase();
    let useNewRuntime = envOverride === 'true' || envOverride === '1';

    if (!useNewRuntime && posthog.isInitialized) {
        const flagResult = await posthog.isFeatureEnabled(
            FEATURE_FLAGS.conversationAgentRuntime,
            featureIdentifier,
            organizationAndTeamData,
            repositoryId,
        );
        useNewRuntime = flagResult === true;
    }

    if (useNewRuntime) {
        return await this.handleConversationViaRuntime(context);
    }

    // Legacy fallback (unchanged)
    return await this.conversationAgentUseCase.execute({
        prompt: prepareContext.userQuestion,
        organizationAndTeamData,
        prepareContext: prepareContext,
        thread: thread,
    });
}
```

**Granularity:** Org-level minimum (pass `organizationId` as identifier). Per-repo granularity is free — pass `repositoryId` as the optional fourth argument, matching exactly the `agentReview` call at `code-review-pipeline.provider.ee.ts:77–83`.

**Flag check is at entry per webhook invocation.** It is NOT checked again mid-conversation. A flag flip affects the next webhook only — in-flight calls complete on whatever path they started. This satisfies RLLT-02 (no redeploy) and rollback safety (OQ-8).

### Pattern 2: Lease acquire/release lifecycle for conversation

**Template:** `libs/code-review/pipeline/stages/create-sandbox.stage.ts:88–128` for acquire, `libs/code-review/infrastructure/observers/code-review-pipeline.observer.ts:51–58` for release (via `context.sandboxHandle.cleanup()`).

**Key difference for conversation:** Review releases via the observer's `onPipelineFinish`. Conversation has no observer — the caller (`handleConversationViaRuntime`) must use `try/finally` directly.

**Shape:**

```typescript
private async handleConversationViaRuntime(context: {...}): Promise<string> {
    const { prepareContext, organizationAndTeamData } = context;
    const prKey = buildPrKey(
        organizationAndTeamData.organizationId,
        prepareContext.repository.id,
        prepareContext.pullRequest.pullRequestNumber,
    );

    const { sandbox, leaseId } = await this.leaseManager.acquire(
        prKey,
        'conversation',
        5 * 60 * 1000, // 5 min TTL — covers slow LLM calls + comment posting
    );

    try {
        const reply = await runConversationLoop({
            model:       /* resolved model from byokConfig */,
            systemPrompt: CONVERSATION_SYSTEM_PROMPT,
            userPrompt:  prepareContext.userQuestion,
            prKey,
            sandbox,
            sessionManager: this.sessionManager,
            memoryTools:    buildConversationMemoryTools(
                                this.kodyRulesService ?? null,
                                organizationAndTeamData.organizationId,
                                organizationAndTeamData.teamId,
                            ),
            byokConfig:   this.byokConfig,
            repositoryFullName: prepareContext.repository?.fullName,
        });
        return reply.reply;
    } finally {
        await this.leaseManager.release(leaseId);
    }
}
```

**Lease TTL answer (OQ-2):** 5 minutes (300 000 ms). Justification: typical `@kody` response time is 5–60 s, but under heavy BYOK queue contention a conversation could wait up to the `queueTimeoutMs` (60 s for the mitigation below) plus LLM time (~30 s) plus comment posting (~2 s). 5 min provides a 4× safety margin. The reaper reclaims leases whose TTL has passed — no zombie sandboxes.

**Concurrent `@kody` on same PR (OQ-5):** Both webhooks call `acquire(prKey, 'conversation')`. The lease manager's `findOneAndUpdate` upsert increments `leaseCount` to 2; both get back the same `sandboxId` and their own unique `leaseId`. Each calls `runConversationLoop` independently, each appends via `appendTurn` (atomic `$push`, both turns land). Each calls `release(leaseId)` in `finally` — count decrements twice. When it hits 0 the sandbox is paused. This is consistent with the Phase 1 design; verified by the concurrent-acquire test in `sandbox-lease-manager.spec.ts`.

### Pattern 3: `prKey` derivation — shared helper

**Finding:** There is no shared `buildPrKey` helper. The pattern `${organizationId}:${repositoryId}:${prNumber}` is copy-pasted in five places:
- `libs/platform/infrastructure/webhooks/github/githubPullRequest.handler.ts:256` and `:289`
- `libs/platform/infrastructure/webhooks/gitlab/gitlabPullRequest.handler.ts:322` and `:361`
- `libs/platform/infrastructure/webhooks/bitbucket/bitbucketPullRequest.handler.ts:268`
- `libs/platform/infrastructure/webhooks/azure/azureReposPullRequest.handler.ts:280` (named `sandboxPrKey`)
- `libs/platform/infrastructure/webhooks/forgejo/forgejoPullRequest.handler.ts:231`
- `libs/code-review/pipeline/stages/create-sandbox.stage.ts:89–91`

**Action (OQ-4):** Extract to `libs/sandbox/domain/contracts/sandbox-lease-manager.contract.ts` as a pure function:

```typescript
// Add to sandbox-lease-manager.contract.ts
export function buildPrKey(
    organizationId: string,
    repositoryId: string,
    prNumber: number | string,
): string {
    return `${organizationId}:${repositoryId}:${prNumber}`;
}
```

Phase 3 uses this. The pre-existing inline copies are left as-is (no refactor scope in this phase) — they produce the same string.

The `prKey` inputs are available in `handleConversationViaRuntime` via `prepareContext`:
- `prepareContext.pullRequest.pullRequestNumber` (set at `chatWithKodyFromGit.use-case.ts:471–476`)
- `prepareContext.repository.id` (set at line 479)
- `organizationAndTeamData.organizationId` (resolved at line 180–203)

### Pattern 4: Comment posting after `runConversationLoop` returns

**Finding:** `handleConversationFlow` does NOT call `handleConversation()` for comment posting. The comment posting logic is in `handleConversationFlow()` (lines 622–892) and receives `response` from `processCommand()` which calls `handleConversation()`. `handleConversation()` returns a plain `string`.

**Therefore:** No comment-posting code moves. `handleConversation()` still returns `string`. The existing comment-posting code in `handleConversationFlow()` (lines 799–891) remains unchanged — it posts whatever string `processCommand` returns, whether it came from the legacy path or the new one.

**Comment posting methods used (verified):**
- When `responsePolicy.usesReaction()` (GitHub): `codeManagementService.createResponseToComment()` at line 801
- When `responsePolicy.requiresAcknowledgment()` (GitLab/Azure): `codeManagementService.updateResponseToComment()` at line 857

Both are called with the same parameters regardless of which agent produced the reply text. No changes required here.

### Pattern 5: BYOK concurrency mitigation

**Characterization (OQ-5 / PERF-03):**

`limiterCache` is declared at module scope in `byok-to-vercel.ts:560`. It is a process-global `Map<string, BYOKConcurrencyLimiter>`. The cache key includes `organizationId + provider + apiKey + baseURL + model` (`byok-to-vercel.ts:588–595`). Review and conversation from the same org with the same BYOK provider share one `BYOKConcurrencyLimiter` instance.

The default `queueTimeoutMs` is `0` (`byok-to-vercel.ts:451`), meaning tasks wait forever in queue. A review job that holds the single slot for 10–20 minutes while doing multi-file analysis will block a conversation call indefinitely — the conversation webhook will hang and the GitHub/GitLab platform will time out the response.

**Mitigation chosen (OQ-5):** Pass `queueTimeoutMs: 60_000` (60 s) when `runConversationLoop` calls `runWithBYOKLimiter`. This is already plumbed into `runConversationLoop`'s `byokConfig` path via `agent-loop.ts:50–68`. The `throttledGenerateText` wrapper in `agent-loop.ts` accepts a `queueTimeoutMs` override. Adding it to `ConversationLoopInput` and threading it through is the required change.

When a conversation call times out waiting for the slot, `runWithBYOKLimiter` rejects with `[BYOK-QUEUE-TIMEOUT]` (see `byok-to-vercel.ts:521–528`). The `handleConversationViaRuntime` caller catches this (it is inside the `try/finally`) and must post a user-visible error message to the PR. Do NOT re-throw silently.

**Why not separate limiter pools:** The limiter is scoped by `{orgId}::{provider}::{apiKey}`. Review and conversation on the same org, same provider are intentionally sharing one limiter — the upstream API has one account-level concurrency quota. Creating a separate pool for conversation would allow conversation to bypass the quota, causing upstream 429 errors. The timeout approach respects the quota and fails fast.

### Pattern 6: Instrumentation for Phase 4 (OQ-6)

Phase 3 must emit enough metadata for Phase 4 to measure latency without Phase 3 doing the measurement itself. Add these fields to the log at lease acquire time in `handleConversationViaRuntime`:

```typescript
this.logger.log({
    message: 'Conversation sandbox lease acquired',
    context: 'ChatWithKodyFromGitUseCase',
    metadata: {
        prKey,
        sandboxState: sandbox.type === 'null'
            ? 'null'
            : (sandbox as any).wasCreated   // if leaseManager exposes this
              ? 'cold-create'
              : 'paused-resumed',           // or a value from AcquireResult
        sandboxId:    leaseId,
        byokProvider: byokConfig?.main?.provider ?? 'kodus-default',
        commandType:  'conversation',       // distinguish from 'review' in metrics
        organizationId: organizationAndTeamData.organizationId,
    },
});
```

**Note:** `AcquireResult` (Phase 1 contract) must expose a `wasCreated: boolean` or equivalent for Phase 4. If it does not yet, Phase 3 adds it — or Phase 4 adds it. Either is acceptable; the log field should be included in Phase 3 even if the value is `'unknown'` initially.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Running the conversation agent | Custom loop / copy of `runAgentLoop` inside the use case | `runConversationLoop` from `libs/conversation/infrastructure/services/conversation-loop.service.ts` | Already implements done-tool schema, NullSandbox detection, session persistence, CONVERSATION_DONE_SCHEMA |
| Feature flag evaluation | A second PostHog client, env-only toggle, or custom flag store | `posthog.isFeatureEnabled` + `FEATURE_FLAGS` registry in `libs/common/utils/posthog/index.ts` | Singleton with org group support; returns `true` when key absent (safe for self-hosted) |
| Posting the reply to PR | New comment-posting code | Existing `codeManagementService.createResponseToComment` / `updateResponseToComment` in `handleConversationFlow()` | Already handles all platforms (GitHub/GitLab/Azure/Bitbucket/Forgejo) and response policies |
| Sandbox lifecycle | Direct `ISandboxProvider` calls, custom create/pause/resume | `ISandboxLeaseManager.acquire / release` via `SANDBOX_LEASE_MANAGER_TOKEN` | Handles E2B pause/resume, Mongo coordination, TTL reaper, concurrent-acquire race — Phase 1 already tested |
| Thread persistence | Custom Mongo document or in-memory state | `ConversationSessionManager` via `CONVERSATION_SESSION_MANAGER_TOKEN` | Atomic `$push`, multi-turn history, token cap at 20 turns — Phase 2 already tested |
| Memory tools | Custom MCP calls or direct DB writes | `buildConversationMemoryTools(kodyRulesService, orgId, teamId)` | Handles create/update dedup, org-scoping, per-call context (no stale closure risk) |
| BYOK config fetch | Direct param service call or hardcoded provider | `PermissionValidationService.getBYOKConfig(organizationAndTeamData)` | Already handles EE entitlements, provider resolution, BYOK key decryption |
| Conversation logic inside `agent-loop.ts` | Modifying `runAgentLoop`'s body for conversation-specific behavior | Extension points already in place: `doneToolSchema`, `initialMessages`, `additionalTools`, `skipHeavyPasses`, `skipSynthesisRescue` | MAINT-02: `agent-loop.ts` must not know about conversation |
| Redis | Any cache/queue using Redis | None — Mongo only | Locked decision; `ConversationSessionManager` and `SandboxLeaseManager` are Mongo-backed |

---

## Common Pitfalls

### Pitfall 1: Lease leak when `runConversationLoop` throws

**What goes wrong:** An unhandled rejection from `runConversationLoop` (e.g. model timeout, E2B network error, BYOK-QUEUE-TIMEOUT) exits `handleConversationViaRuntime` without calling `release(leaseId)`. The sandbox stays in "acquired" state until the TTL reaper fires (default TTL 5 min). During that window no other conversation invocation can reuse the sandbox — a cold-create is triggered instead, defeating PERF-02.

**How to avoid:** `try/finally` is mandatory. `release(leaseId)` MUST be in the `finally` block, not the `catch` block. The `finally` always runs, even if the inner `try` re-throws.

**Verification:** Test that after `runConversationLoop` throws, `leaseManager.release` is still called. Mock `runConversationLoop` to throw, assert `release` mock was called.

### Pitfall 2: Concurrent `@kody` race — release-after-first

**What goes wrong:** Two webhooks arrive simultaneously. Both call `acquire(prKey, 'conversation')` — lease count becomes 2. The first finishes and calls `release(leaseId1)` — count drops to 1. The second then calls `release(leaseId2)` — count drops to 0, sandbox pauses. This is the CORRECT behavior. The incorrect version is if `release` decremented count by more than 1, or if the first release paused the sandbox while the second was still mid-LLM.

**How to avoid:** `SandboxLeaseManager.release` must decrement by 1 per `leaseId`, not set to 0. Phase 1 tests cover this. Phase 3 adds a characterization test: two concurrent `handleConversationViaRuntime` invocations on the same `prKey` — assert sandbox is not paused until BOTH finish.

**Warning signs:** If sandbox cold-creates on every `@kody` comment (PERF-02 regression), the lease count is not incrementing correctly.

### Pitfall 3: Flag check inside the loop, not at entry

**What goes wrong:** If the flag is checked repeatedly during a multi-step agent run (e.g. per tool call), flipping it mid-conversation aborts the current turn inconsistently — some steps ran on the new runtime, some on legacy.

**How to avoid:** The flag check happens ONCE, at the top of `handleConversation()`, before any agent work starts. The result is stored in a local `useNewRuntime` boolean. The rest of the method uses only that boolean. A flag flip affects the NEXT webhook invocation only.

**Verification:** Integration test that flips the mock flag between two invocations; assert each invocation used the path that was active at the start of that invocation.

### Pitfall 4: Memory creation regression under flag-on

**What goes wrong:** The new path uses `buildConversationMemoryTools` (native AI SDK tools). The legacy path uses `kodus-flow`'s MCP memory tool (`KODUS_CREATE_MEMORY` via MCP). If the native tool silently fails (wrong org context, missing `kodyRulesService` injection), `@kody remember "X"` under flag-on produces no confirmation and no memory is stored.

**How to avoid:**
1. `buildConversationMemoryTools` must receive a non-null `kodyRulesService`. Phase 3 must inject `IKodyRulesService` (via `KODY_RULES_SERVICE_TOKEN`) into `ChatWithKodyFromGitUseCase` if it's not already there.
2. The integration test (TEST-03 from Phase 2) must be confirmed to pass in the Phase 3 wiring context.
3. Smoke test: flag-on + `@kody remember "prefer ES modules"` → PR reply includes confirmation link.

### Pitfall 5: BYOK infinite queue block (PERF-03)

**What goes wrong:** Org uses Z.AI (or any BYOK provider with `maxConcurrentRequests: 1`). Review occupies the one slot for 15 min. A `@kody` comment arrives. `runConversationLoop` → `throttledGenerateText` → `runWithBYOKLimiter` → waits forever. Platform webhook times out. User sees no response.

**How to avoid:** Pass `queueTimeoutMs: 60_000` to `runConversationLoop` input, thread it through `AgentLoopInput` to `throttledGenerateText`. When the timeout fires, catch `[BYOK-QUEUE-TIMEOUT]` error in `handleConversationViaRuntime` and return a user-visible apology string (posted to PR via the existing posting flow). The `finally` block still releases the lease — no leak.

**Warning signs:** `[BYOK-QUEUE-TIMEOUT]` appearing in logs when a review is running concurrently.

### Pitfall 6: Module wiring — `SandboxModule` and `ConversationModule` not imported into `PlatformModule`

**What goes wrong:** `ChatWithKodyFromGitUseCase` tries to inject `SANDBOX_LEASE_MANAGER_TOKEN` or `CONVERSATION_SESSION_MANAGER_TOKEN` but neither `SandboxModule` nor `ConversationModule` is in `PlatformModule`'s imports. NestJS throws `Nest can't resolve dependencies of ChatWithKodyFromGitUseCase` at startup.

**How to avoid:** Add `SandboxModule` and `ConversationModule` to `PlatformModule`'s imports array (`libs/platform/modules/platform.module.ts:39–63`). Also add `PermissionsModule` if `PermissionValidationService` is not already reachable (it is — `PermissionsModule` is already in PlatformModule at line 55).

**Verification:** `pnpm build` or a module test that instantiates `PlatformModule`.

### Pitfall 7: Wrong comment-posting method under flag-on (cross-platform)

**What goes wrong:** The new `handleConversationViaRuntime` accidentally calls `codeManagementService.createIssueComment` (PR-level, no thread context) instead of `codeManagementService.createResponseToComment` (inline thread reply). On GitHub inline comments, the reply appears as a new top-level PR comment instead of a reply in the thread.

**How to avoid:** `handleConversationViaRuntime` does NOT call any `codeManagementService` method. It only returns a `string`. The existing `handleConversationFlow` code at lines 799–891 does all posting — it calls the right method based on `responsePolicy` and platform. Since `handleConversation()` still returns `string`, the posting code is untouched.

### Pitfall 8: Rollback breaks in-flight conversation threads

**What goes wrong:** Flag flips off. Operator expects legacy path. But `conversation_threads` docs in Mongo exist from prior flag-on sessions. When flag flips back on, prior thread history is materialized — unexpected. Or conversely, some state written by the new path breaks the legacy path.

**How to avoid:** The legacy path (`ConversationAgentProvider`) does not read from `conversation_threads` collection — it uses `@kodus/flow`'s own thread persistence. The new path reads and writes `conversation_threads`. There is no shared state. Flipping the flag off stops new path calls; existing `conversation_threads` docs accumulate harmlessly. When flag flips back on, the history is picked up exactly where it left off. This is the desired "graceful resume" behavior.

**Verification:** Test that flips flag off, sends a `@kody` (goes legacy), flips flag on, sends another `@kody` — assert the second invocation sees the pre-flag-off history in `conversation_threads` (which has the turns from the flag-on period before the flip) but NOT the flag-off turn (which was handled by legacy path and stored only in `kodus-flow` thread storage).

---

## Code Examples

### The dispatch seam — where the if-branch goes

```typescript
// libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case.ts
// Lines 1810–1823 (current state — the entire legacy method)

private async handleConversation(context: {
    prepareContext: any;
    organizationAndTeamData: OrganizationAndTeamData;
    thread: any;
}): Promise<string> {
    const { prepareContext, organizationAndTeamData, thread } = context;

    return await this.conversationAgentUseCase.execute({  // ← replace this with flag check
        prompt: prepareContext.userQuestion,
        organizationAndTeamData,
        prepareContext: prepareContext,
        thread: thread,
    });
}
```

`handleConversation` is called from `processCommand()` at line 1796 (case `CommandType.CONVERSATION`) and line 1798 (default). `processCommand` is called from `handleConversationFlow()` at line 780. The flag-dispatched string flows back through `processCommand` → `handleConversationFlow` → existing comment-posting at lines 799–891. No other code needs to change to route the reply.

### The `agentReview` flag template (lines 58–96 of the template file)

```typescript
// libs/core/providers/code-review-pipeline.provider.ee.ts:58–96

let useAgentPipeline = false;

// Self-hosted override: bypasses PostHog entirely
const envOverride = process.env.API_AGENT_REVIEW_ENABLED?.toLowerCase();
if (envOverride === 'true' || envOverride === '1') {
    useAgentPipeline = true;
} else if (posthog.isInitialized) {
    const flagResult = await posthog.isFeatureEnabled(
        FEATURE_FLAGS.agentReview,
        featureIdentifier,          // organizationId
        context.organizationAndTeamData,
        repositoryId,               // optional per-repo granularity
    );
    useAgentPipeline = flagResult === true;
}

const strategy = useAgentPipeline ? agentStrategy : eeStrategy;
```

Phase 3 follows this pattern exactly, substituting `FEATURE_FLAGS.conversationAgentRuntime` and `API_CONVERSATION_RUNTIME_ENABLED`.

### The legacy comment-posting calls (reused unchanged)

```typescript
// libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case.ts
// Lines 800–864 — both posting branches, both unchanged in Phase 3

if (responsePolicy.usesReaction()) {
    await this.codeManagementService.createResponseToComment({
        organizationAndTeamData,
        inReplyToId: comment.id,
        discussionId: params.payload?.object_attributes?.discussion_id,
        threadId: comment.threadId,
        body: response,   // ← whatever string handleConversation() returned
        repository,
        prNumber: pullRequestNumber,
    });
    // ... reaction cleanup ...
} else if (responsePolicy.requiresAcknowledgment()) {
    await this.codeManagementService.updateResponseToComment({
        organizationAndTeamData,
        parentId,
        commentId: ackResponseId,
        body: response,   // ← same
        prNumber: pullRequestNumber,
        repository,
    });
}
```

### The acquire/release pattern from Phase 1

```typescript
// libs/code-review/pipeline/stages/create-sandbox.stage.ts:88–128

const prKey = `${orgId}:${repoId}:${prNumber}`;   // use buildPrKey() in Phase 3

const { sandbox, leaseId } = await this.leaseManager.acquire(prKey, 'review');

sandbox.cleanup = async () => {                    // review overrides cleanup
    await this.leaseManager.release(leaseId);     // conversation: use try/finally instead
};
```

For conversation, the `try/finally` form is used directly — no `sandbox.cleanup` override needed because there is no observer that calls `cleanup()` externally.

### BYOK queue timeout threading

```typescript
// libs/code-review/infrastructure/agents/llm/byok-to-vercel.ts:605–628

export function runWithBYOKLimiter<T>(
    params: {
        byokConfig?: BYOKConfig;
        organizationId?: string;
        role?: BYOKLimiterRole;
        queueTimeoutMs?: number;    // ← conversation passes 60_000 here
        abortSignal?: AbortSignal;
    },
    fn: () => Promise<T>,
    label = 'llm-call',
): Promise<T> {
    // ...
    const queueTimeoutMs = params.queueTimeoutMs ?? DEFAULT_LIMITER_QUEUE_TIMEOUT_MS; // default 0
    // ...
}
```

Phase 3 adds `byokQueueTimeoutMs?: number` to `ConversationLoopInput` and threads it through to `runAgentLoop` → `throttledGenerateText` → `runWithBYOKLimiter`.

---

## Open Questions — Resolved

**OQ-1: Flag name + granularity**
Flag name: `conversationAgentRuntime` (snake_case in PostHog: `conversation-agent-runtime`). Add to `FEATURE_FLAGS` registry as `conversationAgentRuntime: 'conversation-agent-runtime'`. Granularity: org-level with optional per-repo, matching `agentReview`. Env override: `API_CONVERSATION_RUNTIME_ENABLED`.

**OQ-2: Lease TTL for conversation**
5 minutes (300 000 ms). Covers: 60 s BYOK queue wait + 30 s LLM time + 10 s sandbox resume + 2 s comment post = 102 s worst case, with 3× safety margin. Review TTL is longer (minutes to hours) — conversation TTL is intentionally shorter.

**OQ-3: Comment posting after loop**
No change needed. `handleConversation()` returns `string`. The existing posting code in `handleConversationFlow()` (lines 799–891) is unchanged and handles all platforms correctly.

**OQ-4: `prKey` builder**
Extract `buildPrKey(orgId, repoId, prNumber)` to `libs/sandbox/domain/contracts/sandbox-lease-manager.contract.ts`. The function produces `${orgId}:${repoId}:${prNumber}`, matching all existing inline copies. The `prNumber` is available as `prepareContext.pullRequest.pullRequestNumber` inside `handleConversation`.

**OQ-5: BYOK contention mitigation**
Pass `queueTimeoutMs: 60_000` into `runConversationLoop`. Catch `[BYOK-QUEUE-TIMEOUT]` rejection; return a user-visible error string. Do NOT use separate limiter pools.

**OQ-6: Instrumentation for Phase 4**
Emit `sandboxState: 'cold-create' | 'paused-resumed' | 'null'`, `byokProvider`, `commandType: 'conversation'`, `organizationId` in the log at lease acquire time. Requires `AcquireResult` to expose `wasCreated: boolean` — add this field to the contract if Phase 1 did not include it.

**OQ-7: Error handling when `runConversationLoop` throws**
Catch inside `handleConversationViaRuntime`. Map known error types to user-visible messages:
- `[BYOK-QUEUE-TIMEOUT]`: "Kody is processing another request for this repo — please try again in a moment."
- `[BYOK-QUEUE-ABORTED]`: same.
- All other errors: "Kody encountered an error processing your request. Please try again." Log the full error.
Do NOT re-throw — the caller posts whatever string this method returns. If this method throws, `processCommand` propagates up to `handleConversationFlow` which catches at line 878 and logs but does not post to the PR (the ack comment is left as "Analyzing your request..." with no follow-up). Return an error string instead.

**OQ-8: Rollback safety**
Confirmed. The legacy path (`ConversationAgentProvider`) and the new path write to different storage (`@kodus/flow` internal thread vs `conversation_threads` Mongo collection). Flipping the flag off stops new-path calls; no state corruption. Flipping back on resumes from `conversation_threads` history.

**OQ-9: Fallback path implementation**
The if-branch is in `handleConversation()`. When `useNewRuntime` is false, the existing `conversationAgentUseCase.execute()` call runs as-is. No changes to `ConversationAgentUseCase`, `ConversationAgentProvider`, or any other legacy path code.

**OQ-10: Test scope**
Three required tests:
1. **Dispatch integration test**: mock PostHog flag on/off; assert `runConversationLoop` called when on, `conversationAgentUseCase.execute` called when off.
2. **Lease lifecycle smoke test**: flag on; simulate `runConversationLoop` throwing; assert `leaseManager.release` was called (try/finally discipline).
3. **BYOK characterization test**: mock `maxConcurrentRequests: 1`; start review (holds slot); start conversation; assert conversation rejects within `queueTimeoutMs + buffer` with `[BYOK-QUEUE-TIMEOUT]`; assert lease released.

---

## State of the Art

| Old Approach | Current Approach (Phase 3 target) | Impact |
|--------------|-----------------------------------|--------|
| `@kody` always routed through `ConversationAgentProvider` (MCP + `@kodus/flow`) | Feature-flag dispatch: flag-on → `runConversationLoop` (sandbox + native tools), flag-off → legacy | Real codebase access for `@kody` questions; instant rollback |
| Stateless per-request conversation (no cross-turn memory) | `ConversationSessionManager` materializes `initialMessages` from Mongo | True multi-turn context across PR comments |
| No sandbox for `@kody` | `SandboxLeaseManager.acquire('conversation')` per webhook | `grep`, `readFile`, `findFile` available in conversation replies |
| BYOK limiter: no timeout for conversation | `queueTimeoutMs: 60_000` passed from conversation path | Conversation fails fast instead of blocking forever behind review |

---

## Requirements Coverage

| Requirement | Implementation home in Phase 3 |
|-------------|--------------------------------|
| CONV-01 | `handleConversationViaRuntime` calls `runConversationLoop` (which calls `runAgentLoop`) |
| CONV-04 | `runConversationLoop` receives `sandbox` from lease manager; `buildAgentTools` exposes grep/read/find tools |
| CONV-05 | `runConversationLoop` calls `sessionManager.materializeInitialMessages(prKey)` — prior turns in `initialMessages` |
| RLLT-01 | `conversationAgentRuntime` flag in `FEATURE_FLAGS`; org-level minimum, per-repo available |
| RLLT-02 | Flag checked per webhook invocation at top of `handleConversation()`; flag off → legacy path immediately |
| PERF-02 | `leaseManager.acquire(prKey, 'conversation')` returns paused sandbox on 2nd+ invocation; `sandboxState` label emitted for Phase 4 measurement |
| PERF-03 | `queueTimeoutMs: 60_000` passed to conversation path; characterized via test |

---

## Sources

### Primary (HIGH confidence — verified in working tree source files)

- `libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case.ts` — full file; dispatch seam at lines 1782–1823, posting at 799–891, entry at 162–270
- `libs/core/providers/code-review-pipeline.provider.ee.ts` — full file; `agentReview` flag pattern at lines 58–96
- `libs/common/utils/posthog/index.ts` — full file; `FEATURE_FLAGS` registry, `isFeatureEnabled` signature
- `libs/code-review/pipeline/stages/create-sandbox.stage.ts` — full file; `acquire/release` lifecycle template
- `libs/code-review/infrastructure/observers/code-review-pipeline.observer.ts` — lines 47–58; sandbox cleanup via observer
- `libs/code-review/infrastructure/agents/llm/byok-to-vercel.ts` — lines 435–642; `BYOKConcurrencyLimiter`, `limiterCache` (module-level singleton), `runWithBYOKLimiter`, `queueTimeoutMs` behavior
- `libs/code-review/infrastructure/agents/llm/agent-loop.ts` — lines 40–68; `throttledGenerateText` wrapping `runWithBYOKLimiter`
- `libs/conversation/infrastructure/services/conversation-loop.service.ts` — full file; `ConversationLoopInput`, NullSandbox detection, session persistence
- `libs/conversation/infrastructure/services/conversation-session-manager.service.ts` — full file; `appendTurn` atomic `$push`, `materializeInitialMessages`
- `libs/conversation/infrastructure/services/conversation-tools.factory.ts` — full file; `buildConversationMemoryTools`
- `libs/conversation/modules/conversation.module.ts` — full file; `CONVERSATION_SESSION_MANAGER_TOKEN` export
- `libs/sandbox/domain/contracts/sandbox-lease-manager.contract.ts` — full file; `ISandboxLeaseManager`, `AcquireResult`
- `libs/sandbox/modules/sandbox.module.ts` — full file; `SANDBOX_LEASE_MANAGER_TOKEN` export
- `libs/platform/modules/platform.module.ts` — full file; current imports list (shows `SandboxModule` and `ConversationModule` are absent)
- `libs/agents/application/use-cases/conversation-agent.use-case.ts` — full file; legacy path entry point
- `libs/agents/infrastructure/services/kodus-flow/conversationAgent.ts` — full file; `ConversationAgentProvider.execute`
- All five webhook handler files — `prKey` inline pattern confirmed at `github:256,289`, `gitlab:322,361`, `bitbucket:268`, `azure:280`, `forgejo:231`

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all symbols read directly from source
- Architecture patterns: HIGH — seam locations confirmed with line numbers
- BYOK contention: HIGH — `limiterCache` module-scope confirmed, `DEFAULT_LIMITER_QUEUE_TIMEOUT_MS = 0` confirmed
- Pitfalls: HIGH — all derived from code structure, not heuristics
- Module wiring: HIGH — `PlatformModule` imports list read directly; `SandboxModule` and `ConversationModule` confirmed absent

**Research date:** 2026-05-04
**Valid until:** 2026-06-04 (stable codebase; re-verify if Phase 1 or Phase 2 contracts change)
