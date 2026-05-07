---
phase: 02-conversation-primitives
verified: 2026-05-04T20:16:08Z
status: passed
score: 5/5 success criteria verified
re_verification: false
---

# Phase 2: Conversation Primitives — Verification Report

**Phase Goal:** All conversation-specific infrastructure exists and is tested in isolation — `runConversationLoop` wrapper, Mongo thread-state persistence via `ConversationSessionManager`, and a documented MCP-vs-native tool reconciliation decision — but no live `@kody` traffic is routed through it yet.
**Verified:** 2026-05-04T20:16:08Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths (Success Criteria)

| #   | Truth                                                                 | Status     | Evidence                                                                 |
| --- | --------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------ |
| 1   | `runConversationLoop` returns `{ reply, steps, toolCalls }`, not `CodeSuggestion[]` | ✓ VERIFIED | Interface declares `reply: string`; JSDoc explicitly says "never CodeSuggestion[]"; no `CodeSuggestion` type imported or returned |
| 2   | `ConversationSessionManager` persists/reloads thread across two invocations | ✓ VERIFIED | `appendTurn` delegates to repo `$push` upsert; `materializeInitialMessages` loads + slices; SC-2 test asserts second call sees first turn |
| 3   | Memory creation via Option A adapter — same observable output as legacy MCP | ✓ VERIFIED | `buildConversationMemoryTools` registered both `KODUS_CREATE_MEMORY` and `KODUS_FIND_MEMORIES`; direct `IKodyRulesService` injection; regression tests cover explicit, implicit, duplicate, pending-approval |
| 4   | NullSandbox path completes without throwing, returns text reply       | ✓ VERIFIED | `sandbox.type === 'null'` → `remoteCommands = undefined` → `isSelfContained=true` → text fallback; SC-4 test covers both no-throw and no-grep-tools assertions |
| 5   | No review-side files gain conversation-specific branches              | ✓ VERIFIED | Zero conversation imports in `libs/code-review/`; `additionalTools` field in `agent-loop.ts` is generic (JSDoc: "For non-review callers only"); `pipeline/stages/` has zero `additionalTools` references |

**Score:** 5/5 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `libs/conversation/infrastructure/services/conversation-loop.service.ts` | `runConversationLoop` wrapper | ✓ VERIFIED | 165 lines; substantive implementation; imports and calls `runAgentLoop`; wired via import in test |
| `libs/conversation/infrastructure/services/conversation-session-manager.service.ts` | `ConversationSessionManager` with `appendTurn` + `materializeInitialMessages` | ✓ VERIFIED | Both methods present; truncation at `MAX_HISTORY_TURNS = 20` with `slice(-20)` |
| `libs/conversation/infrastructure/services/conversation-tools.factory.ts` | `buildConversationMemoryTools` with both tool registrations | ✓ VERIFIED | Both `KODUS_CREATE_MEMORY` and `KODUS_FIND_MEMORIES` registered with real `execute` closures |
| `libs/conversation/domain/contracts/conversation-session-manager.contract.ts` | `IConversationSessionManager` interface + `ConversationTurn` type | ✓ VERIFIED | All three methods declared; `ConversationTurn` shape matches usage in service and tests |
| `libs/conversation/infrastructure/repositories/conversation-thread.repository.ts` | Mongo repository with `findByPrKey` + `appendTurn` | ✓ VERIFIED | Atomic `$push` upsert; `$setOnInsert` for `createdAt` |
| `libs/conversation/infrastructure/repositories/schemas/conversation-thread.model.ts` | Mongoose schema for `conversation_threads` | ✓ VERIFIED | TTL index on `updatedAt` (90 days); `_id` = `prKey` |
| `libs/conversation/modules/conversation.module.ts` | NestJS module wiring repo + session manager | ✓ VERIFIED | Exports `ConversationThreadRepository` and `CONVERSATION_SESSION_MANAGER_TOKEN` |
| `test/unit/conversation/run-conversation-loop.spec.ts` | TEST-02 end-to-end tests | ✓ VERIFIED | 23 `expect()` calls; covers SC-1 (happy path + history seeding + tool-call sequencing), SC-2 (cross-invocation), SC-4 (NullSandbox), SC-5 (MAINT-02 static grep) |
| `test/unit/conversation/memory-regression.spec.ts` | TEST-03 memory regression tests | ✓ VERIFIED | 17 `expect()` calls; covers explicit, implicit (org binding), duplicate (`action:skipped`), pending approval (`requiresApproval:true`), `findMemories` |
| `libs/conversation/infrastructure/services/conversation-loop.spec.ts` | Co-located spec (19 expects) | ✓ VERIFIED | Additional unit coverage alongside the primary TEST-02 spec |
| `libs/conversation/infrastructure/services/conversation-session-manager.spec.ts` | Co-located spec (14 expects) | ✓ VERIFIED | Covers load empty, appendTurn delegation, materialize single turn, truncation to 20, warn log on truncation |
| `libs/conversation/infrastructure/services/conversation-tools.factory.spec.ts` | Co-located spec (6 expects) | ✓ VERIFIED | Basic factory coverage |

