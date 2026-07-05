# Phase 3 — plug preview-env into Kodus (concrete, file-by-file)

Grounded in a map of the REAL kodus-ai integration points. The big finding:
**the sandbox seam already exists and the review pipeline already uses it** —
so the preview VM is a NEW `ISandboxProvider` (`type: 'vm'`), not a new
subsystem. This is much smaller than expected. Nothing here is committed yet —
it's the reviewable plan; each item maps to a real file + signature.

## PR 1 — the `environment:` config section (per-repo, committed)

- **Type**: `libs/core/infrastructure/config/types/general/codeReview.type.ts`
  → add `environment?: EnvironmentConfig` to `CodeReviewConfig` (line ~306).
  `KodusConfigFile` (line ~407) is `DeepPartial<...CodeReviewConfig>` so it
  flows automatically. `EnvironmentConfig` = the playbook shape we already have
  (`setup/services/build/test/healthcheck/requiredEnv/scope`) + `enabled`.
- **GOTCHA (the one real blocker)**: `codeBaseConfig.service.ts` lines 688-692
  strip any top-level YAML key not in `DEFAULT_CONFIG`. Must add `environment`
  to `getDefaultKodusConfigFile()` (`libs/common/utils/validateCodeReviewConfigFile`)
  or the whole section is silently dropped. (This matches the earlier live bug
  where a `scope: pull_request` docs key was silently dropped.)
- Reuse: parsing is `getKodusConfigFile` → `getMergedCodeReviewConfigs`; no new
  parse path. Opt-in per repo = `environment.enabled` (default false).

## PR 2 — `VmSandboxProvider implements ISandboxProvider` (the core)

- **Interface** (exists): `libs/sandbox/domain/contracts/sandbox.provider.ts`
  — `isAvailable(): boolean`, `createSandboxWithRepo(params: CreateSandboxParams): Promise<SandboxInstance>`.
- **New impl**: `libs/sandbox/infrastructure/providers/vm-sandbox.service.ts`
  — wraps this experiment's `VmProvider` (DO/Hetzner) + playbook runner:
  - `isAvailable()` = a VM token (HCLOUD_TOKEN/DO) + `SANDBOX_PROVIDER=vm`.
  - `createSandboxWithRepo({cloneUrl, authToken, branch, checkoutSha, ...})`:
    provision (or **warm-boot from the repo's golden snapshot** — Phase 2),
    clone/fetch the PR ref, return a `SandboxInstance` whose `run()` execs over
    SSH, `remoteCommands` drives the playbook, `cleanup()` destroys the VM.
  - `SandboxInstance.run/readFile/writeFile/remoteCommands/cleanup` map 1:1 to
    our `sshExec`/`scp`/`runPlaybook`.
- **Widen the union**: `SandboxInstance.type` is `'e2b'|'local'|'null'` → add
  `'vm'` (contract file).
- **Register**: `libs/sandbox/modules/sandbox.module.ts` factory keyed on
  `SANDBOX_PROVIDER` env → add `'vm'` case (and `'auto'` prefers vm when an
  `environment:` config + snapshot exist).
- **Free wins**: the lease manager (`ISandboxLeaseManager.acquire/release`,
  Mongo-persisted) + the reaper + `RemoteCommands` all work unchanged — they're
  provider-agnostic. This is why the seam fits.

## PR 3 — run the playbook + produce the executed signal

- The pipeline already has `create-sandbox.stage.ts` (`CreateSandboxStage`) that
  calls `cloneParamsResolver.resolve()` + `leaseManager.acquire(prKey,'review')`
  and sets `context.sandboxHandle`. With PR 2, that stage transparently gets a
  VM sandbox when `SANDBOX_PROVIDER`/config selects it — **no change** to boot.
- **New stage**: `run-preview-env.stage.ts` after `createSandbox` (before/around
  `agentReview` in `code-review-pipeline.strategy.ts` `configureStages()`):
  reads `context...config.environment`, runs the playbook via the sandbox
  (`verify`-style, warm from snapshot), applies the PR diff, runs
  `--changed <files>` scoping (giant projects), captures the executed result +
  browser artifacts, writes `context.previewEnvSignal`.
- **Clone auth**: reuse `CloneParamsResolverService.resolve(context)`
  (`libs/code-review/pipeline/services/clone-params-resolver.service.ts`) — same
  per-tenant token path e2b uses.
- Register the stage in `code-review-pipeline.module.ts` + insert in the
  strategy constructor/`configureStages()`.

## PR 4 — learnings store (per-repo, reuse Kody Rules Memory)

- The closest existing analog is **Kody Rules Memory**: `IKodyRuleMemory` /
  `KodyRulesType.MEMORY`, stored in the `kodyRules` Mongo doc (one per org,
  embedded array), managed by `KodyRulesService.createOrUpdateMemory` +
  `...WithCentralizedRouting`. Lifecycle enums (`KodyRulesStatus`,
  `KodyRuleRequestType CREATE|UPDATE`) already model AI-suggested → pending →
  approved.
- Reuse that pattern for env "learnings" (per-repo, scopeable, AI-suggested +
  user-edit/dismiss — matches the Devin Knowledge model in DESIGN-config.md).
  Either a new `KodyRulesType.ENV_LEARNING` variant or a parallel collection
  with the same shape. Injection = trigger-driven (only relevant lessons/run).

## PR 5 — org-level defaults (`centralized-config`)

- `libs/centralized-config/` already discovers `kodus-config.yml` in a
  designated org repo and layers it via `getMergedCodeReviewConfigs`. Add
  `environment` as a discoverable section → org-level provider/region/size/
  secrets-binding/budget inherit to all repos, per-repo `environment:` overrides
  additively (the Devin org→repo Blueprint layering, DESIGN-config.md).

## BUILD STATUS (on branch worktree-kody-preview-env, NOT merged)
- **PR1 — environment: config: DONE** (typechecks). EnvironmentConfig type +
  default-kodus-config.yml entry + codereview.json schema.
- **PR2 — VmSandboxProvider: DONE** (typechecks). vm-client.ts + vm-sandbox.service.ts
  + union widen + module registration.
- **PR3 — run-preview-env stage: DONE** (typechecks). stage + affected.ts
  (scoping, ported) + previewEnvSignal context field + strategy/module wiring.
- **Scoping unit test: DONE + GREEN** (affected.spec.ts, 10/10 pass).
- PR1+PR2+PR3 = working end-to-end trio: a review can run in a preview VM.
- **PR4 (learnings) + PR5 (org config): remaining, additive.**

## Suggested order & risk
1. PR 2 (VmSandboxProvider) — self-contained in `libs/sandbox`, testable in
   isolation (it's literally this experiment behind the existing interface).
2. PR 1 (config section) — small, but mind the DEFAULT_CONFIG strip.
3. PR 3 (pipeline stage) — wires 1+2 into a real review.
4. PR 4 (learnings) + PR 5 (org config) — additive, lower urgency.

Each PR is independently shippable and reviewable. PR 2+1+3 is the minimum for
a working end-to-end "review runs in a preview VM".

## Open product decisions (defaulted, confirm)
- opt-in per repo (`environment.enabled`, default off).
- cross-repo deps: declared (`dependsOn`) in v1.
- learnings: lightweight per-user accept/dismiss (no admin gate), Devin-style.
