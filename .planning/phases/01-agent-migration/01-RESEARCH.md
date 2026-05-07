# Phase 1: Foundations — Sandbox Capability + Runtime Extensibility — Research

**Researched:** 2026-04-29
**Domain:** E2B sandbox lifecycle, NestJS shared library patterns, Mongoose atomic upsert, outbox relay, `runAgentLoop` extension seams
**Confidence:** HIGH — all primary findings verified against source files, E2B SDK types, and live codebase patterns

---

## Summary

Phase 1 extracts the sandbox from `libs/code-review/` into `libs/sandbox/` and makes `runAgentLoop` generically extensible. The two bounded deliverables are: (1) a `SandboxLeaseManager` backed by Mongoose atomic upsert and a `@Cron` reaper that replaces `CreateSandboxStage`'s direct-provider calls, and (2) two optional fields — `doneToolSchema` and `initialMessages` — added to `AgentLoopInput` so the loop serves non-review callers without forking.

The codebase already has every infrastructure primitive needed. A real outbox relay exists in `libs/core/workflow/infrastructure/outbox-relay.service.ts` using `@Cron(CronExpression.EVERY_5_MINUTES)` and PostgreSQL-backed `DistributedLockService`. A `useFactory` pattern for conditional provider DI is in `libs/code-review/modules/codebase.module.ts`. Mongoose schemas and `findOneAndUpdate` with `{ upsert: true }` are used in `libs/platformData/infrastructure/adapters/repositories/pullRequests.repository.ts`. The E2B SDK at version 2.19.2 ships `SandboxLifecycle` with `onTimeout: 'pause' | 'kill'` and `autoResume?: boolean`, and `Sandbox.connect(sandboxId)` auto-resumes paused sandboxes.

**Primary recommendation:** Follow the `codebase.module.ts` `useFactory` + outbox-relay cron patterns exactly. Do not introduce new DI primitives or scheduling infrastructure.

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `e2b` | 2.19.2 (in `package.json`) | Sandbox create / connect / pause / kill | Already integrated; `Sandbox.connect()` auto-resumes from pause |
| `mongoose` | 9.6.0 | Lease collection schema + atomic upsert | Heavy existing dependency; all Mongo documents go through it |
| `@nestjs/mongoose` | 11.0.4 | `@InjectModel`, `MongooseModule.forFeature()` in the new lib module | Standard NestJS integration pattern used across every Mongo-backed lib |
| `@nestjs/schedule` | already in tree (used by `OutboxRelayService`) | `@Cron()` decorator for the lease reaper | The codebase's cron standard; no alternative used |
| `zod` | already in tree (used by `agent-loop.ts`) | `doneToolSchema` parameter type on `AgentLoopInput` | Already the schema runtime for done-tools |
| `posthog-node` (via `@libs/common/utils/posthog`) | existing | Feature-flag gating of new sandbox lifecycle | The codebase's single feature-flag client |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@nestjs/common` `@Inject` | 11.x | Token-based provider injection in `SandboxModule` | Every NestJS lib follows this |
| `ConfigService` from `@nestjs/config` | 11.x | Reading `API_E2B_KEY`, `SANDBOX_PROVIDER` env vars inside `useFactory` | Exact pattern in `codebase.module.ts:148-164` |
| `createLogger` from `@kodus/flow` | 0.1.50 | Structured logging in lease manager and reaper | All services in the codebase use this, not `winston` or `console` |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Mongoose atomic upsert | Redis SETNX | Redis is an explicit project constraint violation (no Redis); Mongo upsert is sufficient |
| `@Cron` decorator | `setInterval` polling | `setInterval` survives module destroy without cleanup; `@Cron` + `DistributedLockService` is the pattern used by OutboxRelayService for exactly this use case |
| E2B pause/resume | Manual kill + re-create | E2B pause is storage-only cost; resume is 1–3s vs 15–30s cold-start; kills are the legacy path we are explicitly replacing |

**Installation:** No new packages needed. E2B SDK, Mongoose, NestJS schedule, and Zod are already in `package.json`.

---

## Architecture Patterns

### Recommended `libs/sandbox/` Structure

Mirror `libs/code-review/modules/codebase.module.ts` for the module, and the Mongoose schema pattern from `libs/core/infrastructure/metrics/schemas/metrics-event.schema.ts` for the lease document.

```
libs/sandbox/
├── domain/
│   ├── contracts/
│   │   ├── sandbox.provider.ts          # Move ISandboxProvider, SandboxInstance, SANDBOX_PROVIDER_TOKEN here
│   │   └── sandbox-lease-manager.contract.ts  # ISandboxLeaseManager interface
│   └── interfaces/
│       └── sandbox-lease.interface.ts   # ISandboxLease (prKey, sandboxId, leaseId, acquiredAt, ttlMs, consumer)
├── infrastructure/
│   ├── providers/
│   │   ├── e2b-sandbox.service.ts       # Move from libs/code-review/…/e2bSandbox.service.ts
│   │   ├── local-sandbox.service.ts     # Move from libs/code-review/…/localSandbox.service.ts
│   │   └── null-sandbox.service.ts      # Move from libs/code-review/…/nullSandbox.service.ts
│   ├── repositories/
│   │   ├── schemas/
│   │   │   └── sandbox-lease.model.ts   # Mongoose schema + SchemaFactory
│   │   └── sandbox-lease.repository.ts  # ISandboxLeaseRepository implementation
│   └── services/
│       ├── sandbox-lease-manager.service.ts  # SandboxLeaseManager impl
│       └── sandbox-lease-reaper.service.ts   # @Cron reaper
└── modules/
    └── sandbox.module.ts                # NestJS module — exports SANDBOX_LEASE_MANAGER_TOKEN, SANDBOX_PROVIDER_TOKEN
```