---

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `conversation-loop.service.ts` | `runAgentLoop` | `import { runAgentLoop } from '@libs/code-review/infrastructure/agents/llm/agent-loop'` | ✓ WIRED | Direct import + call at line 100 |
| `conversation-loop.service.ts` | `IConversationSessionManager` | `sessionManager.materializeInitialMessages` + `sessionManager.appendTurn` | ✓ WIRED | Both called inside `runConversationLoop`; turns persisted before returning |
| `agent-loop.ts` | `additionalTools` | `...( input.additionalTools ?? {})` spread into tools dict at line 902 | ✓ WIRED | Generic spread; no conversation-specific branch; wires into `isSelfContained` detection |
| `buildConversationMemoryTools` | `IKodyRulesService` | Parameter injection; `kodyRulesService.createOrUpdateMemory` + `kodyRulesService.findMemories` | ✓ WIRED | Direct calls inside `execute` closures; no MCP gateway |
| `ConversationModule` | `ConversationSessionManager` | `provide: CONVERSATION_SESSION_MANAGER_TOKEN, useClass: ConversationSessionManager` | ✓ WIRED | Exported via token for caller injection |
| `ConversationSessionManager` | `ConversationThreadRepository` | Constructor injection + `repository.appendTurn` / `repository.findByPrKey` | ✓ WIRED | All calls delegated to repository |

---

### Requirements Coverage

| Requirement | Text Summary | Status | Blocking Issue |
| ----------- | ------------ | ------ | -------------- |
| CONV-02 | `runConversationLoop` wrapper with text output, not `CodeSuggestion[]` | ✓ SATISFIED | — |
| CONV-03 | Memory creation observable behavior preserved via Option A adapter | ✓ SATISFIED | — |
| STATE-01 | Thread messages persisted in MongoDB (`conversation_threads` collection) | ✓ SATISFIED | — |
| STATE-02 | `ConversationSessionManager` loads thread, materializes `initialMessages`, persists new turn | ✓ SATISFIED | — |
| MAINT-01 | No parallel `runAgentLoop` variant — conversation imports and calls the existing one | ✓ SATISFIED | — |
| MAINT-02 | Conversation code in conversation-specific files only; zero review-side branches | ✓ SATISFIED | — |
| TEST-02 | `runConversationLoop` end-to-end tests with mock LLM + RemoteCommands, history + tool-call assertions | ✓ SATISFIED | — |
| TEST-03 | Memory regression tests: explicit, implicit, duplicate detection, MCP-vs-native decision | ✓ SATISFIED | — |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| `conversation-thread.repository.ts` | 27 | `TODO(Phase4): add redaction step before appendTurn` | ℹ Info | Acknowledged future work; does not affect Phase 2 goal |
| `conversation-session-manager.contract.ts` | 31 | `TODO(Phase4): add redaction step before appendTurn` | ℹ Info | Same planned future work; not a blocker |

No blockers or warnings found. The two TODO comments reference Phase 4 observability work, are in JSDoc, and are intentional placeholders for a future phase.

