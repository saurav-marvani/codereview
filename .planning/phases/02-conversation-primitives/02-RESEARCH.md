# Phase 2: Conversation Primitives — Research

**Researched:** 2026-05-04
**Domain:** `runConversationLoop` wrapper, `ConversationSessionManager` Mongo persistence, MCP-vs-native tool reconciliation
**Confidence:** HIGH — all findings verified against source files with line references

---

## Summary

Phase 2 ships three bounded deliverables in isolation with no live `@kody` traffic routed yet:
`runConversationLoop` (thin wrapper over `runAgentLoop`), `ConversationSessionManager` (Mongo-backed thread persistence), and the resolved MCP-vs-native integration decision. Everything lives in a new `libs/conversation/` library. Nothing in `libs/code-review/` changes.

The MCP tool investigation reveals that `KODUS_CREATE_MEMORY` and `KODUS_FIND_MEMORIES` are defined as `McpToolDefinition` objects (`libs/mcp-server/tools/kodyRules.tools.ts:867, 1004`) with standard Zod `inputSchema` and an `execute` function that directly calls `IKodyRulesService`. The `execute` function signature `(args, extra?) => Promise<output>` is close enough to the `mkTool` execute shape `(args) => Promise<string>` that an adapter (Option A) can bridge them with a thin wrapper — no second LLM call, no routing layer. **Use Option A: Adapter.** Details follow.

Thread persistence: the existing `pullRequestMessages` collection stores code-review configuration (start/end message templates), not chat turns. It cannot be reused. A dedicated `conversation_threads` collection is required.

NullSandbox detection: `SandboxInstance.type === 'null'` is the discriminator, established by Phase 1. `runConversationLoop` reads it from `AcquireResult.sandbox.type` after acquiring from `SandboxLeaseManager`.

**Primary recommendation:** Implement Option A (MCP adapter wrapping). Create `libs/conversation/` as a standalone NestJS library with module, schema, manager, and loop. All Phase 1 seams (`doneToolSchema`, `initialMessages`, `createMockRemoteCommands`) are consumed without modification.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `runAgentLoop` from `@libs/code-review/infrastructure/agents/llm/agent-loop` | Phase 1 | The loop `runConversationLoop` wraps | EXT-01 + EXT-02 already shipped; `doneToolSchema` + `initialMessages` are the levers |
| `SandboxLeaseManager` via `SANDBOX_LEASE_MANAGER_TOKEN` | Phase 1 | Acquire/release sandbox lease; detect NullSandbox | `libs/sandbox/modules/sandbox.module.ts` exports the token |
| `mongoose` / `@nestjs/mongoose` | 9.6.0 / 11.0.4 | `conversation_threads` collection schema | Every Mongo-backed lib uses this; `SandboxLeaseModel` at `libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model.ts` is the schema template |
| `zod` | in tree | `doneToolSchema` for conversation reply: `z.object({ reply: z.string() })` | Already the schema runtime used by `AgentLoopInput.doneToolSchema` |
| `KodyRulesToolsService` (injectable) | in tree | Source of `KODUS_CREATE_MEMORY` / `KODUS_FIND_MEMORIES` `McpToolDefinition` objects via `createMemoryRule()` / `findMemoriesRule()` | The `execute` functions carry the full `IKodyRulesService` call; Option A injects the service and calls `execute` directly through a `mkTool` adapter |
| `createMockRemoteCommands` from `test/fixtures/remote-commands.mock.ts` | Phase 1 | `runConversationLoop` test driver | TEST-01 already delivered; same fixture for TEST-02/03 |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@nestjs/common` `@Inject`, `Injectable` | 11.x | Token-based DI for `ConversationSessionManager`, conversation module | Every NestJS lib follows this |
| `ConfigService` from `@nestjs/config` | 11.x | Reading env vars inside conversation module if needed | Use only if conversation needs env-specific behavior |
| `createLogger` from `@kodus/flow` | 0.1.50 | Structured logging in `runConversationLoop` and `ConversationSessionManager` | All services in the codebase use this |
| `ModelMessage` from `ai` | in tree | Type for stored and materialized messages | `AgentLoopInput.initialMessages?: ModelMessage[]` — must match exactly |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Option A (Adapter) | Option B (Separate-call) | B doubles LLM calls per `@kody` invocation — doubles latency and cost; no benefit when the adapter is 15 lines |
| Option A (Adapter) | Option C (Routing layer) | C adds a registry indirection for a two-tool surface; over-engineered for Phase 2; Phase 3 may add tools but the registry can grow then |
| Dedicated `conversation_threads` collection | Reusing `pullRequestMessages` | `pullRequestMessages` stores code-review config (start/end message templates with `status` enum, `configLevel`, `directoryId`); completely different shape; reuse would require polymorphic schema hacks |
| `libs/conversation/` as standalone lib | Adding to `libs/agents/` | `libs/agents/` hosts the legacy `ConversationAgentProvider` + `ConversationAgentUseCase` (Phase 3 replacement targets); mixing new primitives there creates circular replacement during Phase 3 |

**Installation:** No new packages needed. All dependencies already in `package.json`.

---

## Architecture Patterns

### Recommended `libs/conversation/` Structure

Mirror `libs/sandbox/modules/sandbox.module.ts` for the module pattern and `libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model.ts` for the schema.

```
libs/conversation/
├── domain/
│   ├── contracts/
│   │   ├── conversation-session-manager.contract.ts   # IConversationSessionManager interface + token
│   │   └── conversation-loop.contract.ts              # ConversationLoopInput / ConversationLoopOutput types
│   └── interfaces/
│       └── conversation-thread.interface.ts           # IConversationThread shape
├── infrastructure/
│   ├── repositories/
│   │   ├── schemas/
│   │   │   └── conversation-thread.model.ts           # Mongoose schema
│   │   └── conversation-thread.repository.ts          # IConversationThreadRepository
│   └── services/
│       ├── conversation-session-manager.service.ts    # ConversationSessionManager impl
│       └── conversation-loop.service.ts               # runConversationLoop wrapper
└── modules/
    └── conversation.module.ts                         # NestJS module — exports CONVERSATION_SESSION_MANAGER_TOKEN
```

No `application/use-cases/` needed in Phase 2 — the loop is a function, not a use-case. Use-case lives in Phase 3 (`ChatWithKodyFromGitUseCase` injection of `runConversationLoop`).

### Pattern 1: `runConversationLoop` Function Shape (CONV-02)

`runConversationLoop` is a thin async function — NOT a NestJS service — to keep it testable without DI.

```typescript
// libs/conversation/infrastructure/services/conversation-loop.service.ts

