# Kodus AI

## What This Is

Kodus AI is an AI-powered code review platform that runs automated reviews on pull requests across GitHub, GitLab, Bitbucket, Azure DevOps, and Forgejo. Beyond reviews, it exposes a conversational layer where developers interact with "Kody" via `@kody` mentions in PR comments to ask questions, request explanations, and persist team conventions as memories.

## Core Value

Every interaction with Kody — review or conversation — should have the same depth of context and reasoning as a senior engineer pair-reviewing the PR alongside the user.

## Requirements

### Validated

<!-- Existing capabilities inferred from `.planning/codebase/`. Locked unless explicit re-discussion. -->

- ✓ Code review pipeline running through the **agent runtime** in `libs/code-review/infrastructure/agents/llm/agent-loop.ts` — REACT loop with E2B sandbox, native AI SDK tools (`grep`, `readFile`, `listDir`, `findFile`, `checkTypes`, `readReference`, `searchDocs`), eager per-PR sandbox lifecycle, multi-agent orchestrator (`bug`, `security`, `performance`, `generalist`, `kody-rules`)
- ✓ Multi-provider Git platform support (GitHub, GitLab, Bitbucket, Azure DevOps, Forgejo) — existing
- ✓ `@kody` PR-comment conversational layer via `ChatWithKodyFromGitUseCase` running through `ConversationAgentProvider` — a separate, lighter agent runtime that uses **MCP tools only** (no native code-navigation tools, no sandbox, no cross-file access)
- ✓ Memory creation via `@kody remember ...` (explicit and implicit), implemented as MCP tools `KODUS_FIND_MEMORIES` / `KODUS_CREATE_MEMORY` — existing
- ✓ Kody Rules system (file-level and PR-level rules) with directory/repo/global scopes — existing
- ✓ Multi-LLM provider support with BYOK (OpenAI, Anthropic, Google, Azure, Bedrock) — existing
- ✓ Self-hosted + Cloud deployment modes with `API_CLOUD_MODE` gating — existing
- ✓ E2B sandbox SDK (`e2b@2.19.2`) integrated with `Sandbox.create/connect/kill`, `lifecycle.onTimeout`, `setTimeout`, metadata tagging — but currently used only by review pipeline with eager-create + eager-kill semantics

### Active

<!-- First GSD milestone — plug conversation into the review agent runtime, with sandbox layer reorganized as a shared capability. -->

- [ ] Extract sandbox capability into a standalone `libs/sandbox/` module owned by a new `SandboxLeaseManager`, so review and conversation share one lifecycle layer and future surfaces (web chat, CLI) inherit it for free
- [ ] Adopt E2B's pause/resume lifecycle (`onTimeout: 'pause'`, `autoResume: true`) so a sandbox stays cheap-but-warm between consumers; idle timeout pauses, next acquire resumes in ~1–3s instead of cold-starting in 15–30s
- [ ] Plug `@kody` PR conversation into the **review agent runtime** (`runAgentLoop`) so a conversational reply has access to grep, readFile, type-check, cross-file refs, doc search inside the sandbox
- [ ] Reuse the runtime without forking — extract minimal extension points (`doneToolSchema`, `initialMessages`) that benefit both review and conversation
- [ ] Reconcile MCP tools (memory creation) with the runtime's native tools — research-driven decision (adapter, separate-call, or routing layer); memory flow must not regress
- [ ] Persist multi-turn thread state in MongoDB so a follow-up `@kody` sees the prior exchange
- [ ] Ship the migration behind a feature flag with instant fallback to the legacy path
- [ ] Document latency impact and decide UX path (sync if measured p95 within budget, async-with-status-update otherwise)

### Out of Scope

- Migration of the dedicated code review pipeline — already runs on this runtime
- Conversational surfaces outside PR comments (web chat UI, CLI conversation) — separate milestone after PR-comment path is stable
- New conversation features (slash commands, multi-turn re-asking, file diffing across messages) — defer to v2
- Replacing `@kodus/flow` with another agent runtime — out of scope; we plug into existing
- Replacing E2B with another sandbox provider — out of scope; `ISandboxProvider` keeps the abstraction clean for future swap
- Sandbox warm pool (pre-allocated sandboxes with repos pre-cloned) — v2 if E2B pause/resume isn't fast enough in practice
- Cross-PR thread persistence ("remember this conversation when reviewing PR #150 next month") — v2

## Context

- The codebase has been mapped in `.planning/codebase/` (8 docs: STACK, ARCHITECTURE, STRUCTURE, CONVENTIONS, TESTING, INTEGRATIONS, CONCERNS, plus the runtime-deep map at REVIEW-AGENT-RUNTIME.md). Phase research will read these instead of re-discovering.
- **Two distinct agent runtimes exist today**:
  - `libs/agents/infrastructure/services/kodus-flow/conversationAgent.ts` — single REACT agent + MCP tools. Powers `@kody` conversations. Lightweight, no sandbox.
  - `libs/code-review/infrastructure/agents/llm/agent-loop.ts` — REACT loop + native AI SDK tools + E2B sandbox + multi-agent orchestrator. Powers code review.
  This milestone migrates conversation to the second runtime.