---

### Human Verification Required

None. All five success criteria are fully verifiable from static analysis and unit test structure. No visual rendering, real-time behavior, or external service integration is present in this phase's deliverables — the phase explicitly states "no live `@kody` traffic is routed through it yet."

---

## Verification Detail by Success Criterion

### SC-1: `runConversationLoop` returns text reply, not `CodeSuggestion[]`

- `ConversationLoopOutput.reply: string` — interface declares return shape correctly.
- `CodeSuggestion` appears once in the file (line 44) inside a JSDoc comment (`/** Plain text reply from the agent — never CodeSuggestion[]. */`) — zero actual type imports or usages.
- `CONVERSATION_DONE_SCHEMA = z.object({ reply: z.string() })` overrides the default `_findingsSchema` via `doneToolSchema`.
- `output.findings?.reply ?? output.text ?? ''` extracts the string reply.
- `(result as any).suggestions` is `undefined` — test at line 174 asserts this explicitly.
- Test expect count: 23 across SC-1, SC-2, SC-4, SC-5 in the primary spec; additional 19 in co-located spec.

### SC-2: `ConversationSessionManager` cross-invocation persistence

- `appendTurn` calls `this.repository.appendTurn` (MongoDB `$push` upsert — atomic, concurrent-safe).
- `materializeInitialMessages` calls `this.load` → `repository.findByPrKey` → maps turns to `ModelMessage[]`.
- SC-2 test (`run-conversation-loop.spec.ts:301`) simulates two sequential invocations via in-process store: first call's `appendTurn` pushes to `store[]`, second call's `materializeInitialMessages` returns that store; asserts second `generateText` call receives `'First reply'` in its messages array.
- `conversation-session-manager.spec.ts` covers truncation (30 turns → 20 kept, most recent) and warn log.

### SC-3: Memory creation Option A adapter

- `buildConversationMemoryTools` is a plain function (not NestJS service), receives `IKodyRulesService | null | undefined` directly.
- Returns `{}` when service absent (self-hosted fallback) — no MCP gateway involved.
- `KODUS_CREATE_MEMORY.execute` calls `kodyRulesService.createOrUpdateMemory` with correct `organizationId` bound at factory call time (Pitfall 3 prevention).
- `KODUS_FIND_MEMORIES.execute` calls `kodyRulesService.findMemories` with org binding.
- `memory-regression.spec.ts` covers: explicit (`action:created`), implicit (org binding assertion), duplicate (`action:skipped`), pending approval (`requiresApproval:true`), `findMemories` array passthrough.

### SC-4: NullSandbox path

- `input.sandbox.type === 'null'` → `remoteCommands = undefined` (line 80–82).
- `undefined` remoteCommands → `buildAgentTools` returns `{}` → `isSelfContained=true` in `runAgentLoop`.
- Self-contained mode: single LLM step, `output.text` used directly, no `submitResult` done-tool call.
- `conversation-loop.service.ts` falls back: `output.findings?.reply ?? output.text ?? ''`.
- SC-4 tests assert: no throw, non-empty reply, `tools` dict lacks `grep` and `readFile`.

### SC-5: MAINT-02 — no conversation branches in review-side files

- `grep -rn "from '@libs/conversation'" libs/code-review/` → zero matches.
- `grep -rn "additionalTools" libs/code-review/pipeline/stages/` → zero matches.
- `grep -rn "additionalTools" libs/code-review/infrastructure/agents/llm/agent-tools.factory.ts` → zero matches.
- `grep -rn "additionalTools" libs/code-review/infrastructure/agents/base-code-review-agent.provider.ts` → zero matches.
- `additionalTools` in `agent-loop.ts` is at lines 762 (field declaration) and 902 (spread) — both generic, with JSDoc explicitly restricting to "non-review callers only".
- SC-5 test in the spec (`run-conversation-loop.spec.ts:379`) runs `execSync` grep against pipeline stages directory and asserts empty output.

---

_Verified: 2026-05-04T20:16:08Z_
_Verifier: Claude (gsd-verifier)_