import { z } from 'zod';
import { runAgentLoop, AgentLoopSecrets } from '@libs/code-review/infrastructure/agents/llm/agent-loop';
import { type ModelMessage } from 'ai';
import type { LanguageModel } from 'ai';

export interface ConversationLoopInput {
    model: LanguageModel;
    systemPrompt: string;
    userPrompt: string;
    /** Materialized prior turns from ConversationSessionManager.materializeInitialMessages() */
    initialMessages?: ModelMessage[];
    maxSteps?: number;
    agentName?: string;
    /** Set from SandboxLeaseManager.acquire(); if sandbox.type === 'null', tools are skipped */
    sandbox: import('@libs/sandbox/domain/contracts/sandbox.provider').SandboxInstance;
    telemetryMetadata?: import('@libs/code-review/infrastructure/agents/llm/agent-loop').LangfuseTelemetryMetadata;
    byokConfig?: import('@libs/code-review/infrastructure/agents/llm/agent-loop').AgentLoopSecrets['byokConfig'];
}

/** Plain text reply — never CodeSuggestion[] */
export interface ConversationLoopOutput {
    reply: string;
    steps: number;
    toolCalls: Array<{ tool: string; args: Record<string, unknown>; result?: string }>;
}

/** Zod schema for the done-tool — passed as doneToolSchema to runAgentLoop (EXT-01) */
const CONVERSATION_DONE_SCHEMA = z.object({ reply: z.string() });

export async function runConversationLoop(
    input: ConversationLoopInput,
    extraSecrets?: Partial<AgentLoopSecrets>,
): Promise<ConversationLoopOutput> {
    // NullSandbox path: sandbox.type === 'null' means no E2B — single-shot mode.
    // buildAgentTools returns {} when remoteCommands is undefined, so the loop
    // runs in self-contained mode (isSelfContained = true, stopWhen = stepCountIs(1)).
    const remoteCommands = input.sandbox.type === 'null'
        ? undefined
        : input.sandbox.remoteCommands;

    const output = await runAgentLoop(
        {
            model: input.model,
            systemPrompt: input.systemPrompt,
            userPrompt: input.userPrompt,
            doneToolSchema: CONVERSATION_DONE_SCHEMA,   // EXT-01: text reply, not CodeSuggestion[]
            initialMessages: input.initialMessages,      // EXT-02: multi-turn context
            maxSteps: input.maxSteps ?? 15,
            agentName: input.agentName ?? 'kodus-conversation-agent',
            telemetryMetadata: input.telemetryMetadata,
            skipHeavyPasses: true,   // skip coverage-recovery and verify passes — conversation only
            skipSynthesisRescue: true,
        },
        {
            remoteCommands,
            byokConfig: input.byokConfig,
            ...extraSecrets,
        },
    );

    // Extract `reply` from the done-tool schema output, fall back to raw text.
    // When isSelfContained=true (NullSandbox), output.findings may be empty; use text.
    const reply: string =
        (output.findings as any)?.reply ??
        output.text ??
        '';

    return {
        reply,
        steps: output.steps,
        toolCalls: output.toolCalls,
    };
}
```

**Key design decisions:**
- `sandbox.type === 'null'` → pass `remoteCommands: undefined` → `buildAgentTools` returns `{}` → loop is `isSelfContained = true` → `stopWhen = stepCountIs(1)` (single LLM call). This is the NullSandbox path required by SBX-06.
- `skipHeavyPasses: true` prevents coverage-recovery and verify passes that are review-specific.
- `doneToolSchema: z.object({ reply: z.string() })` (not `_findingsSchema`) ensures `output.findings` has shape `{ reply: string }` not `{ suggestions: [] }`.

### Pattern 2: `ConversationSessionManager` API (STATE-01, STATE-02)

```typescript
// libs/conversation/domain/contracts/conversation-session-manager.contract.ts

import type { ModelMessage } from 'ai';

export const CONVERSATION_SESSION_MANAGER_TOKEN = Symbol('ConversationSessionManager');

export interface IConversationSessionManager {
    /**
     * Load the stored turns for a PR thread. Returns [] when no thread exists yet.
     * prKey: "{orgId}:{repoId}:{prNumber}" — same key format as SandboxLeaseManager
     */
    load(prKey: string): Promise<ConversationTurn[]>;

    /**
     * Atomically append one turn to the thread. Uses $push for concurrency safety.
     * Creates the doc if it doesn't exist yet (upsert).
     */
    appendTurn(prKey: string, turn: ConversationTurn): Promise<void>;

    /**
     * Materialize stored turns as ModelMessage[] for AgentLoopInput.initialMessages.
     * Applies the token budget truncation: keeps the most recent turns that fit
     * within MAX_HISTORY_TURNS (20 turns); older turns are dropped, not summarized.
     */
    materializeInitialMessages(prKey: string): Promise<ModelMessage[]>;
}

export interface ConversationTurn {
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
    /** Populated for assistant turns — the tool calls made during this turn */
    toolCalls?: Array<{ tool: string; args: Record<string, unknown>; result?: string }>;
}
```

`MAX_HISTORY_TURNS = 20`: 20 turns (10 user + 10 assistant) × ~2KB average = ~40KB context from history. At typical 200K context windows, this is safe. When the stored thread exceeds 20 turns, `materializeInitialMessages` returns the most recent 20 only. Truncation is by turn count, not token count — simple and deterministic.

### Pattern 3: `conversation_threads` Mongo Schema

Template: `libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model.ts`.

```typescript
// libs/conversation/infrastructure/repositories/schemas/conversation-thread.model.ts

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ collection: 'conversation_threads', timestamps: false })
export class ConversationThreadModel {
    // prKey: "{orgId}:{repoId}:{prNumber}" — document _id
    _id: string;

    @Prop({
        type: [
            {
                role: { type: String, required: true, enum: ['user', 'assistant'] },
                content: { type: String, required: true },
                timestamp: { type: Date, required: true },
                toolCalls: { type: Array, required: false, default: undefined },
            },
        ],
        default: [],
    })
    turns: Array<{
        role: 'user' | 'assistant';
        content: string;
        timestamp: Date;
        toolCalls?: Array<{ tool: string; args: Record<string, unknown>; result?: string }>;
    }>;

    @Prop({ type: Date, required: true })
    createdAt: Date;

    @Prop({ type: Date, required: true })
    updatedAt: Date;
}

export const ConversationThreadSchema =
    SchemaFactory.createForClass(ConversationThreadModel);