`libs/code-review/` keeps re-exporting `ISandboxProvider` and `SANDBOX_PROVIDER_TOKEN` from `@libs/sandbox/domain/contracts/sandbox.provider` via a barrel re-export so that the 9 files that currently import from `@libs/code-review/domain/contracts/sandbox.provider` do not need to change paths in phase 1.

### Pattern 1: `SandboxLeaseManager` Interface (SBX-02)

```typescript
// libs/sandbox/domain/contracts/sandbox-lease-manager.contract.ts
export const SANDBOX_LEASE_MANAGER_TOKEN = Symbol('SandboxLeaseManager');

export interface ISandboxLeaseManager {
    /**
     * Acquire a lease for prKey, creating or connecting the sandbox atomically.
     * Returns a SandboxInstance and a leaseId to pass to release().
     * If E2B_API_KEY is absent, returns a NullSandbox lease.
     */
    acquire(prKey: string, consumer: string, leaseTtlMs?: number): Promise<AcquireResult>;

    /**
     * Release a lease. The sandbox stays alive (paused by idle timeout).
     * Does NOT kill or pause the sandbox — E2B's onTimeout does that.
     */
    release(leaseId: string): Promise<void>;

    /**
     * Kill the sandbox, delete the lease doc, called on PR-close or force-push.
     */
    invalidate(prKey: string): Promise<void>;
}

export interface AcquireResult {
    sandbox: SandboxInstance;  // from ISandboxProvider.createSandboxWithRepo / Sandbox.connect
    leaseId: string;
    sandboxId: string;
}
```

### Pattern 2: Mongoose Lease Schema (SBX-04)

Mirror `libs/core/infrastructure/metrics/schemas/metrics-event.schema.ts` exactly: `@Schema`, `@Prop`, `SchemaFactory.createForClass`, then compound indexes added after schema creation.

```typescript
// libs/sandbox/infrastructure/repositories/schemas/sandbox-lease.model.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

@Schema({ collection: 'sandbox_leases', timestamps: false })
export class SandboxLeaseModel extends Document {
    @Prop({ type: String, required: true })
    _id: string;           // prKey e.g. "org:repo:42" — used as the upsert filter key

    @Prop({ type: String, required: false })
    sandboxId?: string;    // E2B sandbox ID — null while state = 'CREATING'

    @Prop({ type: String, required: true, enum: ['CREATING', 'READY', 'PAUSED'] })
    state: string;

    @Prop({ type: Number, required: true })
    leaseCount: number;    // number of active leases (ref-count)

    @Prop({ type: Date, required: true })
    createdAt: Date;

    @Prop({ type: Date, required: true })
    expiresAt: Date;       // createdAt + leaseTtlMs — used by reaper TTL query
}

export const SandboxLeaseSchema = SchemaFactory.createForClass(SandboxLeaseModel);

// Unique _id + TTL expiry index for reaper
SandboxLeaseSchema.index({ expiresAt: 1 });    // reaper range scan
SandboxLeaseSchema.index({ sandboxId: 1 }, { sparse: true });  // state lookup
```

**Index choices:**
- `_id` is the prKey string — unique by MongoDB default, serves as the upsert filter.
- `expiresAt` plain ascending index — reaper queries `{ expiresAt: { $lt: now }, leaseCount: 0 }`.
- `sandboxId` sparse ascending — for `invalidate()` queries by sandboxId when prKey is unknown.
- **Do NOT** use MongoDB TTL index (`expireAfterSeconds`) — we need the reaper to decide what to do with expired leases (kill E2B sandbox first, then delete doc). Automatic TTL deletion would delete the doc before the E2B kill happens.

### Pattern 3: Atomic Acquire via `findOneAndUpdate` Upsert (SBX-04)

The real codebase example is `libs/platformData/infrastructure/adapters/repositories/pullRequests.repository.ts:923`:

```typescript
// pullRequests.repository.ts:923 — real example of findOneAndUpdate pattern
const doc = await this.pullRequestsModel.findOneAndUpdate(
    { _id: pullRequest.uuid },
    { $set: updateData },
    { new: true },
);
```

For atomic lease acquisition, adapt this with `$setOnInsert` + `upsert: true`:

```typescript
// libs/sandbox/infrastructure/repositories/sandbox-lease.repository.ts
// Source: pattern from pullRequests.repository.ts:923 + upsert variant
const now = new Date();
const expiresAt = new Date(now.getTime() + leaseTtlMs);

const doc = await this.leaseModel.findOneAndUpdate(
    { _id: prKey },
    {
        $setOnInsert: {
            state: 'CREATING',
            leaseCount: 1,
            createdAt: now,
            expiresAt,
        },
        $inc: { leaseCount: 1 },  // applied only when doc already exists
    },
    { upsert: true, new: true },
);
// If doc.state === 'CREATING' and doc.leaseCount > 1: another process is creating — poll
// If doc.state === 'READY' and doc.sandboxId: connect to existing sandbox
// If doc was just inserted (leaseCount === 1): we are the creator — call createSandboxWithRepo
```

**Note on `$setOnInsert` vs `$inc` conflict:** MongoDB applies `$setOnInsert` only on insert, and `$inc` only on update. They cannot operate on the same field. Use separate paths: `$setOnInsert` sets initial `leaseCount: 1`; `$inc: { leaseCount: 1 }` bumps on update. The implication: on insert `leaseCount` is `1`; on update `leaseCount` becomes `N+1`. Detect "we are the creator" by checking `doc.leaseCount === 1`.