- The sandbox today is a property of the review pipeline (`CreateSandboxStage` provisions, `CodeReviewPipelineObserver.onPipelineFinish` kills). This milestone reframes it as a **shared capability**: one lifecycle layer (`SandboxLeaseManager`) with multiple consumers (review, conversation, future surfaces).
- The E2B SDK supports lifecycle features we are not using yet:
  - `Sandbox.connect(sandboxId)` — connects from any process; auto-resumes if paused.
  - `lifecycle: { onTimeout: 'pause', autoResume: true }` — sandbox pauses on timeout instead of dying.
  - `setTimeout(ms)` — extends or shortens lifetime dynamically.
  - `Sandbox.list()` with metadata filter — query existing sandboxes by `{org}:{repo}:{pr}`.
  These collapse most of the lifecycle bookkeeping we'd otherwise rebuild ourselves.
- `runAgentLoop` is **already a generic seam**: signature `AgentLoopInput → AgentLoopOutput` is consumer-agnostic. Only review-coupling is the hardcoded `_findingsSchema` for the done-tool. Parameterizing it is a ~20-line change.
- `runAgentLoop` is **stateless** — each call starts fresh. Conversation needs multi-turn — needs `initialMessages` injection plus a session persistence layer.
- MCP tools (used today by conversation, including memory) and the runtime's native tools are two separate registries. Reconciliation is a research decision.
- Tracking issue: [kodustech/kodus-ai#1025](https://github.com/kodustech/kodus-ai/issues/1025).

## Constraints

- **Tech stack**: NestJS API + `@kodus/flow` for orchestration types + Vercel AI SDK + E2B for sandbox. Migration must reuse this stack — no parallel runtime.
- **No new infra dependencies**: Mongo, Postgres, RabbitMQ, and outbox patterns are already in the stack. Lease coordination must use these — **no Redis introduction**.
- **Compatibility**: Self-hosted installs must keep working without E2B configured — `NullSandboxProvider` keeps the no-sandbox self-contained path alive for both review and conversation.
- **Observable contract**: The memory creation surface (`@kody remember ...`) is user-facing — its inputs/outputs/errors must not regress regardless of which integration approach is chosen.
- **Latency**: Conversational replies have a tighter human-perceived budget than scheduled reviews. If sync p95 exceeds the threshold (TBD by Phase 4 measurement), async UX with status placeholder is acceptable.
- **Cost**: Pause/resume must be the default lifecycle for sandboxes — running idle would multiply E2B spend. Pause is storage-only cost (significantly cheaper than running).
- **No-fork rule**: Phase work that introduces a parallel `runAgentLoop` variant, a parallel sandbox provider, or a duplicated lifecycle service is rejected. Reuse existing seams; if a seam isn't there, extract it generically (benefiting both review and conversation), don't duplicate.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Scope first GSD milestone narrowly to plugging conversation into the review runtime + reorganizing sandbox as a shared capability | Ship one well-bounded change; the sandbox restructure is a real prerequisite, not nice-to-have | — Pending |
| Reuse `runAgentLoop` directly via parameterized `doneToolSchema` + `initialMessages`; do NOT fork | Single source of truth for agent runtime; future improvements to review propagate to conversation for free | — Pending |
| **Sandbox is a PR-scoped resource managed by `SandboxLeaseManager`; review and conversation are lease holders, not lifecycle owners** | Sandbox stops being "review's thing"; future consumers (web chat, CLI) plug in trivially; cost optimization via reuse becomes possible | — Pending |
| **Adopt E2B `onTimeout: 'pause'` + `autoResume: true` as default lifecycle** | Pause is storage-only cost (~order of magnitude cheaper than running); resume is 1–3s vs 15–30s cold-start; eliminates need for our own state machine | — Pending |
| Lease coordination in MongoDB (atomic `findOneAndUpdate` upsert keyed on `prKey`); no Redis | Mongo already a heavy dependency; lease coordination is low-volume; introduces no new infra | — Pending |
| Build `runConversationLoop` as a thin wrapper around `runAgentLoop` rather than overload the loop with conversation branches | Wrapper isolates conversation concerns (text output, thread state, MCP reconciliation) without polluting the review code path | — Pending |
| MCP-vs-native tool integration approach | Defer to phase research; three options on the table (adapter / separate-call / routing layer), pick based on memory-flow regression risk and code complexity | — Pending |
| PR-close + force-push trigger sandbox invalidation via outbox events | Decouples sandbox lifecycle from webhook handlers; ensures cleanup is durable across worker crashes | — Pending |
| Roll out behind a feature flag (per-org and/or per-provider) | Safe enablement, quick rollback if latency or quality regresses | — Pending |
| Output adapter: text reply, not `CodeSuggestion[]` | Conversation UX is a comment reply; suggestions inline would surprise users | — Pending |
| Force-push detection is platform-limited — only GitHub `synchronize` webhooks let us detect force-push (via the `before` SHA dropping out of the PR commit list) | GitLab, Bitbucket, Azure DevOps, and Forgejo push hooks deliver the same shape regardless of force-push vs regular push. Per-platform polling for force-push is V2 work. The 5-min reaper cleans stale sandboxes as backstop, so reviews stay correct — only warm-resume optimization briefly drops on those platforms | ✓ Accepted (Phase 1, 2026-05-04) |

---
*Last updated: 2026-05-04 after E2B SDK feature audit + sandbox layer reframe (libs/sandbox extraction, pause/resume lifecycle, lease coordination via Mongo)*
