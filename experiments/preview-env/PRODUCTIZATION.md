# Preview-env → Kody: productization plan

Synthesis of the preview-env experiment (14 loop iterations). The thesis is
**proven end-to-end on both axes plus the integration frontier**; what remains
is folding it into Kody and a few hands-on hardening items.

## The two axes (keep them separate)

1. **Environment** — give Kody a live, reproducible machine of the customer's
   project where a PR can actually run.
2. **Judgment** — given that machine, find bugs / security / perf / broken
   business rules by EXERCISING the code, not reading it.

The environment's job is to produce a **trustworthy, executed signal**. The
judgment layer (Kody's reviewer) consumes that signal. The whole experiment's
north star: **trust comes from execution, never from the model's word** — the
agent fabricated verification 3× and only deterministic replay / the service's
own log caught it.

## What's proven (commands shipped in this experiment)

`preview up | detect | run | verify | harden | validate | diagnose | artifacts | exec | ssh | status | down | learn`

- **detect** — Devin-style agent learns to build/boot the repo, emits
  `.kody/environment.yml` (playbook) + accumulates lessons (global +
  per-project). Booted kutt, uptime-kuma (UI), n8n (monorepo), and **Kodus
  itself** (PG+Mongo+RabbitMQ).
- **verify** — provisions a FRESH VM and replays the playbook from zero;
  the only reliable way to catch a playbook that depends on ambient detection
  state. PROVEN GREEN (kutt, 15 commands).
- **harden** — auto-fix loop: reset → replay → patch-fix → re-verify until it
  reproduces from zero. PROVEN GREEN (HARDEN SUCCEEDED). Patch-based fixer
  (single-command edits, phase-aware, package.json-script-guarded).
- **validate** — the security/PR reviewer: diff-only + **redacted PR metadata**
  + **execution-mandatory** + **harness bounce** + **pre-seeded fixtures**.
  Caught SSRF and IDOR **by execution** (framed reviewer missed both).
- Learning loop: lessons injected into every run; per-project scoping.
- **Integrations via local fakes**: email→Mailpit proven (signup → real
  verification email asserted in Mailpit). Pattern: S3→MinIO, AWS→LocalStack,
  GitHub→Gitea, OAuth→Keycloak, Stripe→stripe-mock.

## Hard-won lessons (baked into the code/prompts)

- Trust from execution, not the model's claim (fabricated jest flag, fake
  `/health` endpoint, "todo" repros — all caught by replay).
- Author-framing bias is measured & exploitable (−16–93pp vuln detection);
  fix = withhold PR metadata, force diff-only (empirical: +94% recovery).
- Prompt-requested execution degrades on hard exploits → harness must ENFORCE
  (bounce unexecuted findings; pre-seed multi-principal fixtures).
- From-zero reproducibility needs a truly clean VM (uncaptured prereqs like
  pnpm; spurious host builds for docker apps); the auto-replay gate forces it.
- Instrument before chasing: one service-log dump found in 1 run what 10 blind
  VM runs missed (kutt exited on missing JWT_SECRET — harden just needed
  `--env-file`).
- setsid (not nohup) for services, redirect OUTSIDE `bash -c` or the ssh exec
  hangs.

## Fold into Kody

- **Playbook** → a `environment:` section of the existing `kodus-config.yml`
  (`codeBaseConfig.service.ts` already reads committed config). Customers can
  author it (Devin-Playbook-style) OR let detect emit it; either way it's still
  verified by `verify` (guidance-but-verified trust model).
- **VM layer** → a 4th `ISandboxProvider` (`type: 'vm'`) in `libs/sandbox`, so
  the lease manager / reaper / RemoteCommands agent tools work unchanged.
- **Credentials** → reuse `CloneParamsResolverService` + `CodeManagementService`
  for per-tenant tokens; customer secrets via their store (self-hosted).
- **Reviewer** → Kody's real review brain replaces the stand-in `validate`
  agent, consuming the executed signal + the redacted-security-pass output.

## Progress (autonomous productization loop)

- **Phase 0 — Devin research + config design: DONE.** `DESIGN-config.md`,
  grounded in a documented deep-research of Devin's env model (layered
  Blueprints org→repo, org snapshot, scopeable Knowledge).
- **Phase 1 — generalization: DONE.** detect succeeds on Go (gophish) + Python
  Django (wagtail); harden converges on Django/docker-compose too. Both halves
  generalize across languages. (Rails/mastodon bailed — too heavy, unrepresentative.)
- **Phase 2 — snapshots: DONE + PROVEN.** `preview snapshot` + `up --image`;
  live: cold 103s vs warm 48s with deps baked. The warm-boot lever works.

## Remaining (Phase 3 — USER-GATED, touches live Kodus code)

1. `environment:` section parser in `codeBaseConfig.service.ts` (per-repo).
2. `ISandboxProvider` `type: 'vm'` in `libs/sandbox` (the VM layer).
3. Per-repo learnings store (reuse kody-rules plumbing) + UI surface.
4. Org blueprint (provider/secrets/budget) in `centralized-config` + UI.
5. Kody's real reviewer consumes the executed signal.

## Smaller follow-ups
- Component scoping (turbo/nx `--filter` + path→component map).
- Integration coverage matrix (`integrations: {github: gitea|replay}`) + honest
  coverage reporting. (email→Mailpit already proven.)
- Auto-discovery of cross-repo deps (v2; declared `dependsOn` ships in v1).