### Pattern 4: E2B Pause/Resume Lifecycle Wiring (SBX-03)

In `libs/code-review/infrastructure/adapters/services/e2bSandbox.service.ts`, the two `Sandbox.create()` calls are at lines 461 and 476. Add `lifecycle` to both:

```typescript
// e2bSandbox.service.ts:461 — with template (change here):
const sandbox = await Sandbox.create(templateId, {
    timeoutMs: SANDBOX_TIMEOUT_MS,
    apiKey,
    metadata,
    lifecycle: { onTimeout: 'pause', autoResume: true },  // ADD THIS
});

// e2bSandbox.service.ts:476 — without template (change here):
const sandbox = await Sandbox.create({
    timeoutMs: SANDBOX_TIMEOUT_MS,
    apiKey,
    metadata,
    lifecycle: { onTimeout: 'pause', autoResume: true },  // ADD THIS
});
```

`SandboxOpts` (SDK type at node_modules line 6590) accepts `lifecycle?: SandboxLifecycle`. `SandboxLifecycle.autoResume` defaults to `false` — **must be set explicitly**. This is the most common pitfall: omitting `autoResume: true` means the sandbox pauses but the next `Sandbox.connect()` call gets a "sandbox is paused" error instead of auto-resuming.

For the new `SandboxLeaseManager.acquire()` connect path:

```typescript
// SDK: Sandbox.connect(sandboxId) — "If the sandbox is paused, it will be automatically resumed."
// node_modules/e2b/dist/index.d.ts:7990
const sandbox = await Sandbox.connect(sandboxId, { apiKey });
```

`SANDBOX_TIMEOUT_MS` (currently 45 minutes) remains unchanged as the ceiling. The key change is that when the pipeline finishes and the observer calls `sandbox.cleanup()`, we **no longer call `sandbox.kill()`** — instead we let the idle timeout pause it. The `cleanup()` function in the new leased path is `leaseManager.release(leaseId)`, not `sandbox.kill()`.

**Idle timeout recommendation:** Use **300,000 ms (5 minutes)** as the default idle timeout before pause. Rationale: review pipelines typically take 2–8 minutes; a 5-minute idle window allows a second `@kody` comment in the same PR to reuse a warm sandbox without paying cold-start, while not holding a live sandbox for hours. The `setTimeout(sandboxId, idleMs)` call can be issued by `SandboxLeaseManager.release()` — it adjusts the remaining TTL to `idleTimeoutMs` after the last lease is released.

### Pattern 5: Reaper Cron (SBX-04)

Template: `libs/core/infrastructure/metrics/review-response-monitor.service.ts` (uses `@Cron('*/5 * * * *')`) and `libs/core/workflow/infrastructure/outbox-relay.service.ts` (uses `@Cron(CronExpression.EVERY_5_MINUTES)` with `DistributedLockService`).

```typescript
// libs/sandbox/infrastructure/services/sandbox-lease-reaper.service.ts
@Injectable()
export class SandboxLeaseReaperService {
    @Cron(CronExpression.EVERY_5_MINUTES)
    async reapExpiredLeases(): Promise<void> {
        const lock = await this.distributedLockService.acquire(
            'CRON:SANDBOX:LEASE_REAPER',
            { ttl: 4 * 60 * 1000 },
        );
        if (!lock) return;

        try {
            const expired = await this.leaseRepository.findExpiredWithNoLeases(new Date());
            for (const lease of expired) {
                if (lease.sandboxId) {
                    await Sandbox.kill(lease.sandboxId, { apiKey: this.apiKey }).catch(() => {});
                }
                await this.leaseRepository.delete(lease._id);
            }
        } finally {
            await lock.release();
        }
    }
}
```

**Reaper cadence:** `EVERY_5_MINUTES` (same as `reclaimStaleOutbox`). Rationale: leases from crashed workers would be held at most 5 minutes before cleanup; acceptable for a low-volume coordination collection. 1-minute cadence is not needed — E2B bills by live-minute so even a 5-minute window costs <$0.01 in the worst case.

**Race-acquire polling:** Use **polling at 500ms intervals, 30-second total timeout**. Change streams add complexity and require replica set; polling over a low-cardinality lock document is cheap. When `acquire()` finds a CREATING lease it was not the creator of, it polls `findOne({ _id: prKey, state: 'READY' })` every 500ms up to 30s, then fails with a specific `SandboxCreateTimeoutError` that callers can map to self-contained mode.

### Pattern 6: Outbox Events for PR-Close and Force-Push (SBX-05)

The codebase already has a full outbox relay pipeline in `libs/core/workflow/`:
- Schema: PostgreSQL via TypeORM (`OutboxMessageModel` in `libs/core/workflow/infrastructure/repositories/schemas/outbox-message.model.ts`)
- Repository: `IOutboxMessageRepository` (`outbox-message.repository.contract.ts`)
- Relay: `OutboxRelayService.processOutbox()` publishes to RabbitMQ

For sandbox invalidation events, the simplest fit is a **dedicated lightweight outbox using RabbitMQ** (already in the stack via `@golevelup/nestjs-rabbitmq`). Webhook handlers for PR-close and force-push already call `handlePullRequest()` in the platform handlers (`libs/platform/infrastructure/webhooks/`). They extend their existing transaction to enqueue a `SandboxInvalidateEvent`:

```typescript
// Event shape — new interface
export interface SandboxInvalidateEvent {
    eventType: 'pr_closed' | 'force_push';
    prKey: string;          // "orgId:repoId:prNumber" — same key used by lease manager
    repositoryId: string;
    prNumber: number;
    timestamp: Date;
}
```

The webhook handlers write to the existing `OutboxMessageRepository.create()` (same repo, same transaction manager). The outbox relay publishes it to a new `sandbox.events` exchange. A `SandboxEventConsumerService` subscribes and calls `SandboxLeaseManager.invalidate(prKey)`.

**Alternative for simplicity:** Use `@nestjs/event-emitter` (`EventEmitter2`) in-process — the handlers emit a `SandboxInvalidateEvent` and `SandboxLeaseManager` listens. This is lighter and avoids a new RabbitMQ consumer, but is **not durable** across crashes. Given that `invalidate()` is idempotent (calling it on an already-deleted lease is a no-op) and the reaper eventually cleans up, the in-process emitter is acceptable for phase 1.

**Recommendation:** Use **`@nestjs/event-emitter` in-process** for phase 1. The reaper provides eventual consistency. Swap to durable outbox in a later phase if force-push invalidation latency becomes a problem.

**PR-closed-mid-reply:** When a `pr_closed` event arrives while a review or conversation is in-progress, the `invalidate()` call sets a `sandboxId` on a to-be-killed sandbox that active tool calls are still using. Recommendation: **soft drain** — `invalidate()` marks the lease as `INVALIDATED` in Mongo and schedules `Sandbox.kill()` after 60 seconds (using `Sandbox.setTimeout(sandboxId, 60_000)`). Active tool calls finish naturally within the remaining window; the sandbox dies at TTL. This avoids killing a sandbox under active use. Implementation: `invalidate()` calls `await Sandbox.setTimeout(sandboxId, 60_000, { apiKey })` then deletes the Mongo doc.

### Pattern 7: `libs/sandbox/` NestJS Module Wiring

The `SANDBOX_PROVIDER_TOKEN` `useFactory` pattern from `libs/code-review/modules/codebase.module.ts:147-165` is the template:

```typescript
// libs/sandbox/modules/sandbox.module.ts
@Module({
    imports: [MongooseModule.forFeature([
        { name: SandboxLeaseModel.name, schema: SandboxLeaseSchema }
    ])],
    providers: [
        {
            provide: SANDBOX_PROVIDER_TOKEN,
            useFactory: (configService: ConfigService) => {
                const provider = configService.get<string>('SANDBOX_PROVIDER') || 'auto';
                if (provider === 'local') return new LocalSandboxService(configService);
                if (provider === 'e2b' || (provider === 'auto' && configService.get('API_E2B_KEY'))) {
                    return new E2BSandboxService(configService);
                }
                return new NullSandboxProvider();
            },
            inject: [ConfigService],
        },
        {
            provide: SANDBOX_LEASE_MANAGER_TOKEN,
            useClass: SandboxLeaseManager,
        },
        SandboxLeaseRepository,
        SandboxLeaseReaperService,
    ],
    exports: [SANDBOX_PROVIDER_TOKEN, SANDBOX_LEASE_MANAGER_TOKEN],
})
export class SandboxModule {}
```

**Mongo-down behavior:** When Mongoose cannot connect or a query throws, the `acquire()` call propagates the exception. **Fail-fast** is the recommendation — do not degrade silently. The `CreateSandboxStage` already handles failure with a retry-once pattern (`create-sandbox.stage.ts:170-244`); an error from `SandboxLeaseManager` is caught at the stage level and the pipeline continues in self-contained mode. This is already the correct failure path.

### Pattern 8: `CreateSandboxStage` and `CodeReviewPipelineObserver` Refactor (SBX-01)

**Minimum-blast-radius strategy:** `CreateSandboxStage` keeps its exact external signature and stage name. It changes only its internal call from `this.sandboxProvider.createSandboxWithRepo()` to `this.leaseManager.acquire(prKey, 'review')`. The returned `AcquireResult.sandbox` is stored in `context.sandboxHandle` exactly as before. `context.sandboxHandle.cleanup` becomes `() => leaseManager.release(leaseId)` — callers see no change.

```typescript
// CreateSandboxStage BEFORE (line 119):
const sandbox = await this.sandboxProvider.createSandboxWithRepo({ ... });

// CreateSandboxStage AFTER:
const prKey = `${context.organizationAndTeamData.organizationId}:${context.repository.id}:${context.pullRequest.number}`;
const { sandbox, leaseId } = await this.leaseManager.acquire(prKey, 'review');
// sandbox.cleanup is now () => this.leaseManager.release(leaseId)
```

`CodeReviewPipelineObserver.onPipelineFinish()` (line 52) calls `context.sandboxHandle.cleanup()` unconditionally. Since cleanup is now `release()` not `kill()`, this single line change in `CreateSandboxStage` is the only observer change needed.

**DI change in `CreateSandboxStage` constructor:** Replace `@Inject(SANDBOX_PROVIDER_TOKEN) private readonly sandboxProvider: ISandboxProvider` with `@Inject(SANDBOX_LEASE_MANAGER_TOKEN) private readonly leaseManager: ISandboxLeaseManager`.

### Pattern 9: `runAgentLoop` Extension Points (EXT-01, EXT-02)

The `_findingsSchema` is defined at `agent-loop.ts:521-524`:

```typescript
// agent-loop.ts:521 — current hardcoded schema
const _findingsSchema = z.object({
    reasoning: z.string(),
    suggestions: z.array(suggestionSchema),
});
```

It is consumed at line 602 inside `buildDoneTools(model)`. The parameterization adds two optional fields to `AgentLoopInput`:

```typescript
// Add to AgentLoopInput interface (currently at agent-loop.ts:697-740):
/** Optional done-tool schema override. When absent, defaults to _findingsSchema (review behavior). */
doneToolSchema?: z.ZodType;
/** Optional initial messages to seed multi-turn context. When absent, defaults to [system, user]. */
initialMessages?: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }>;
```

`buildDoneTools()` at `agent-loop.ts:597` changes to:

```typescript
function buildDoneTools(model: unknown, doneToolSchema?: z.ZodType) {
    const strict = isGeminiModel(model);
    const schema = doneToolSchema ?? _findingsSchema;
    return {
        findings: createDoneTool(FINDINGS_TOOL_DESCRIPTION, schema, strict),
        verification: createDoneTool(VERIFICATION_TOOL_DESCRIPTION, _verificationSchema, strict),
    };
}
```

The `initialMessages` field is injected at the `messages` array construction point inside `runAgentLoop` at line ~920 (the initial `[system, user]` setup). When `input.initialMessages` is provided, the messages array becomes `[system, ...input.initialMessages, user]`.

**Zero behavior change for review:** Both fields are optional. Review callers never set them; they get exactly the current behavior.

### Pattern 10: In-Memory `RemoteCommands` Mock (TEST-01)

The `RemoteCommands` interface is defined at `libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service.ts:37-43`:

```typescript
export interface RemoteCommands {
    grep: (pattern: string, path: string, glob?: string) => Promise<string>;
    read: (path: string, start: number, end: number) => Promise<string>;
    listDir: (path: string, maxDepth: number) => Promise<string>;
    exec?: (command: string) => Promise<{ stdout: string; exitCode: number }>;
}
```

The mock needs to implement all four methods (three required, one optional). `buildAgentTools` uses `remoteCommands.exec` as a capability gate for `checkTypes` tool registration (`agent-tools.factory.ts` line ~156). The mock:

```typescript
// test/fixtures/remote-commands.mock.ts
export function createMockRemoteCommands(overrides?: Partial<RemoteCommands>): RemoteCommands {
    return {
        grep: jest.fn().mockResolvedValue(''),
        read: jest.fn().mockResolvedValue(''),
        listDir: jest.fn().mockResolvedValue(''),
        exec: jest.fn().mockResolvedValue({ stdout: '', exitCode: 0 }),
        ...overrides,
    };
}
```

To drive a multi-step exchange, override specific calls using `mockResolvedValueOnce`:

```typescript
const rc = createMockRemoteCommands({
    read: jest.fn()
        .mockResolvedValueOnce('function foo() { return 42; }')
        .mockResolvedValue(''),
});
```

This covers all tools registered by `buildAgentTools`. Tests can assert `rc.grep` was called with expected pattern/path arguments.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| E2B sandbox creation / connect | Custom HTTP client to E2B API | `Sandbox.create()` and `Sandbox.connect()` from `e2b` SDK | SDK handles auth, retries, connection state; connect auto-resumes paused sandboxes |
| E2B sandbox pause | Manual API call to pause endpoint | `lifecycle: { onTimeout: 'pause', autoResume: true }` at create time | E2B pauses on idle automatically; no polling required |
| Non-review done-tool | Fork `runAgentLoop` into `runConversationLoop` with a different schema | Pass `doneToolSchema` via `AgentLoopInput` (EXT-01) | Single source of truth; review improvements propagate free |
| Multi-turn message seeding | New message assembly function outside the loop | Pass `initialMessages` via `AgentLoopInput` (EXT-02) | Loop's context compression and `prepareStep` handles it automatically |
| Feature flag client | New `FeatureFlagService` | `posthog.isFeatureEnabled()` from `@libs/common/utils/posthog` — `FEATURE_FLAGS` object in same file | Existing client, existing pattern; adding a new flag is one line in `FEATURE_FLAGS` |
| Scheduled reaper | `setInterval` or new scheduling library | `@Cron(CronExpression.EVERY_5_MINUTES)` + `DistributedLockService.acquire()` | Exact pattern from `OutboxRelayService.reclaimStaleOutbox()` — multi-instance safe |
| Distributed locking | Redis-based mutex | `DistributedLockService` from `libs/core/workflow/infrastructure/distributed-lock.service.ts` | PostgreSQL advisory locks; already integrated; no Redis |
| Mongoose connection / schema registration | Custom MongooseModule setup | `MongooseModule.forFeature([{ name, schema }])` in `SandboxModule` | Every Mongo-backed lib does this exactly |
| Sandbox provider selection logic | New DI factory | `useFactory: (configService) => { ... }` pattern from `codebase.module.ts:147` | Already handles local/e2b/null/auto selection |
| Outbox persistence for invalidation events | Custom transactional outbox table | `IOutboxMessageRepository.create()` (existing) for durable path, or `EventEmitter2` for in-process path | Both are already in the stack; choose based on durability requirement |

---

## Common Pitfalls

### Pitfall 1: `autoResume: true` Omitted from Lifecycle Config
**What goes wrong:** `Sandbox.connect(sandboxId)` throws `"sandbox is paused"` or similar when the sandbox is in paused state but `autoResume` was not set at create time.
**Why it happens:** `autoResume` defaults to `false` per SDK docs (`node_modules/e2b/dist/index.d.ts:6502`). Omitting it means paused sandboxes cannot self-resume on connect.
**How to avoid:** Always pass `lifecycle: { onTimeout: 'pause', autoResume: true }` — both fields. Verify in the E2BSandboxService after the change by asserting both fields on the created sandbox info.
**Warning signs:** `Sandbox.connect()` throws; sandbox state query returns `"paused"` but connect fails.

