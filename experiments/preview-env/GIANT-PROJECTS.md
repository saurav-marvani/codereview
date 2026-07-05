# Giant projects (huge monorepos) — the scaling design

The whole approach so far assumed a repo you can build+test end-to-end per PR.
A giant monorepo (n8n, or Kodus itself, or an enterprise 500-package repo)
breaks that: a full `pnpm build` + full test suite is 20–60 min and GBs of
output — infeasible per PR. Three problems, three answers.

## Problem 1 — you can't build/test everything per PR → SCOPING

**Answer: build/test only the slice the PR affects.** Implemented as a
`scope` block in the playbook + `preview run --changed <files> --base <ref>`
(`src/affected.ts`). Two modes:

- **affected (preferred)** — delegate to the monorepo tool's own affected
  graph, the only thing that scales without a hand-kept map:
  ```yaml
  scope:
    affected:
      tool: turbo
      base: origin/main
      build: ["turbo run build --filter=...[{base}]"]   # {base} substituted
      test:  ["turbo run test  --filter=...[{base}]"]
  ```
  `...[base]` = the changed packages AND everything that depends on them —
  correct blast radius, computed by turbo/nx/pnpm from the git diff.
- **components (fallback)** — a declared path→component map for repos with no
  affected-aware tool:
  ```yaml
  scope:
    components:
      - { name: backend, paths: [packages/cli/**, packages/core/**], build: [...], test: [...] }
      - { name: ui,      paths: [packages/editor-ui/**],             build: [...], test: [...] }
  ```
  Union every component a changed file touches; run only those. No match →
  fall back to the full phases (safe default).

`run` without `--changed` still runs everything (onboarding / snapshot build);
`--changed` only narrows per-PR.

## Problem 2 — the full build is too slow to do per PR → SNAPSHOTS do it ONCE

Scoping alone isn't enough: even the affected slice needs the rest of the repo
BUILT to link against. The **golden snapshot** (Phase 2) is what makes scoping
viable: the expensive full `pnpm build` + all deps happen ONCE into the
snapshot; every PR warm-boots from it (48s, deps baked) and rebuilds ONLY the
affected slice on top. Snapshots + scoping are the same solution to giant
projects — one amortizes the world, the other narrows the per-PR delta.
Rebuild the snapshot only when the lockfile / base changes (Devin-style).

## Problem 3 — detection bails on a huge repo → CONFIG-FIRST for giants

The detect agent bails when a repo is too big to explore (observed live:
mastodon bailed in 4 turns). Giant repos should be **config-first**, not
auto-detected exhaustively:
- The customer authors the `environment:` + `scope:` (they know their monorepo
  and its packages) — the Devin "onboard a repo" wizard, not blind detection.
- detect's job on a giant repo shrinks to: identify the toolchain + the
  affected command (turbo/nx/pnpm present?) + the lockfile — NOT explore every
  package. A focused, bounded detection.
- Whatever is authored/detected is still run through `verify`/`harden`
  (guidance-but-verified) — on a snapshot so it's fast.

## Also: cross-package test selection & timeouts
- Cap per-phase time; a giant test suite needs the affected filter to stay
  under budget (this is why scoping is mandatory, not optional, for giants).
- `dependsOn` (cross-repo) composes: a giant multi-repo product clones its
  declared sibling repos into the one snapshot (Devin clones up to 10).

## Measured on n8n (real 70-package turbo monorepo, live)

Blast radius — how many of the 70 build tasks a change to package X forces
(`turbo build --filter=X...`, i.e. X + everything depending on it):

| change in            | rebuilds | % of repo |
|----------------------|----------|-----------|
| `@n8n/di` (util leaf)| 4 / 70   | 6%        |
| `@n8n/config`        | 6 / 70   | 9%        |
| `@n8n/design-system` | 11 / 70  | 16%       |
| `n8n-workflow` (core)| 14 / 70  | 20%       |
| `n8n-core`           | 24 / 70  | 34%       |
| `n8n-nodes-base`     | 27 / 70  | 39%       |
| `n8n` (top-level app)| 54 / 70  | 77%       |

Takeaway: most PRs touch leaf/feature packages → **~4–14 of 70 rebuild
(~85–90% skipped)**. Scoping's payoff is large and real, and it scales
INVERSELY with how deep in the dep graph the change is. It also isolates
unrelated breakage: n8n's full build currently FAILS on `@n8n/n8n-extension-insights`
(a leaf nobody depends on) — a PR that doesn't touch it builds+passes green
under scoping while the full build is red.

## Implementation refinement (from the live test)

turbo's `--filter=...[{base}]` git-affected detection returned 0 on the VM
(needs an SCM base configured). The robust approach: **compute the affected
packages ourselves** — map each changed file to its owning package (nearest
`package.json` walking up), then run `--filter=<pkg>...` per owning package
(pkg + dependents). This doesn't depend on the tool's SCM setup and is what
production should do. The `affected` mode command should therefore be templated
with `{filters}` (filled with `--filter=pkgA... --filter=pkgB...`) rather than
`{base}`, OR use the declared `components` map. `resolveScopedRun` already
supports both modes; the file→package derivation is the v1 production hookup.

## Status
- `scope` schema + `resolveScopedRun` (affected + components modes) implemented
  and unit-tested (glob match, {base} substitution, union, fallback-to-full).
- `run --changed` wired. Blast radius measured live on n8n (above) — scoping
  proven to skip ~85-90% of a 70-package monorepo for typical PRs.