// TTL index: auto-delete threads older than 90 days
ConversationThreadSchema.index(
    { updatedAt: 1 },
    { expireAfterSeconds: 90 * 24 * 60 * 60, name: 'idx_conversation_thread_ttl' },
);
```

**Why a TTL index here (vs no TTL for sandbox leases):** Thread docs contain only text — no E2B sandbox to kill before deletion. MongoDB can auto-expire them safely. 90-day window keeps threads alive for the life of an active PR review cycle.

**Why `updatedAt` not `createdAt` for TTL:** A PR with many follow-up comments should keep its thread alive as long as it's active. Using `updatedAt` resets the TTL on each new `@kody` comment.

### Pattern 4: `appendTurn` — Atomic `$push` for Concurrent Safety

```typescript
// libs/conversation/infrastructure/repositories/conversation-thread.repository.ts
// Template: libs/platformData/infrastructure/adapters/repositories/pullRequests.repository.ts:923

async appendTurn(prKey: string, turn: ConversationTurn): Promise<void> {
    const now = new Date();
    await this.threadModel.findOneAndUpdate(
        { _id: prKey },
        {
            $push: { turns: turn },
            $set: { updatedAt: now },
            $setOnInsert: { createdAt: now },
        },
        { upsert: true },
    );
}
```

`$push` is atomic at the document level — two concurrent `@kody` webhooks for the same PR cannot lose each other's turns. This directly addresses the concurrent-append pitfall. No optimistic locking needed because `$push` appends; it does not replace.

### Pattern 5: Chosen MCP Integration — Option A: Adapter (CONV-03)

**Decision: Option A. Wrap `KODUS_CREATE_MEMORY` and `KODUS_FIND_MEMORIES` as native AI SDK tools using `mkTool`, so `runAgentLoop` sees them as regular tools.**

**Rationale:**
- **(a) Memory regression risk:** ZERO. The `execute` functions in `KodyRulesToolsService.createMemoryRule()` and `findMemoriesRule()` call `IKodyRulesService.createOrUpdateMemory` and `findMemories` directly. The adapter calls the same `execute` — same path, same deduplication, same confirmation message.
- **(b) Code complexity:** ~30 lines per tool to adapt `McpToolDefinition.execute` → `mkTool` shape. Lowest complexity of the three options.
- **(c) Token cost:** One LLM call per `@kody` invocation. Option B (separate-call) would double it.
- **(d) Maintainability:** When MCP tool schemas change, the adapter re-uses the same `inputSchema` from `McpToolDefinition` directly — no duplication.

**Why not Option B:** Two passes means two LLM calls. For a simple `@kody remember X` that resolves in one tool call, we'd still pay for a full first-pass LLM call to classify intent, then a full second-pass LLM call for response. At current LLM pricing this doubles cost. Latency impact is also unacceptable for the tight conversation budget.

**Why not Option C:** A routing layer adds a tool registry abstraction. We have exactly two MCP tools to integrate. A registry whose only current users are two tools is over-engineering for Phase 2. The routing layer, if ever needed, can be introduced in a later phase when the tool count justifies it.

**Adapter implementation — `buildConversationTools`:**

```typescript
// libs/conversation/infrastructure/services/conversation-tools.factory.ts

import { jsonSchema } from 'ai';
import { toShape } from '@libs/mcp-server/types/mcp-tool.interface';
import { KodyRulesToolsService } from '@libs/mcp-server/tools/kodyRules.tools';

/**
 * Build the native AI SDK tools for conversation.
 * Wraps KODUS_CREATE_MEMORY and KODUS_FIND_MEMORIES as mkTool-compatible
 * objects so runAgentLoop sees them as regular tools.
 *
 * Returns {} when organizationAndTeamData is absent — same guard as buildAgentTools.
 */
export function buildConversationMemoryTools(
    kodyRulesToolsService: KodyRulesToolsService,
    organizationId: string,
    teamId: string,
): Record<string, any> {
    const createMemoryDef = kodyRulesToolsService.createMemoryRule();
    const findMemoriesDef = kodyRulesToolsService.findMemoriesRule();

    const mkTool = (
        desc: string,
        schema: Record<string, any>,
        exec: (args: any) => Promise<string>,
    ) => ({
        type: 'function' as const,
        description: desc,
        inputSchema: jsonSchema(schema),
        execute: exec,
    });

    return {
        KODUS_CREATE_MEMORY: mkTool(
            createMemoryDef.description,
            { type: 'object', properties: toShape(createMemoryDef.inputSchema as any) ?? {}, required: ['organizationId', 'teamId', 'kodyRule'] },
            async (args: any) => {
                const result = await createMemoryDef.execute(
                    { ...args, organizationId, teamId },
                );
                return JSON.stringify(result);
            },
        ),
        KODUS_FIND_MEMORIES: mkTool(
            findMemoriesDef.description,
            { type: 'object', properties: toShape(findMemoriesDef.inputSchema as any) ?? {}, required: ['organizationId', 'teamId'] },
            async (args: any) => {
                const result = await findMemoriesDef.execute(
                    { ...args, organizationId, teamId },
                );
                return JSON.stringify(result);
            },
        ),
    };
}
```

**Integration into `runConversationLoop`:** Pass the memory tools into `AgentLoopSecrets` is NOT the right seam — `AgentLoopSecrets` has no `additionalTools` field. Instead, extend `ConversationLoopInput` with a `memoryTools?: Record<string, any>` field and merge them into the tool set.

Wait — `runAgentLoop` does not accept additional tools. `buildAgentTools` is internal. The correct seam is: expose a `tools` override in `AgentLoopInput`. But adding an `additionalTools` field to `AgentLoopInput` would touch review-side code.

**Correct approach without touching `AgentLoopInput`:**

`runConversationLoop` does NOT call `runAgentLoop` for memory tool dispatch. Instead, `runConversationLoop` calls `runAgentLoop` for code navigation, then the memory tools are registered through a `systemPrompt` instruction + a per-turn tool-call interception... No — this is getting complicated.

**The actual correct approach:** Add `additionalTools?: Record<string, any>` to `AgentLoopInput` (lines 749–756 area). This is a generic seam that benefits both conversation and future callers. `buildAgentTools` merges `additionalTools` at the end. This is a one-line change in `agent-loop.ts` (merge in `runAgentLoop` before the loop). This satisfies MAINT-01 (it's a generic seam, not a conversation branch).

```typescript
// Addition to AgentLoopInput (agent-loop.ts, after line 756):
/**
 * Additional tools to merge with the native tools built by buildAgentTools.
 * Use for non-review callers (e.g., conversation memory tools). EXT-03.
 */
