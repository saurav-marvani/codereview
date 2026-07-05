# Preview-env config model for Kodus (grounded in Devin's documented model)

Deep-research on Devin's environment model (docs.devin.ai, high-confidence,
documented) settled the org-vs-repo question. This is the Kodus design mapped
to it. **Every claim about Devin below is documented** unless marked inferred.

## Devin's model (documented) — what to copy

- **Snapshot** = a frozen, bootable VM image capturing cloned repos + toolchain
  + resolved deps + env vars/shell + **startup commands** + browser cookies.
  Every session boots a FRESH copy; session changes are discarded. (Setup once,
  reuse warm.)
- **Config is layered Blueprints (declarative YAML): enterprise → org → repo**,
  ADDITIVE (a repo blueprint uses tools the org blueprint installed; lower
  levels can't override higher). Org holds shared runtimes/tools/**secrets**;
  repo holds project setup (install / lint / test / run).
- **Snapshot is ORG-scoped**: each org has exactly ONE active snapshot; multiple
  repos co-exist on it; it rebuilds **automatically only when config changes**
  (never per session). A build runs the blueprints in order and clones up to 10
  configured repos concurrently into the one snapshot.
- **Secrets**: defined ONCE at org level, auto-retrieved per session, session-
  scopable, revocable.
- **Repo onboarding**: an 8-step wizard (Git Pull, Configure Secrets, Install
  Deps, Maintain Deps, Set up Lint, Set up Tests, Run Local App, Notes) →
  Finish Setup replays the commands to build the snapshot.
- **Knowledge**: scopeable no-repo / specific-repo / all-repos; trigger-driven
  (pulled when relevant, not all upfront); BOTH user-authored AND AI-suggested;
  reviewed lightly (edit / dismiss / regenerate) — **no heavy admin approval
  gate**, just per-user accept-by-saving.
- **Cross-repo**: handled by cloning multiple DECLARED repos into the one
  snapshot (not auto-discovered).

## Kodus design (maps 1:1 onto what Kodus already has)

Kodus already has org-level settings + a per-repo committed `kodus-config.yml`
(read by `codeBaseConfig.service.ts`) + `centralized-config` (DB↔repo sync).
So the layered model drops in cleanly.

### Config layers (= Blueprints)
1. **Org blueprint** (Kodus UI / `centralized-config`, DB): cloud provider +
   region + VM size, the **secrets store binding** (LLM keys, registry creds),
   shared runtimes/base image, budget/TTL. One place, all repos inherit.
2. **Repo blueprint** = a `environment:` section in the committed
   `kodus-config.yml` (the artifact my `detect` emits and `verify` proves).
   Additive on the org layer. Fields:
   ```yaml
   environment:
     requiredEnv: [DATABASE_URL, JWT_SECRET, ...]   # names only; values from org secrets store
     setup: [...]        # toolchain/prereqs (capture pnpm/uv/go, etc.)
     services: [...]     # docker compose up / DB / queue (setsid-wrapped)
     build: [...]
     test: [...]
     healthcheck: [...]
     dependsOn:          # cross-repo (DECLARED, Devin-style)
       - repo: org/shared-lib
         ref: main
     scope:              # monorepo: only build/test affected components
       components:
         backend: { paths: [packages/api/**], build: [...], test: [...] }
   ```
   `detect` generates it; the customer can edit it; whatever they edit is still
   run through `verify` (guidance-but-verified).

### Snapshots (the "easy/fast" lever — the big remaining build)
- **Per-repo golden snapshot** (Kodus choice vs Devin's one-org-machine):
  `detect → verify → snapshot`. For a REVIEW product that runs one PR at a
  time, a per-repo golden image + a fresh VM per PR is cleaner isolation than
  Devin's shared org machine; the snapshot primitive is the same.
  (Devin's shared-machine model is better ONLY when many repos genuinely
  cross-depend — then co-locate them in one snapshot; our `dependsOn` covers
  that by cloning the deps into the snapshot.)
- **Warm boot per PR** = restore snapshot + startup delta (`git fetch` the PR
  ref + apply diff + incremental install) — the Devin "startup commands"
  pattern. Seconds, not a 10-min rebuild.
- **Rebuild trigger** (Devin-style, automatic): rebuild the snapshot only when
  the config/lockfile/base changes (dep lockfile hash, `environment:` edit,
  base-image bump) — NOT per PR.

### Learnings (= Knowledge)
- **Per-repo** (default) + **all-repos** (org) scope, in the DB (Mongo).
- **AI-suggested + user-editable**, lightweight accept/dismiss (copy Devin —
  NOT a heavy approval workflow; my earlier "approval gate" instinct was
  heavier than Devin, correct to lighten). Reuse the kody-rules
  origin/lifecycle plumbing for storage, but with per-user accept, not admin
  gating.
- Trigger-driven injection (only the relevant lessons per run), not all upfront.

### Cross-repo & monorepo
- **Cross-repo**: `dependsOn` in the repo blueprint (DECLARED, like Devin) →
  the env layer clones + builds those repos into the snapshot. Auto-discovery
  (agent sees an internal `@org/x` dep and clones its repo) is a v2 nicety.
- **Monorepo**: ONE environment for the whole repo; `scope.components`
  (path→build/test map, turbo/nx `--filter`) decides what runs per PR.

## Recommended splits (the product decisions)
- **Config**: **opt-in per repo** (customer enables where they want) with
  org-level defaults — matches Devin (repos are explicitly onboarded) and is
  safer than auto-onboarding every repo.
- **Cross-repo**: **declared** (`dependsOn`) in v1; auto-discovery v2.
- **Learnings**: per-repo + all-repos scope, AI-suggested + user-edit/dismiss,
  DB-stored, lightweight (no admin approval).

## What Kodus already has to build on
- `codeBaseConfig.service.ts` — reads committed `kodus-config.yml` → add the
  `environment:` section parser.
- `centralized-config` — org↔repo config sync → the org blueprint + UI.
- `libs/sandbox` `ISandboxProvider` — add `type: 'vm'` (this experiment's VM
  layer) so lease manager / reaper / RemoteCommands work unchanged.
- `CloneParamsResolverService` — per-tenant clone tokens (incl. `dependsOn`
  repos).
- kody-rules origin/lifecycle plumbing — reuse for the learnings store.
