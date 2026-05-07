---
phase: "02-conversation-primitives"
plan: "04"
subsystem: conversation
tags: [memory-tools, kody-rules, adapter, ai-sdk]
dependency_graph:
  requires: ["02-01"]
  provides: ["buildConversationMemoryTools", "KODUS_CREATE_MEMORY", "KODUS_FIND_MEMORIES"]
  affects: ["02-05-run-conversation-loop", "02-06-integration-tests"]
tech_stack:
  added: []
  patterns: ["plain-function-factory", "json-schema-tool-definition", "adapter-pattern"]
key_files:
  created:
    - libs/conversation/infrastructure/services/conversation-tools.factory.ts
    - libs/conversation/infrastructure/services/conversation-tools.factory.spec.ts
  modified: []
decisions:
  - "Plain function (not NestJS service) — testable without DI, callers inject IKodyRulesService directly"
  - "organizationId/teamId passed per-call (not closed-over at construction) — Pitfall 3 prevention"
  - "JSON Schema inputSchema (not Zod) — Anthropic API rejects Zod-generated schemas with missing type field"
  - "Imports enums from kodyRules.interface.ts (not a separate enum file) — that is where they live in this codebase"
  - "IKodyRulesService injected directly via KODY_RULES_SERVICE_TOKEN, not via MCP layer (gated behind API_MCP_SERVER_ENABLED)"
metrics:
  duration: "2 min"
  completed_date: "2026-05-04"
  tasks_completed: 2
  files_created: 2
  files_modified: 0
---

# Phase 02 Plan 04: Conversation Memory Tools Factory Summary

**One-liner:** Plain factory function wrapping IKodyRulesService.createOrUpdateMemory and findMemories as AI SDK-compatible mkTool objects, with per-call org binding and JSON Schema input definitions.

## What Was Built

`buildConversationMemoryTools(kodyRulesService, organizationId, teamId)` — a pure factory function in `libs/conversation/infrastructure/services/conversation-tools.factory.ts` that returns a `Record<string, any>` with two tool objects ready for spreading into `AgentLoopInput.additionalTools`:

- **KODUS_CREATE_MEMORY** — wraps `IKodyRulesService.createOrUpdateMemory`; accepts title, rule, optional repositoryId/directoryId/path; returns JSON string with `{ success, action, requiresApproval, link, message }`
- **KODUS_FIND_MEMORIES** — wraps `IKodyRulesService.findMemories`; accepts optional repositoryId, keywords, limit; returns JSON string of `FindMemoriesResult[]`

Both tools use `jsonSchema()` from the `ai` package for their `inputSchema` (matching the mkTool shape established in Phase 1 / agent-tools.factory.ts).

## Decisions Made

1. **Plain function, not NestJS service** — keeps the factory unit-testable without spinning up DI containers; callers inject `IKodyRulesService` via `KODY_RULES_SERVICE_TOKEN` from `KodyRulesModule`.

2. **Per-call org binding** — `organizationId` and `teamId` are function parameters, not closed-over at construction time. This matches Pitfall 3 from the research doc: preventing wrong-org memory creation when the factory is reused across concurrent requests.

3. **JSON Schema, not Zod** — Anthropic's API rejects Zod-generated schemas (missing `type` field). `jsonSchema()` from the `ai` package produces the correct raw JSON Schema shape.

4. **Safe null guard** — returns `{}` when `kodyRulesService` is null/undefined; self-hosted instances where KodyRulesModule is not wired get a no-op gracefully.

5. **Enum source** — `KodyRulesType`, `KodyRulesOrigin`, `KodyRulesStatus` are imported from `kodyRules.interface.ts`, where they are defined (not a separate enums file).

## Test Results

5 unit tests, all passing (0.439s):
- null-guard returns empty object
- returns both KODUS_CREATE_MEMORY and KODUS_FIND_MEMORIES keys
- createOrUpdateMemory called with correct organizationId
- skipped-action JSON output correctly forwarded
- findMemories called with correct organizationId

## Deviations from Plan

None — plan executed exactly as written. The IKodyRuleMemory interface confirmed the field shapes matched the plan's template. Enums are defined in `kodyRules.interface.ts` (same file as the interfaces), not a separate `kodyRules.enum.ts` as the plan's grep suggestion implied — no deviation, just a minor path adjustment handled per plan instructions.

## Self-Check: PASSED

- FOUND: libs/conversation/infrastructure/services/conversation-tools.factory.ts
- FOUND: libs/conversation/infrastructure/services/conversation-tools.factory.spec.ts
- FOUND commit: a32c5303a (feat(02-04): implement buildConversationMemoryTools factory)
- FOUND commit: 585984820 (test(02-04): unit tests for buildConversationMemoryTools adapter)
