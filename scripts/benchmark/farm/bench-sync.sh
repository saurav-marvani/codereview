#!/usr/bin/env bash
# bench-sync.sh <slot> <branch>
#
# Ship a branch's SOURCE to a farm slot's droplet and (re)build the COMPILED
# stack there from docker-compose.bench.yml — Option A: build on droplet, no
# registry. Idempotent: run it again with another branch to swap the variant.
#
# What it does:
#   1. `git archive <branch>` → unpack the exact committed tree on the droplet
#      (no .git, no node_modules — those are produced by the Docker build).
#   2. ship the .env (gitignored, so not in the archive — see BENCH_ENV_FILE).
#   3. `docker compose -f docker-compose.bench.yml up -d --build` on the droplet.
#      Layer cache means only the changed `dist` recompiles on re-syncs.
#   4. wait for the API /health to go green.
#
# Tenant onboarding + webhook repoint + firing the 50 PRs are a separate step
# (see the banner printed at the end) — this script's job is "branch → running
# built stack".
#
# Usage:
#   scripts/benchmark/farm/bench-sync.sh a my-engine-experiment
#   BENCH_ENV_FILE=~/bench.env scripts/benchmark/farm/bench-sync.sh a main

set -euo pipefail
FARM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "${FARM_SCRIPT_DIR}/_farm-common.sh"

SLOT="${1:-}"
BRANCH="${2:-}"
[ -n "$SLOT" ] && [ -n "$BRANCH" ] || { err "Usage: bench-sync.sh <slot> <branch>"; exit 2; }

IP="$(farm_ip_for "$SLOT")"
NAME="$(farm_name_for "$SLOT")"
ENV_SRC="$(bench_env_file)"

# --- preflight ---
git -C "$REPO_ROOT" rev-parse --verify --quiet "$BRANCH^{commit}" >/dev/null \
    || { err "Branch '$BRANCH' not found in $REPO_ROOT"; exit 1; }
[ -f "$ENV_SRC" ] \
    || { err "Env file not found: $ENV_SRC"; err "Set BENCH_ENV_FILE to a valid .env."; exit 1; }

COMMIT="$(git -C "$REPO_ROOT" rev-parse --short "$BRANCH")"
TAG="$(normalize_name "$BRANCH")-${COMMIT}"
log "Slot '$SLOT' ($NAME at $IP) ← branch '$BRANCH' @ $COMMIT"

# --- 1. ship source (exact branch tree) ---
log "Shipping source tree…"
farm_ssh "$SLOT" "rm -rf '$REMOTE_SRC' && mkdir -p '$REMOTE_SRC'"
git -C "$REPO_ROOT" archive --format=tar "$BRANCH" \
    | farm_ssh "$SLOT" "tar -x -C '$REMOTE_SRC'"

# --- 2. ship .env (gitignored → not in archive) ---
log "Shipping env from $ENV_SRC…"
SSH_KEY="$(state_get "$NAME" .ssh_key_path)"
scp -i "$SSH_KEY" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    "$ENV_SRC" "root@${IP}:${REMOTE_SRC}/.env"

# --- 3. build + (re)start the compiled stack ---
log "Building compiled artifact + starting stack (first build ~10-15min, cached re-syncs faster)…"
farm_ssh "$SLOT" "cd '$REMOTE_SRC' && BENCH_TAG='$TAG' docker compose -f docker-compose.bench.yml up -d --build"

# --- 4. wait for API health ---
log "Waiting for API /health…"
HEALTHY=0
for i in $(seq 1 60); do
    if farm_ssh "$SLOT" "docker inspect -f '{{.State.Health.Status}}' kodus_api_bench 2>/dev/null | grep -q healthy"; then
        HEALTHY=1; break
    fi
    sleep 10
done
[ "$HEALTHY" = "1" ] || { err "API never became healthy; check: scripts/benchmark/farm/bench-status.sh $SLOT"; exit 1; }

ok "Slot '$SLOT' running branch '$BRANCH' @ $COMMIT (tag $TAG)"
cat <<EOF

  Stack is up and healthy. Webhook ingress for this slot:
      http://${IP}:${API_WEBHOOKS_PORT:-3332}

  Next (separate step — tenant + PRs):
    - onboard the benchmark tenant + repo-set, pointing webhooks at the IP above
    - fire the 50 PRs (scripts/benchmark/benchmark-suite.sh) and judge
  See scripts/benchmark/farm/README.md.
EOF