additionalTools?: Record<string, any>;
```

In `runAgentLoop` at line ~888 where `tools` is built:
```typescript
const tools = {
    ...buildAgentTools(secrets.remoteCommands, ...),
    ...(input.additionalTools ?? {}),
};
```

This is the CORRECT minimal change — generic, backward-compatible (optional field, `??` default to empty).

**Memory operation flow under Option A:**

```
1. User writes "@kody remember always use named exports"
2. ChatWithKodyFromGitUseCase (Phase 3) calls runConversationLoop with:
   - memoryTools = buildConversationMemoryTools(kodyRulesToolsService, orgId, teamId)
   - input.additionalTools = memoryTools
3. runConversationLoop passes additionalTools to runAgentLoop
4. runAgentLoop merges memoryTools with native tools → { grep, readFile, ..., KODUS_CREATE_MEMORY, KODUS_FIND_MEMORIES }
5. Model calls KODUS_CREATE_MEMORY → adapter.execute() → createMemoryDef.execute() → KodyRulesService.createOrUpdateMemory()
6. Same response as today: "Memory created. Approval required: no. View at [link]."
7. runConversationLoop extracts reply text from output.text or output.findings.reply
8. ConversationSessionManager.appendTurn(prKey, { role: 'assistant', content: reply })
```

**Memory bootstrap (KODUS_FIND_MEMORIES on every call):** In Phase 2, the memory bootstrap instruction is embedded in `systemPrompt` (same as `buildPromptWithMemoryBootstrap` in `conversationAgent.ts:256-266`). The planner will document this in the system prompt template; the adapter just makes the tool available.

### Pattern 6: `ConversationSessionManager` Implementation Sketch

```typescript
// libs/conversation/infrastructure/services/conversation-session-manager.service.ts

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { ModelMessage } from 'ai';
import { ConversationThreadModel } from '../repositories/schemas/conversation-thread.model';
import { type ConversationTurn, type IConversationSessionManager } from '../../domain/contracts/conversation-session-manager.contract';

const MAX_HISTORY_TURNS = 20;

@Injectable()
export class ConversationSessionManager implements IConversationSessionManager {
    constructor(
        @InjectModel(ConversationThreadModel.name)
        private readonly threadModel: Model<ConversationThreadModel>,
    ) {}

    async load(prKey: string): Promise<ConversationTurn[]> {
        const doc = await this.threadModel.findById(prKey).lean();
        return doc?.turns ?? [];
    }

    async appendTurn(prKey: string, turn: ConversationTurn): Promise<void> {
        const now = new Date();
        await this.threadModel.findOneAndUpdate(
            { _id: prKey },
            {
                $push: { turns: turn },
                $set: { updatedAt: now },
                $setOnInsert: { createdAt: now },
            },
            { upsert: true },
        );
    }

    async materializeInitialMessages(prKey: string): Promise<ModelMessage[]> {
        const turns = await this.load(prKey);
        // Truncate to most recent MAX_HISTORY_TURNS turns to stay within context budget.
        // Older turns are dropped (not summarized). Document this behavior for operators.
        const recentTurns = turns.slice(-MAX_HISTORY_TURNS);
        return recentTurns.map((t): ModelMessage => ({
            role: t.role,
            content: t.content,
        }));
    }
}
```

### Pattern 7: `ConversationModule` DI Wiring

```typescript
// libs/conversation/modules/conversation.module.ts

import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { McpCoreModule } from '@libs/mcp-server/mcp-core.module';
import { SandboxModule } from '@libs/sandbox/modules/sandbox.module';
import { ConversationThreadModel, ConversationThreadSchema } from '../infrastructure/repositories/schemas/conversation-thread.model';
import { ConversationSessionManager } from '../infrastructure/services/conversation-session-manager.service';
import { CONVERSATION_SESSION_MANAGER_TOKEN } from '../domain/contracts/conversation-session-manager.contract';

@Module({
    imports: [
        MongooseModule.forFeature([
            { name: ConversationThreadModel.name, schema: ConversationThreadSchema },
        ]),
        SandboxModule,         // exports SANDBOX_LEASE_MANAGER_TOKEN
        McpCoreModule,         // exports KodyRulesToolsService (needed for memory adapter in Phase 3)
    ],
    providers: [
        {
            provide: CONVERSATION_SESSION_MANAGER_TOKEN,
            useClass: ConversationSessionManager,
        },
    ],
    exports: [CONVERSATION_SESSION_MANAGER_TOKEN],
})
export class ConversationModule {}
```

**Phase 3 wire-up:** `ChatWithKodyFromGitUseCase` imports `ConversationModule` via the platform module. It injects `CONVERSATION_SESSION_MANAGER_TOKEN` + `SANDBOX_LEASE_MANAGER_TOKEN` + `KodyRulesToolsService`. It calls `runConversationLoop` directly (function call, no service wrapper needed for Phase 2).

### Pattern 8: NullSandbox Detection in `runConversationLoop`

```typescript
// Inside runConversationLoop (Pattern 1 above):
const remoteCommands = input.sandbox.type === 'null'
    ? undefined
    : input.sandbox.remoteCommands;