### Pitfall 2: Mongo Upsert Atomicity — Read-Then-Write Outside `findOneAndUpdate`
**What goes wrong:** Two concurrent workers both read `null` (no lease exists), both decide to create, two E2B sandboxes spin up for the same PR.
**Why it happens:** Any code path that does `findOne()` → decide → `create()` or `update()` in two separate operations is not atomic.
**How to avoid:** The acquire path must be a single `findOneAndUpdate({ _id: prKey }, {...}, { upsert: true })` call. Never split it into read + write. Verified by a test driving two concurrent `acquire()` calls and asserting only one E2B create is made.
**Warning signs:** `E2BSandboxService.createSandboxWithRepo()` called twice for the same prKey in logs.

### Pitfall 3: Lease Leak from Crashed Worker
**What goes wrong:** A worker acquires a lease (`leaseCount: 1`), calls `createSandboxWithRepo`, then crashes before calling `release()`. The lease stays in Mongo with `leaseCount: 1` and `expiresAt` in the past. The reaper never fires because the query requires `leaseCount: 0`.
**Why it happens:** `leaseCount` was incremented on acquire but never decremented. The reaper only cleans up leases with `leaseCount === 0`.
**How to avoid:** The reaper query must also match leases where `expiresAt < now` regardless of `leaseCount` — or use a separate per-lease TTL doc. Recommended: query `{ expiresAt: { $lt: now } }` and kill all expired leases unconditionally. Add the crashed-worker case to the integration test suite.
**Warning signs:** `sandbox_leases` collection grows unboundedly; E2B dashboard shows orphaned running sandboxes.

### Pitfall 4: E2B Idle Timeout Set Too High Causes Unexpected Cost
**What goes wrong:** If `SANDBOX_TIMEOUT_MS` (45 minutes) is kept as the idle timeout before pause, sandboxes hold a live slot for 45 minutes of inactivity. Cost: ~$0.038 per idle sandbox per 45 minutes.
**Why it happens:** The legacy code used 45 minutes as the review-duration ceiling, not as an idle timeout. With pause/resume, the idle window should be much shorter.
**How to avoid:** After `release()`, call `Sandbox.setTimeout(sandboxId, 5 * 60 * 1000)` (5 minutes) to shrink the remaining TTL. This does not kill the sandbox — E2B pauses it after the timeout.
**Warning signs:** E2B billing unexpectedly high; sandboxes visible in E2B dashboard for >10 minutes after reviews complete.

### Pitfall 5: Race Between Outbox Invalidation and In-Flight Create
**What goes wrong:** A force-push webhook fires while `SandboxLeaseManager.acquire()` is mid-create (state = CREATING). The outbox invalidation deletes the Mongo doc. The create finishes and stores `sandboxId` into a doc that no longer exists — the sandbox is now orphaned.
**Why it happens:** The invalidation and the create are not coordinated.
**How to avoid:** `invalidate()` should check: if `state === 'CREATING'`, mark it as `INVALIDATED` in Mongo rather than deleting immediately. The create path checks for `INVALIDATED` after storing `sandboxId` and immediately kills the sandbox. Or: `invalidate()` uses a short TTL `setTimeout(sandboxId, 60_000)` — the orphaned sandbox dies in 60s automatically.
**Warning signs:** E2B dashboard shows sandboxes with no associated Mongo lease.

### Pitfall 6: Review Regression — `cleanup()` Semantics Change
**What goes wrong:** After the refactor, `context.sandboxHandle.cleanup()` calls `leaseManager.release()` instead of `sandbox.kill()`. If `release()` has a bug (e.g., leaseId is undefined), the cleanup silently does nothing and the sandbox stays live, burning cost.
**Why it happens:** The `cleanup` function pointer is now constructed by `SandboxLeaseManager.acquire()`, not by `E2BSandboxService`. Any null/undefined captured in the closure will cause a silent no-op.
**How to avoid:** `AcquireResult.sandbox.cleanup` must always be a valid function — never undefined. Add an assertion in `SandboxLeaseManager.acquire()` tests that `cleanup` is callable and that calling it decrements `leaseCount` in Mongo.
**Warning signs:** Existing review test suite passes but E2B dashboard shows sandboxes not being cleaned up; `leaseCount` > 0 after pipeline finish.

### Pitfall 7: In-Memory Mock Missing `exec` — `checkTypes` Tool Not Registered
**What goes wrong:** Test calls `buildAgentTools(rc, ...)` and expects `checkTypes` to be registered, but it isn't — because `exec` was omitted from the mock.
**Why it happens:** `agent-tools.factory.ts` gates `checkTypes` on `if (remoteCommands.exec)`. A mock without `exec` silently suppresses the tool.
**Warning signs:** Test asserts `checkTypes` was called but `rc.exec` was never invoked; `tools` object has fewer keys than expected.
**How to avoid:** Always include `exec` in the mock. Use `createMockRemoteCommands()` factory from `test/fixtures/remote-commands.mock.ts` which includes all four methods.

---

## Code Examples

### 1. Current `E2BSandboxService.createSandbox()` — Where `lifecycle` Option Goes

```typescript
// libs/code-review/infrastructure/adapters/services/e2bSandbox.service.ts:460–481
// Template path:
const sandbox = await Sandbox.create(templateId, {
    timeoutMs: SANDBOX_TIMEOUT_MS,
    apiKey,
    metadata,
    // ADD: lifecycle: { onTimeout: 'pause', autoResume: true },
});

// No-template path:
const sandbox = await Sandbox.create({
    timeoutMs: SANDBOX_TIMEOUT_MS,
    apiKey,
    metadata,
    // ADD: lifecycle: { onTimeout: 'pause', autoResume: true },
});
```

