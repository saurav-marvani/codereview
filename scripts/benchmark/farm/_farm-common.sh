#!/usr/bin/env bash
# Shared helpers for the benchmark farm (scripts/benchmark/farm/*.sh).
#
# Builds on top of the self-hosted droplet tooling: we reuse its provider
# abstraction (droplet create/destroy), its state files, and its SSH helpers
# so the farm doesn't re-implement DigitalOcean plumbing or secret loading.
#   - droplet lifecycle  -> scripts/selfhosted/provision.sh (BENCH_BASE_ONLY=1)
#                          scripts/selfhosted/destroy.sh
#   - state + ssh + cfg  -> scripts/selfhosted/_common.sh
#
# A farm "slot" maps to a self-hosted instance named  bench-<slot>, so its
# droplet is  kodus-selfhosted-bench-<slot>  and falls under the existing
# `kodus-selfhosted-*` destroy safety prefix.

set -euo pipefail

FARM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${FARM_SCRIPT_DIR}/../../.." && pwd)"

# _common.sh resolves a fixed set of ~/.kodus-dev/config vars from 1Password on
# source, and GH_DEV_TOKEN is the one op:// ref there — so an expired `op`
# session hard-fails (exit 1) before the farm even starts. The farm doesn't use
# GH_DEV_TOKEN (it clones/opens PRs with the gh CLI token via GH_CLONE_TOKEN /
# GH_TEST_TOKEN), so pre-set it to a plain value: __resolve_op_ref only calls op
# when the value is still `op://...`, so a non-op value skips the lookup. This
# decouples the farm from the 1Password session (the DO token is already
# plaintext in config, so droplet ops never needed op either).
export GH_DEV_TOKEN="${GH_DEV_TOKEN:-$(gh auth token 2>/dev/null || echo skip-op)}"

# Pulls in: log/ok/warn/err/dim, normalize_name, state_get, state_exists,
# state_file_for, ssh_to, ssh_key_path_for, plus ~/.kodus-dev/config loading.
# shellcheck disable=SC1091
. "${REPO_ROOT}/scripts/selfhosted/_common.sh"

# Path on the droplet where the branch source is unpacked + built.
REMOTE_SRC="/opt/kodus-ai"

# Map a farm slot ("a", "perf-v2", ...) to its self-hosted instance name.
farm_name_for() {
    echo "bench-$(normalize_name "$1")"
}

# Resolve a slot's droplet IP from state, or fail with guidance.
farm_ip_for() {
    local slot="$1" name ip
    name="$(farm_name_for "$slot")"
    state_exists "$name" || {
        err "Slot '$slot' has no droplet. Create it: scripts/benchmark/farm/bench-up.sh $slot"
        return 1
    }
    ip="$(state_get "$name" .server_ip)"
    [ -n "$ip" ] || { err "Slot '$slot' state has no server_ip (provision incomplete?)"; return 1; }
    echo "$ip"
}

# Run a command on the slot's droplet over SSH (reuses _common.sh ssh_to).
farm_ssh() {
    local slot="$1"; shift
    ssh_to "$(farm_name_for "$slot")" "$@"
}

# The .env the bench stack uses on the droplet. Defaults to the developer's
# main-repo .env (gitignored, so it is NOT shipped by `git archive`). Override
# with BENCH_ENV_FILE to point at a dedicated benchmark env.
bench_env_file() {
    echo "${BENCH_ENV_FILE:-${REPO_ROOT}/.env}"
}
