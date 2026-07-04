# preview-env (experiment)

Ephemeral customer test environments for Kody — Devin / Greptile-T-Rex style.
Spin up a VM in any cloud, let an agent understand and boot the customer's
environment, run the tests, capture a reproducible playbook, kill the VM.

Cloud-agnostic by design: the VM layer is a small `VmProvider` interface
(`src/providers/types.ts`, DigitalOcean implemented, AWS/GCP/Hetzner are
extension points) — same seam as `scripts/selfhosted/provision.sh`. Everything
above it only needs SSH, so self-hosted customers can point it at their own
cloud (or, later, a bare `ssh://` target).

## Flow

```
pnpm install   # once, inside experiments/preview-env

# 1. VM up + repo cloned + customer env vars injected
pnpm run preview up --name acme --repo https://github.com/acme/api \
    --token $GH_TOKEN --env-file ./acme.env

# 2. Agent (Devin-style) explores the repo over SSH, installs toolchain,
#    starts services, runs tests, emits .kody/environment.yml
pnpm run preview detect --name acme [--hint "monorepo, tests need postgres"]

# 3. Deterministic re-run of the captured playbook (no agent, no tokens)
pnpm run preview run --name acme [--phase test]

# 4. Kill it
pnpm run preview down --name acme
```

Also: `preview status` (local state + live VMs via provider API — flags
untracked/leaked boxes), `preview ssh --name acme`, `preview exec --name acme -- <cmd>`.

## The playbook: `.kody/environment.yml`

The durable output of detection. If the customer commits it, `up` + `run`
work with zero agent involvement (config-file mode); if absent, the agent
detects and writes one (auto mode). Values of env vars never land in the
playbook — only `requiredEnv` names; values come from the `--env-file` the
customer supplies, uploaded to `/opt/kody/customer.env` (chmod 600) and
sourced into every command.

```yaml
version: 1
summary: NestJS API, needs postgres + redis
requiredEnv: [DATABASE_URL, REDIS_URL]
setup:        # toolchain + deps
  - curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
  - corepack enable && pnpm install --frozen-lockfile
services:     # backing services
  - docker compose -f docker-compose.dev.yml up -d db redis
build:
  - pnpm build
test:
  - pnpm test
```

## Safety / cost

- VM names use the `kodus-selfhosted-preview-*` prefix, so the existing TTL
  reaper (`pnpm run selfhosted:reap`, 6h TTL) sweeps anything leaked.
- `preview status` reconciles local state against the provider API and flags
  untracked droplets.
- Provisioning that fails before state is handed back destroys the droplet +
  SSH key.
- Credentials: `DIGITALOCEAN_TOKEN` and `ANTHROPIC_API_KEY` are read from
  env or `~/.kodus-dev/config` (with `op://` resolution), same precedence as
  `scripts/selfhosted/_common.sh`. Git tokens are stripped from the remote
  URL after clone and scrubbed from error output.

## Where this goes if it works

- The detection agent becomes a Kody capability (validate suggestions/PRs by
  actually running the customer's tests).
- The VM layer becomes a fourth `ISandboxProvider` (`type: 'vm'`) in
  `libs/sandbox`, so the lease manager / reaper / RemoteCommands agent tools
  work unchanged.
- `.kody/environment.yml` folds into the existing `kodus-config.yml`
  machinery (`codeBaseConfig.service.ts`) + centralized-config PR flow.
