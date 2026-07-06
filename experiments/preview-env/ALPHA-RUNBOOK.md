# Preview-env alpha — how to run it

The preview-env review is COMPLEMENTARY: it runs alongside the normal review
(e2b untouched), boots the PR in an ephemeral VM, and has an agent EXECUTE the
PR to find bugs (SSRF/IDOR, wrong DB queries, price tampering, runtime
regressions). Its findings appear as normal PR comments, each with an executed
proof block, and a `[critical]` finding gates the PR. Works in all 3 modes and
honors the `@kody` focus directive.

## 1. Enable per repo (opt-in)
In the repo's committed `kodus-config.yml`:
```yaml
version: "2.0"
environment:
  enabled: true
  requiredEnv: [DATABASE_URL, JWT_SECRET]      # names only; values from secrets
  setup:   ["curl -fsSL https://deb.nodesource.com/setup_20.x | bash -", "apt-get install -y nodejs"]
  build:   ["npm ci", "npm run migrate"]
  services:["npm start"]                        # long-running; auto-backgrounded
  test:    ["curl -fsS http://localhost:3000/api/v2/health | grep -q OK"]
  scope:                                         # giant monorepos: affected only
    affected: { tool: turbo, base: main, build: ["turbo run build --filter=...[main]"], test: ["turbo run test --filter=...[main]"] }
```
(Or let `preview detect` author it, then commit — it's still verified.)

## 2. Server config (env vars on the Kody API/worker)
- `PREVIEW_VM_TOKEN` — Hetzner (or DO) cloud token to provision VMs. (Without it the stage skips.)
- `PREVIEW_AGENT_API_KEY` (or `ANTHROPIC_API_KEY`) — LLM key for the bug-finding agent.
- `PREVIEW_AGENT_MODEL` — default `claude-sonnet-4-5`. `kimi-*` routes to the Kimi coding surface.
- `PREVIEW_VM_REGION` / `PREVIEW_VM_SIZE` — default `hil` / `cpx31`.
- `PREVIEW_ENV_SECRETS` — JSON of the app's `.env` values, keyed by repo id:
  `{"<repoId>": {"JWT_SECRET":"...","DATABASE_URL":"..."}}` (alpha; encrypted
  per-repo store is the productionization).
- `PREVIEW_SNAPSHOT_<repoId>` — optional golden-snapshot image id for warm boot.

## 3. Run it — 3 modes
- **Automatic**: open/synchronize a PR on an enabled repo → the pipeline runs
  `RunPreviewEnvStage` after agentReview; preview findings post as comments.
- **`@kody` command**: comment `@kody review` (or your review marker) → same pipeline.
- **CLI**: `kody review` → the CLI strategy now includes the stage too.

## 4. Focus
`@kody review focus on database queries` → `context.reviewDirective` is passed
to the preview agent's `<ReviewFocus>` block AND filters findings
(`applyFocus`), except reproduced `[critical]` defects always survive.

## 5. What you'll see
- Preview findings as line comments, labelled `kody_preview_env`, each ending in
  a collapsed **"✅ Reproduced by running the PR in a preview environment"**
  block with the exact command + real output.
- A `[critical]` preview finding triggers request-changes (via the existing
  `finish-process-review` gate).

## Alpha limitations (honest)
1. **Never run live in Kody yet.** All code typechecks (`tsc --noEmit`: 0 errors
   in the new files) + unit tests pass (findings mapping 7/7, strategy order
   2/2), but it has NOT executed inside a running Kody against a real PR. THAT
   smoke test is the alpha test — needs `nest build` + a booted API/worker +
   an enabled repo. This is the #1 thing to validate.
2. **Secrets** are config-based (`PREVIEW_ENV_SECRETS`), not the encrypted
   per-repo store yet.
3. **No dedup against normal findings** — preview findings are appended after
   agentReview's internal dedup, so a duplicate could appear twice (mitigated by
   the distinct label). Post-merge dedup is the follow-up.
4. **Sequential, not parallel** — runs after agentReview (adds latency), not
   concurrently. Parallelizing is an optimization.
5. **Logs/artifacts** (VM logs, agent transcript, browser video) are not yet
   persisted to a store; only `previewEnvSignal.phases[].outputTail` (2000 chars)
   is on the context. Persisting to `dataExecution` is the follow-up.

## Files (all on branch worktree-kody-preview-env, NOT merged)
- `libs/sandbox/infrastructure/services/preview-env-agent.service.ts` — ported agent.
- `libs/sandbox/infrastructure/providers/{vm-client,vm-sandbox.service,affected}.ts` — VM + scoping.
- `libs/code-review/pipeline/stages/run-preview-env.stage.ts` — the stage.
- `libs/code-review/pipeline/services/preview-env-findings.ts` — findings mapping (+ .spec).
- `environment:` in `codeReview.type.ts` + `default-kodus-config.yml` + `codereview.json`.
- Wired in `code-review-pipeline.{module,strategy}.ts` + `cli-review-pipeline.strategy.ts`.