Both `Sandbox.create` overloads accept `SandboxOpts` which includes `lifecycle?: SandboxLifecycle` (SDK type at `node_modules/e2b/dist/index.d.ts:6590`).

### 2. Current `runAgentLoop` — `_findingsSchema` Hardcoding, the EXT-01 Seam

```typescript
// agent-loop.ts:521–524 — current hardcoded schema
const _findingsSchema = z.object({
    reasoning: z.string(),
    suggestions: z.array(suggestionSchema),
});

// agent-loop.ts:597–610 — buildDoneTools uses _findingsSchema directly
function buildDoneTools(model: unknown) {
    const strict = isGeminiModel(model);
    return {
        findings: createDoneTool(
            FINDINGS_TOOL_DESCRIPTION,
            _findingsSchema,  // <-- parameterize this line
            strict,
        ),
        // ...
    };
}
```

**Change:** add `doneToolSchema?: z.ZodType` to `AgentLoopInput` (interface at line 697). Pass `input.doneToolSchema ?? _findingsSchema` to `buildDoneTools`.

### 3. Current `CreateSandboxStage` Provisioning Call — Refactor Target

```typescript
// libs/code-review/pipeline/stages/create-sandbox.stage.ts:119 — current
const sandbox = await this.sandboxProvider.createSandboxWithRepo({
    cloneUrl: cloneInfo.url,
    authToken: cloneInfo.authToken,
    // ...
});

// After refactor:
const prKey = `${context.organizationAndTeamData.organizationId}:${context.repository.id}:${context.pullRequest.number}`;
const { sandbox, leaseId } = await this.leaseManager.acquire(prKey, 'review');
// sandbox.cleanup already bound to () => this.leaseManager.release(leaseId)
```

The `updateContext` call at line 143 stores `draft.sandboxHandle = sandbox` — unchanged.

### 4. Real `findOneAndUpdate` Upsert Pattern from the Codebase

```typescript
// libs/platformData/infrastructure/adapters/repositories/pullRequests.repository.ts:923
const doc = await this.pullRequestsModel.findOneAndUpdate(
    { _id: pullRequest.uuid },
    { $set: updateData },
    { new: true },
);
```

The lease acquire adapts this with `$setOnInsert` + `upsert: true`:

```typescript
// libs/sandbox/infrastructure/repositories/sandbox-lease.repository.ts
const doc = await this.leaseModel.findOneAndUpdate(
    { _id: prKey },
    {
        $setOnInsert: { state: 'CREATING', leaseCount: 1, createdAt: now, expiresAt },
    },
    { upsert: true, new: true },
);
const isCreator = doc.leaseCount === 1 && doc.state === 'CREATING';
```

### 5. Real Cron Provider Pattern — Template for the Reaper

```typescript
// libs/core/infrastructure/metrics/review-response-monitor.service.ts:50–51
@Cron('*/5 * * * *') // every 5 minutes
async checkReviewResponseTimes(): Promise<void> {
    const lock = await this.distributedLockService.acquire(
        'CRON:BETTERSTACK:REVIEW_RESPONSE_MONITOR',
        { ttl: 4 * 60 * 1000 },
    );
    if (!lock) return;

    try {
        // ... work ...
    } finally {
        await lock.release();
    }
}
```

Use `CronExpression.EVERY_5_MINUTES` (from `@nestjs/schedule`) + `DistributedLockService` for the sandbox lease reaper. Key: `ttl: 4 * 60 * 1000` (4 minutes) is less than the cron interval so a previous run's lock expires before the next cron fires.

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `Sandbox.create()` with no lifecycle | `Sandbox.create(..., { lifecycle: { onTimeout: 'pause', autoResume: true } })` | E2B SDK 2.19.2 — available now | Sandboxes pause on idle instead of dying; `Sandbox.connect()` resumes them |
| `sandbox.kill()` in observer | `leaseManager.release(leaseId)` + `Sandbox.setTimeout(sandboxId, 5m)` | Phase 1 | Sandbox stays warm for 5 minutes; next acquire reconnects in ~1–3s |
| Direct `ISandboxProvider` injection in stages | `ISandboxLeaseManager` injection in stages | Phase 1 | Stages become lifecycle-agnostic; sandbox reuse is manager's concern |
| `_findingsSchema` hardcoded in loop body | `input.doneToolSchema ?? _findingsSchema` | Phase 1 | Non-review callers can pass any Zod schema; review callers unaffected |
| No `initialMessages` support | `input.initialMessages` seeds the message array | Phase 1 | Multi-turn conversation threads possible; single-shot review unaffected |

**Deprecated / outdated in this codebase after Phase 1:**
- `libs/code-review/domain/contracts/sandbox.provider.ts` moves to `libs/sandbox/domain/contracts/` — the old path becomes a re-export barrel
- Direct `sandbox.kill()` in `E2BSandboxService.createSandboxWithRepo`'s cleanup closure — replaced by `leaseManager.release()`

---

## Requirement Coverage Checklist