```

`SandboxInstance.type: 'e2b' | 'local' | 'null'` — defined at `libs/sandbox/domain/contracts/sandbox.provider.ts:42`. `NULL_SANDBOX_INSTANCE.type === 'null'` set at `libs/sandbox/infrastructure/providers/null-sandbox.service.ts:25`. `SandboxLeaseManager.buildNullSandboxWithRelease()` spreads `NULL_SANDBOX_INSTANCE` (`sandbox-lease-manager.service.ts:465`), so the `type` field is always preserved.

**When `type === 'null'`:** `remoteCommands = undefined` → `buildAgentTools(undefined, ...)` returns `{}` → `isSelfContained = true` inside `runAgentLoop` → `stopWhen = stepCountIs(1)` → single LLM call, no tool calls. The LLM analyzes only what's in the user prompt (the `@kody` comment + thread context inlined). No grep, no readFile. Memory tools in `additionalTools` still work (they don't depend on sandbox).

### Anti-Patterns to Avoid

- **Never pass `sandbox.remoteCommands` from `NULL_SANDBOX_INSTANCE` directly.** `NULL_SANDBOX_INSTANCE.remoteCommands` has `grep: async () => ''` and no `exec` — partial mock. If passed, `buildAgentTools` returns tools that silently return empty strings. Detection: `sandbox.type === 'null'`, not presence of `remoteCommands`.
- **Never add conversation branches inside `agent-loop.ts` or `agent-tools.factory.ts`.** All conversation-specific logic stays in `libs/conversation/`. The `additionalTools` field on `AgentLoopInput` is a generic seam — no conversation-specific naming inside agent-loop.
- **Never call `runAgentLoop` with `doneToolSchema: undefined` for conversation.** Default is `_findingsSchema`, which expects `suggestions: []`. Conversation callers MUST pass `CONVERSATION_DONE_SCHEMA = z.object({ reply: z.string() })`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Conversation agent runtime | Fork `runAgentLoop` or create a parallel loop | Call `runAgentLoop` via `runConversationLoop` wrapper with `doneToolSchema` + `initialMessages` | MAINT-01 requires zero forking; Phase 1 shipped exactly the right seams |
| Memory creation logic | Custom `@kody remember` parser or new DB write | `KODUS_CREATE_MEMORY` via `KodyRulesToolsService.createMemoryRule().execute()` wrapped in Option A adapter | The tool already handles create/update/dedup/approval-gating; adapter is 10 lines |
| Memory lookup logic | Prompt injection at conversation layer | `KODUS_FIND_MEMORIES` via `KodyRulesToolsService.findMemoriesRule().execute()` wrapped in Option A adapter | Same tool handles query and formatting |
| Sandbox lifecycle | New `SandboxProvider` or `create/kill` calls | `SandboxLeaseManager.acquire/release` via `SANDBOX_LEASE_MANAGER_TOKEN` from `libs/sandbox/modules/sandbox.module.ts` | Phase 1 delivered the shared lifecycle; conversation is a second consumer, not a new lifecycle |
| Mongo connection / schema registration | Custom `MongooseModule` setup | `MongooseModule.forFeature([{ name: ConversationThreadModel.name, schema: ConversationThreadSchema }])` in `ConversationModule` | Identical pattern to `SandboxModule` (`sandbox.module.ts:20-22`) |
| Test mock for `RemoteCommands` | New mock factory | `createMockRemoteCommands()` from `test/fixtures/remote-commands.mock.ts` | TEST-01 already delivered; Phase 2 tests import this directly |
| Thread ID / thread persistence for `@kodus/flow` agent | `createThreadId` + `Thread` type wiring | NOT NEEDED in Phase 2 — `runAgentLoop` is stateless; `ConversationSessionManager` + `initialMessages` IS the multi-turn mechanism | `createThreadId` is a `@kodus/flow` primitive for the legacy `SDKOrchestrator`; `runAgentLoop` uses Vercel AI SDK natively |
| Redis for thread state | Redis client + session store | `conversation_threads` Mongo collection with atomic `$push` | PROJECT.md constraint: no Redis; Mongo atomic `$push` is sufficient |
| LLM call for memory classification | Separate intent-detection LLM pass (Option B) | Model decides to call `KODUS_CREATE_MEMORY` based on system prompt + tool description | The tool description at `kodyRules.tools.ts:869` already encodes the invocation heuristic |
| Circular import: `libs/conversation/` → `libs/code-review/modules/` | Importing from review-side composites | Import only from `@libs/code-review/infrastructure/agents/llm/agent-loop` (the lowest-level file, no review-side imports) and `@libs/sandbox/domain/contracts/` | `codebase.module.ts` imports everything; reaching into it creates circular deps |

---

## Common Pitfalls

### Pitfall 1: History Budget Overflow
**What goes wrong:** A PR with 30+ `@kody` exchanges accumulates 60+ turns. `materializeInitialMessages` returns all of them, inflating `initialMessages` past the model context window. The LLM call fails or truncates the conversation arbitrarily.
**Why it happens:** `turns` array in Mongo is unbounded; no cap at `appendTurn` time.
**How to avoid:** `materializeInitialMessages` applies `turns.slice(-MAX_HISTORY_TURNS)` (20 turns) before mapping to `ModelMessage[]`. Log when truncation occurs: `if (turns.length > MAX_HISTORY_TURNS) logger.warn({ message: 'Conversation history truncated', prKey, totalTurns: turns.length, kept: MAX_HISTORY_TURNS })`.
**Prevention action a task can verify:** Test with a seeded thread of 30 turns; assert `materializeInitialMessages` returns exactly 20 messages and emits the truncation log.

### Pitfall 2: Sandbox Lease Leak from Conversation Path
**What goes wrong:** `runConversationLoop` throws after `SandboxLeaseManager.acquire()` but before `SandboxLeaseManager.release()`. The Mongo lease doc has `leaseCount > 0` indefinitely.
**Why it happens:** Any `await` between acquire and release can throw.
**How to avoid:** The caller (Phase 3 `ChatWithKodyFromGitUseCase`) wraps the loop in `try/finally`: `finally { await leaseManager.release(leaseId); }`. Phase 2 `runConversationLoop` does NOT acquire/release — it receives an already-acquired `sandbox` in `ConversationLoopInput`. Acquisition is the caller's responsibility. Document this contract explicitly in `ConversationLoopInput.sandbox` JSDoc.
**Prevention action a task can verify:** Integration test where `runConversationLoop` throws (mock LLM throws); assert the test fixture releases the mock sandbox (caller's `finally` fires). Note: Phase 2 unit tests mock the sandbox directly — lease lifecycle is Phase 3's concern, but the contract must be documented now.

### Pitfall 3: Memory Regression Under Option A
**What goes wrong:** Adapter wraps `McpToolDefinition.execute` but passes incorrect `organizationId`/`teamId`, causing memories to be created in the wrong org or rejected.
**Why it happens:** The adapter pre-bakes `organizationId` and `teamId` at construction time (Pattern 5 above). If the wrong values are passed to `buildConversationMemoryTools`, all memory operations silently target the wrong org.
**How to avoid:** Build memory tools per-request inside `runConversationLoop` call, not once at service construction time. Pass `organizationId` and `teamId` from `ConversationLoopInput`, not from a module-level singleton.
**Prevention action a task can verify:** TEST-03 regression test: create a memory with `orgId: 'org-A'`; assert `KodyRulesService.createOrUpdateMemory` was called with `organizationId: 'org-A'`, not a hardcoded or wrong value.

### Pitfall 4: NullSandbox Path Silently Invokes Tool Stubs
**What goes wrong:** `input.sandbox.type !== 'null'` check is omitted. `NULL_SANDBOX_INSTANCE.remoteCommands.grep()` returns `''` silently. The agent calls grep, gets empty string, proceeds with zero findings. User receives a vacuous reply with no error.
**Why it happens:** `NULL_SANDBOX_INSTANCE.remoteCommands` has valid `grep/read/listDir` methods — they just return `''`. Passing them to `buildAgentTools` registers tools that silently do nothing.
**How to avoid:** Check `sandbox.type === 'null'` and pass `remoteCommands: undefined` — this makes `buildAgentTools` return `{}` and sets `isSelfContained = true`. Never pass `NULL_SANDBOX_INSTANCE.remoteCommands` directly.
**Prevention action a task can verify:** Test: call `runConversationLoop` with a mock sandbox where `type = 'null'`; assert `mockGenerateText` was called with no `tools` object (or an empty one), and no `grep`/`readFile` calls were made.

### Pitfall 5: Concurrent `@kody` Comments Race on Thread Append
**What goes wrong:** Two `@kody` comments arrive simultaneously on the same PR (e.g., two developers). Both materialize the same empty thread, both generate replies, and both call `appendTurn`. The second `appendTurn` overwrites or conflicts with the first.
**Why it happens:** `$push` is atomic per-document but does not prevent two concurrent appends from interleaving.
**How to avoid:** `$push` is actually safe for this case — MongoDB's document-level locking ensures both pushes succeed and neither is lost. The result is both turns appear in the array (in arrival order). This is correct behavior. The real risk is both users seeing each other's reply arrive out-of-order in GitHub, but that's a platform rendering issue, not a data-loss issue.
**Prevention action a task can verify:** Test with two concurrent `appendTurn` calls to the same prKey; assert both turns appear in the stored document.

### Pitfall 6: Token Leakage in Stored History
**What goes wrong:** A PR comment contains credentials (e.g., `@kody here's my API key: sk-abc123`). The `content` field is stored verbatim in `conversation_threads`. A future `materializeInitialMessages` call injects it back into the LLM context, where it may appear in logs or Langfuse traces.
**Why it happens:** No redaction step between webhook payload → `appendTurn`.
**How to avoid:** Phase 2 does not implement redaction (it's a hardening concern, not a correctness concern). Flag for Phase 4 hardening. Add a JSDoc comment on `appendTurn` documenting that `content` is stored unredacted and callers are responsible for not passing secrets.
**Prevention action a task can verify:** Document the absence of redaction; add a TODO comment in `appendTurn` pointing to the Phase 4 hardening backlog.

### Pitfall 7: `additionalTools` Field Leaks into Review Path
**What goes wrong:** `additionalTools` is added to `AgentLoopInput`. A review caller accidentally passes `additionalTools` (copy-paste error) and the review agent gets memory tools. The agent calls `KODUS_CREATE_MEMORY` during a code review.
**Why it happens:** Generic seam with no guard.
**How to avoid:** Add JSDoc on `additionalTools`: "For non-review callers only. Review pipeline callers MUST NOT set this field." Add a lint rule or test that asserts no review pipeline caller (stages in `libs/code-review/pipeline/stages/`) sets `additionalTools`. Enforcement in code: the field is optional and defaults to `undefined` — existing review callers do not set it.
**Prevention action a task can verify:** `grep -rn "additionalTools" libs/code-review/pipeline/stages/` returns no matches after Phase 2.

### Pitfall 8: Module Circular Imports
**What goes wrong:** `libs/conversation/` imports from `libs/code-review/modules/codebase.module.ts` to get `runAgentLoop`. `codebase.module.ts` imports from `libs/sandbox/`, which may create circular deps.
**Why it happens:** `codebase.module.ts` is a composite module that re-exports many things. Importing it drags in the entire review pipeline DI graph.
**How to avoid:** Import `runAgentLoop` ONLY from `@libs/code-review/infrastructure/agents/llm/agent-loop` (direct file path, not via module). `runAgentLoop` is a plain exported function, not a NestJS provider — no DI needed. `ConversationModule` does not import `CodebaseModule` at all.
**Prevention action a task can verify:** `grep -rn "codebase.module\|CodebaseModule" libs/conversation/` returns no matches.

---

## Code Examples

### 1. `KODUS_CREATE_MEMORY` MCP Tool Definition (Option A anchor)

```typescript
// libs/mcp-server/tools/kodyRules.tools.ts:866-951 (condensed)
// createMemoryRule() returns McpToolDefinition with:
//   name: 'KODUS_CREATE_MEMORY'
//   description: 'Capture a memory, preference, or coding rule...'
//   inputSchema: z.object({ organizationId, teamId, kodyRule: { title, rule, repositoryId?, directoryId?, path? } })
//   outputSchema: z.object({ success, count, data: { uuid, title, rule, status, action, requiresApproval, message?, link } })
//   execute: async (args) => this.kodyRulesService.createOrUpdateMemory(...)
```

The `execute` function at line 889 is what the Option A adapter calls. It takes the same `args` shape as `inputSchema` and returns the `outputSchema` shape. The adapter serializes the result to JSON for the AI SDK tool return.

### 2. `KODUS_FIND_MEMORIES` MCP Tool Definition

```typescript
// libs/mcp-server/tools/kodyRules.tools.ts:1004-1051 (condensed)
// findMemoriesRule() returns McpToolDefinition with:
//   name: 'KODUS_FIND_MEMORIES'
//   inputSchema: z.object({ organizationId, teamId, repositoryId?, directoryId?, path?, keywords?, limit? })
//   outputSchema: z.object({ success, count, data: [{ uuid?, title, rule, repositoryId, directoryId?, path?, createdAt?, link? }] })
//   execute: async (args) => this.kodyRulesService.findMemories(...)
```

### 3. Current `ConversationAgentProvider.execute()` — What Phase 3 Replaces

```typescript
// libs/agents/infrastructure/services/kodus-flow/conversationAgent.ts:153-237
// This is the legacy path. Phase 3 replaces handleConversation() in chatWithKodyFromGit
// to call runConversationLoop instead. ConversationAgentProvider itself is NOT deleted —
// it stays as the RLLT-02 fallback path.
//
// Key behaviors to preserve in runConversationLoop:
//   - Memory bootstrap: inject KODUS_FIND_MEMORIES call instruction into systemPrompt
//   - BYOK config: fetchBYOKConfig() before model creation
//   - Language: getLanguage() to adjust system prompt locale
//   - Thread: createThreadId() deterministic ID from orgId+teamId+repoId+userId+commentId
```

### 4. `SandboxLeaseModel` — Template for `ConversationThreadModel`

```typescript
// libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model.ts:1-55
// Template: @Schema + @Prop + SchemaFactory.createForClass + index()
// Key differences for ConversationThreadModel:
//   - _id is prKey (same)
//   - NO state/leaseCount/sandboxId fields (not a coordination lease)
//   - HAS turns array with embedded sub-documents
//   - USES MongoDB TTL index on updatedAt (90 days) — safe because no external resource cleanup needed
```

### 5. `AgentLoopInput.doneToolSchema` + `initialMessages` — The Two Levers

```typescript
// libs/code-review/infrastructure/agents/llm/agent-loop.ts:749-756
/**
 * Optional done-tool schema override. When absent, defaults to
 * `_findingsSchema` (review output). Pass a custom Zod schema here to
 * drive the loop for non-review use cases (e.g., conversation reply).
 * EXT-01.
 */
doneToolSchema?: z.ZodType;
/**
 * Optional initial messages to seed multi-turn context. When absent, the
 * loop starts fresh. Messages are injected between the system prompt and
 * the first user turn: [system, ...initialMessages, user].
 * EXT-02.
 */
initialMessages?: ModelMessage[];
```

`runConversationLoop` passes `doneToolSchema: z.object({ reply: z.string() })` and `initialMessages: await sessionManager.materializeInitialMessages(prKey)`.

### 6. EXT-01/EXT-02 Test Pattern — Template for TEST-02

```typescript
// test/unit/code-review/agent-loop-extensions.spec.ts:21-151
// The jest.mock('ai') hoisting pattern replaces generateText before module init.
// For runConversationLoop tests, the same pattern applies:
//
// jest.mock('ai', () => ({ ...jest.requireActual('ai'), generateText: mockGenerateText }));
//
// Drive the loop by setting mockGenerateText.mockResolvedValue({
//     finishReason: 'tool-calls',
//     text: '',
//     toolCalls: [{ toolName: 'submitResult', args: { reply: 'Here is my answer' } }],
//     steps: [],
//     usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
//     response: { messages: [{ role: 'assistant', content: [{ type: 'tool-call', toolName: 'submitResult', args: { reply: 'Here is my answer' }, toolCallId: 'tc1' }] }] },
// });
//
// Assert: output.reply === 'Here is my answer'
// Assert: mockGenerateText.mock.calls[0][0].tools['submitResult'] is defined
// Assert: mockGenerateText.mock.calls[0][0].messages[1].role === 'assistant'  (from initialMessages)
```

### 7. Atomic `$push` Pattern — Template from `pullRequests.repository.ts`

```typescript
// libs/platformData/infrastructure/adapters/repositories/pullRequests.repository.ts:923
// Original:
const doc = await this.pullRequestsModel.findOneAndUpdate(
    { _id: pullRequest.uuid },
    { $set: updateData },
    { new: true },
);
// Adapted for appendTurn — uses $push + upsert:
await this.threadModel.findOneAndUpdate(
    { _id: prKey },
    {
        $push: { turns: turn },
        $set: { updatedAt: now },
        $setOnInsert: { createdAt: now },
    },
    { upsert: true },
);
```

---

## Open Questions — Answered

**Q1: MCP-vs-native integration — pick one.**
**Answer: Option A (Adapter).** Rationale documented in Architecture Pattern 5. Memory regression risk = zero (same `execute` path). Code complexity = ~30 lines. Token cost = no doubling. Maintainability = schema changes in `McpToolDefinition` are automatically picked up by the adapter.

**Q2: Where does `libs/conversation/` live?**
**Answer: Standalone lib at `libs/conversation/`.** Not under `libs/agents/` (which hosts the legacy path that Phase 3 replaces). Not under `libs/code-review/` (would violate MAINT-02). Standalone mirrors `libs/sandbox/` which was also extracted as a new lib in Phase 1.

**Q3: Thread persistence — reuse `pullRequestMessages` or new collection?**
**Answer: New `conversation_threads` collection.** `pullRequestMessages` stores code-review configuration templates (start/end review message content with `status`/`configLevel`/`directoryId` fields). Unrelated shape. Reuse would require polluting a config collection with chat-turn data.

**Q4: Thread message shape.**
**Answer:** `{ role: 'user' | 'assistant', content: string, timestamp: Date, toolCalls?: [...] }`. The minimum shape for multi-turn `@kody`. `toolCalls` on assistant turns are stored for observability (Phase 4) but not used in `materializeInitialMessages` (which outputs only `role + content` as `ModelMessage[]`). Tool result messages are NOT stored separately — the assistant's final text reply IS the stored turn content.

**Q5: TTL / size cap on history.**
**Answer:** 20-turn cap enforced by `materializeInitialMessages` (slice). 90-day MongoDB TTL on `updatedAt` for doc expiry. No token-count-based truncation (deterministic is better than approximate for Phase 2).

**Q6: NullSandbox detection.**
**Answer:** `sandbox.type === 'null'` from `SandboxInstance` type discriminant (`libs/sandbox/domain/contracts/sandbox.provider.ts:42`). Property-based discrimination, not instance-of. Phase 1 established this: `NULL_SANDBOX_INSTANCE.type = 'null'` at `libs/sandbox/infrastructure/providers/null-sandbox.service.ts:25`.

**Q7: `runConversationLoop` test strategy.**
**Answer:** `jest.mock('ai', ...)` exactly as in `test/unit/code-review/agent-loop-extensions.spec.ts:21-26`. Mock `generateText` to return a tool-call result with `toolName: 'submitResult'` and `args: { reply: 'text' }`. Assert `output.reply`. For `ConversationSessionManager`, use `@nestjs/mongoose` test module with `mongoose-mock` or an in-memory MongoDB (e.g., `mongodb-memory-server` — already used in `sandbox-lease-manager.spec.ts` for TEST-04).

**Q8: DI flow for Phase 3 wire-up.**
**Answer:** `ConversationModule` exports `CONVERSATION_SESSION_MANAGER_TOKEN`. Phase 3 imports `ConversationModule` (via `PlatformModule` or directly in `AgentsModule`). `ChatWithKodyFromGitUseCase` injects `CONVERSATION_SESSION_MANAGER_TOKEN` and `SANDBOX_LEASE_MANAGER_TOKEN`. `runConversationLoop` is called as a plain function (not injected). `KodyRulesToolsService` is already provided by `McpCoreModule` (which `AgentsModule` already imports).

---

## Requirement Coverage

| Requirement | Implementation Home in Phase 2 |
|-------------|-------------------------------|
| CONV-02 | `runConversationLoop` in `libs/conversation/infrastructure/services/conversation-loop.service.ts`; `doneToolSchema = z.object({ reply: z.string() })`; `initialMessages` from `ConversationSessionManager` |
| CONV-03 | Option A adapter in `libs/conversation/infrastructure/services/conversation-tools.factory.ts`; wraps `KODUS_CREATE_MEMORY` / `KODUS_FIND_MEMORIES`; same `execute` path |
| STATE-01 | `conversation_threads` Mongo collection; schema at `libs/conversation/infrastructure/repositories/schemas/conversation-thread.model.ts` |
| STATE-02 | `ConversationSessionManager.load/appendTurn/materializeInitialMessages` in `libs/conversation/infrastructure/services/conversation-session-manager.service.ts` |
| MAINT-01 | `runAgentLoop` not forked; `additionalTools` is a generic optional field; `ConversationSessionManager` is new, not a branch in existing services |
| MAINT-02 | Zero changes to `agent-loop.ts` body logic (only the generic `additionalTools` field addition), zero changes to `agent-tools.factory.ts`, zero changes to review pipeline stages |
| TEST-02 | `test/unit/conversation/run-conversation-loop.spec.ts` — `jest.mock('ai')` pattern; mock LLM + `createMockRemoteCommands()` + seeded `initialMessages`; asserts `reply` text, message history order, tool-call names |
| TEST-03 | `test/unit/conversation/memory-regression.spec.ts` — three cases: explicit remember (`@kody remember X`), implicit capture, duplicate detection (mock `KodyRulesService.createOrUpdateMemory` return `action: 'skipped'`); asserts observable output matches legacy behavior |

**Success criteria traceability:**
1. SC-1 (`runConversationLoop` with mock LLM returns text): Patterns 1 + 6 + Code Example 6.
2. SC-2 (`ConversationSessionManager` persists across two calls): Patterns 2 + 3 + 4.
3. SC-3 (Memory creation regression): Pattern 5 + TEST-03.
4. SC-4 (NullSandbox → completes without throw): Pattern 8 + Pitfall 4.
5. SC-5 (No review-side files gain conversation branches): MAINT-01/MAINT-02 + Pitfall 8.

---

## Sources

### Primary (HIGH confidence)

- `libs/code-review/infrastructure/agents/llm/agent-loop.ts:694-756` — `AgentLoopInput` interface with `doneToolSchema?` and `initialMessages?` fields; verified EXT-01/EXT-02 shipped
- `libs/code-review/infrastructure/agents/llm/agent-loop.ts:785-826` — `AgentLoopOutput` interface; `text` field confirmed
- `libs/code-review/infrastructure/agents/llm/agent-loop.ts:884-1951` — `runAgentLoop` function body; `isSelfContained`, `_seedMessages` assembly, return shape
- `libs/code-review/infrastructure/agents/llm/agent-tools.factory.ts:49-60, 129-138` — `mkTool` shape (`type: 'function'`, `inputSchema: jsonSchema(schema)`, `execute`); `buildAgentTools(remoteCommands: undefined)` returns `{}`
- `libs/mcp-server/tools/kodyRules.tools.ts:816-951` — `createMemoryRule()` → `KODUS_CREATE_MEMORY` tool; `execute` calls `IKodyRulesService.createOrUpdateMemory`
- `libs/mcp-server/tools/kodyRules.tools.ts:954-1051` — `findMemoriesRule()` → `KODUS_FIND_MEMORIES` tool; `execute` calls `IKodyRulesService.findMemories`
- `libs/mcp-server/types/mcp-tool.interface.ts:14-28` — `McpToolDefinition` interface shape; `execute` signature
- `libs/agents/infrastructure/services/kodus-flow/conversationAgent.ts:1-289` — `ConversationAgentProvider` full read; MCP adapter init, `buildPromptWithMemoryBootstrap`, `createOrchestration` pattern
- `libs/agents/application/use-cases/conversation-agent.use-case.ts:1-37` — thin use-case delegating to provider
- `libs/sandbox/domain/contracts/sandbox.provider.ts:38-53` — `SandboxInstance` with `type: 'e2b' | 'local' | 'null'` discriminant
- `libs/sandbox/infrastructure/providers/null-sandbox.service.ts:18-30` — `NULL_SANDBOX_INSTANCE.type === 'null'`
- `libs/sandbox/infrastructure/services/sandbox-lease-manager.service.ts:463-465` — `buildNullSandboxWithRelease` spreads `NULL_SANDBOX_INSTANCE`, preserving `type`
- `libs/sandbox/modules/sandbox.module.ts:1-54` — full module; `SandboxModule` pattern to mirror
- `libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model.ts:1-55` — schema template for `ConversationThreadModel`
- `libs/code-review/infrastructure/adapters/repositories/schemas/mongoose/pullRequestMessages.model.ts:1-105` — confirmed `pullRequestMessages` is code-review config (start/end message templates), not chat history; NEW collection required
- `libs/agents/modules/agents.module.ts:1-49` — `AgentsModule` already imports `McpCoreModule`; `KodyRulesToolsService` available via `McpCoreModule`
- `test/unit/code-review/agent-loop-extensions.spec.ts:1-152` — jest.mock('ai') pattern; template for TEST-02
- `test/fixtures/remote-commands.mock.ts:1-20` — `createMockRemoteCommands()` factory; confirmed for Phase 2 test use
- `libs/platform/application/use-cases/codeManagement/chatWithKodyFromGit.use-case.ts:763-784, 1810-1823` — `createThreadId` usage; `handleConversation` entry point Phase 3 will replace

### Secondary (MEDIUM confidence)

- `node_modules/@ai-sdk/provider-utils/dist/index.d.ts:980` — `ModelMessage = SystemModelMessage | UserModelMessage | AssistantModelMessage | ToolModelMessage`; `initialMessages` must use this type exactly
- `node_modules/@kodus/flow/dist/utils/thread-helpers.d.ts` — `createThreadId` returns `Thread { id: string, metadata: {} }`; confirms `@kodus/flow` Thread is NOT a message history mechanism; it's a deterministic ID for `SDKOrchestrator` state — irrelevant to `runAgentLoop`

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries confirmed in source files; no new packages needed
- `runConversationLoop` API: HIGH — directly maps to verified `AgentLoopInput` fields
- Option A adapter: HIGH — `McpToolDefinition.execute` signature verified; `mkTool` shape verified; bridging is straightforward
- `ConversationSessionManager` schema: HIGH — `SandboxLeaseModel` is a proven template
- `pullRequestMessages` rejection: HIGH — schema read directly, confirmed wrong shape
- NullSandbox detection: HIGH — `type` discriminant verified in three files
- Thread message shape: HIGH — `ModelMessage` type verified against AI SDK types

**Research date:** 2026-05-04
**Valid until:** 2026-06-04 (stable stack; Vercel AI SDK `ModelMessage` type is pinned)