| Req | Implementation Home |
|-----|---------------------|
| SBX-01 | `libs/sandbox/` module; `libs/code-review/` re-exports contracts; `CreateSandboxStage` + `CodeReviewPipelineObserver` refactored to use `ISandboxLeaseManager` |
| SBX-02 | `ISandboxLeaseManager.acquire/release/invalidate` in `libs/sandbox/domain/contracts/sandbox-lease-manager.contract.ts`; impl in `SandboxLeaseManager` |
| SBX-03 | `lifecycle: { onTimeout: 'pause', autoResume: true }` added to both `Sandbox.create()` calls in `E2BSandboxService.createSandbox()` (lines 461, 476); `Sandbox.connect()` for existing leases |
| SBX-04 | `sandbox_leases` Mongoose collection; `findOneAndUpdate` upsert atomic acquire; `SandboxLeaseReaperService` with `@Cron(EVERY_5_MINUTES)` |
| SBX-05 | `@nestjs/event-emitter` `SandboxInvalidateEvent` from PR-close/force-push handlers; `SandboxLeaseManager.invalidate()` consumer; soft-drain via `Sandbox.setTimeout` |
| SBX-06 | `useFactory` in `SandboxModule` returns `NullSandboxProvider()` when `API_E2B_KEY` absent; `AcquireResult.sandbox` is `NULL_SANDBOX_INSTANCE`; callers detect `type === 'null'` |
| EXT-01 | `doneToolSchema?: z.ZodType` added to `AgentLoopInput`; `buildDoneTools(model, input.doneToolSchema)` uses it; default `_findingsSchema` unchanged |
| EXT-02 | `initialMessages?: CoreMessage[]` added to `AgentLoopInput`; messages array becomes `[system, ...input.initialMessages, user]` when provided |
| EXT-03 | No conversation tools added to `agent-tools.factory.ts`; any future conversation tool follows the existing `mkTool` + capability-gate pattern |
| TEST-01 | `createMockRemoteCommands()` factory in `test/fixtures/remote-commands.mock.ts` covering all four `RemoteCommands` methods |
| TEST-04 | `SandboxLeaseManager` integration tests: acquire-release cycle, concurrent race (two acquires → one create), crashed-worker TTL reclaim, PR-close invalidation via event |

---

## Sources

### Primary (HIGH confidence)
- `libs/code-review/infrastructure/agents/llm/agent-loop.ts` — read directly; `_findingsSchema` at line 521, `AgentLoopInput` at line 697, `buildDoneTools` at line 597
- `libs/code-review/infrastructure/adapters/services/e2bSandbox.service.ts` — read directly; `Sandbox.create()` calls at lines 461, 476; `buildRemoteCommands()` at line 578; `cleanup` at line 118
- `libs/code-review/pipeline/stages/create-sandbox.stage.ts` — read directly; provisioning call at line 119; retry pattern at lines 170–243
- `libs/code-review/infrastructure/observers/code-review-pipeline.observer.ts` — read directly; `cleanup()` call at line 52
- `libs/code-review/domain/contracts/sandbox.provider.ts` — read directly; `ISandboxProvider`, `SandboxInstance`, `SANDBOX_PROVIDER_TOKEN`
- `libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service.ts:37-43` — `RemoteCommands` interface definition
- `node_modules/e2b/dist/index.d.ts` — `SandboxLifecycle` type at line 6494; `SandboxOpts.lifecycle` at line 6590; `Sandbox.create` signatures at lines 7921, 7936; `Sandbox.connect` at line 7990; `Sandbox.setTimeout` at line 6821
- `libs/core/workflow/infrastructure/outbox-relay.service.ts` — `@Cron(EVERY_5_MINUTES)` pattern at lines 242, 310; `DistributedLockService` acquire/release at lines 680–713
- `libs/core/infrastructure/metrics/review-response-monitor.service.ts` — `@Cron('*/5 * * * *')` template at line 50
- `libs/core/infrastructure/metrics/schemas/metrics-event.schema.ts` — Mongoose `@Schema/@Prop/SchemaFactory` pattern; compound index added after schema
- `libs/platformData/infrastructure/adapters/repositories/pullRequests.repository.ts:923` — `findOneAndUpdate` with `{ new: true }` pattern
- `libs/code-review/modules/codebase.module.ts:147-165` — `SANDBOX_PROVIDER_TOKEN` `useFactory` pattern for conditional DI
- `libs/common/utils/posthog/index.ts` — `FEATURE_FLAGS` object; `posthog.isFeatureEnabled()` signature
- `libs/code-review/pipeline/code-review-pipeline.module.ts` — full DI wiring for review pipeline
- `libs/core/workflow/domain/interfaces/outbox-message.interface.ts` — `OutboxMessage` shape
- `libs/core/workflow/domain/contracts/outbox-message.repository.contract.ts` — `IOutboxMessageRepository` contract

### Secondary (MEDIUM confidence)
- E2B pause pricing semantics: SDK docs state pause is "storage-only cost" — exact pricing numbers from REVIEW-AGENT-RUNTIME.md (estimated ~$0.000014/second running; pause is significantly cheaper)
- Poll vs change-stream recommendation: based on codebase's existing adaptive-polling pattern in `OutboxRelayService` (lines 100–178) — this codebase prefers polling over change streams

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages already in repo; no new dependencies
- Architecture (SandboxLeaseManager, schema, cron): HIGH — directly mirroring existing codebase patterns with real file references
- E2B lifecycle API: HIGH — verified against `node_modules/e2b/dist/index.d.ts`
- Outbox/invalidation: MEDIUM — EventEmitter path is proposal; durable path uses existing infra
- `runAgentLoop` extension seams: HIGH — `_findingsSchema` and `AgentLoopInput` read directly from source

**Research date:** 2026-04-29
**Valid until:** 2026-05-30 (stable stack; E2B SDK is pinned at 2.19.2)
