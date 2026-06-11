#!/usr/bin/env bash
# bench-run.sh <slot> <branch>
#
# ONE command, end to end: ensure a droplet -> build the branch's compiled
# engine -> clone a fresh per-run repo-set -> open the 50 PRs -> wait for Kody
# -> judge vs golden -> F1 -> destroy the repo-set. DETACHED: it daemonizes and
# returns immediately with a run id; track with `bench-result.sh <slot>`.
#
# Because step 2 ships YOUR local .env (BYOK + secrets) to the droplet, launch
# this YOURSELF with the `!` prefix (`! scripts/benchmark/farm/bench-run.sh a my-branch`)
# so the credential moves by your hand -- the agent can't scp it.
#
# Env:
#   BENCH_ENV_FILE   .env shipped to the droplet (default <repo>/.env)
#   BENCH_MODEL      curated model slug to benchmark (default: farm-run.ts's first)
#   BENCH_MAX_PRS    cap PRs for a cheap plumbing smoke (e.g. 2); 0 = all 50
#   BENCH_DO_SIZE    droplet size if one must be created (default s-4vcpu-8gb)
#
# Usage:
#   ! scripts/benchmark/farm/bench-run.sh a my-engine-experiment

set -euo pipefail
FARM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
. "${FARM_SCRIPT_DIR}/_farm-common.sh"

SLOT="${1:-}"
BRANCH="${2:-}"
[ -n "$SLOT" ] && [ -n "$BRANCH" ] || { err "Usage: bench-run.sh <slot> <branch>"; exit 2; }

RESULTS_ROOT="${FARM_SCRIPT_DIR}/results"
E2E_DIR="${REPO_ROOT}/tests/e2e"
# GitHub tokens:
#  - GH_TEST_TOKEN  (bot) opens PRs in farm-run.ts — avoids abuse-flagging your
#    personal account on a 50-PR burst.
#  - GH_CLONE_TOKEN must have the `workflow` scope (the dataset branches carry
#    .github/workflows/* files that GitHub refuses to push otherwise). The e2e
#    bot token usually lacks it, so default to your gh CLI token here.
export GH_TEST_TOKEN="${GH_TEST_TOKEN:-${GH_DEV_TOKEN:-$(gh auth token 2>/dev/null || true)}}"
export GH_CLONE_TOKEN="${GH_CLONE_TOKEN:-$(gh auth token 2>/dev/null || true)}"

# ---- foreground: stamp a run id, daemonize, return ----
if [ "${BENCH_RUN_BG:-0}" != "1" ]; then
    RUN_ID="$(normalize_name "${SLOT}")-$(date +%Y%m%d-%H%M%S)"
    RUNDIR="${RESULTS_ROOT}/${RUN_ID}"
    mkdir -p "$RUNDIR"
    echo "$BRANCH" > "${RUNDIR}/branch"
    echo "queued"  > "${RUNDIR}/status"
    # Record this as the slot's latest run so bench-result.sh <slot> finds it.
    ln -sfn "$RUN_ID" "${RESULTS_ROOT}/${SLOT}-latest"
    BENCH_RUN_BG=1 FARM_RUN_ID="$RUN_ID" nohup bash "$0" "$SLOT" "$BRANCH" \
        >"${RUNDIR}/run.log" 2>&1 &
    ok "Launched run '${RUN_ID}' (pid $!)"
    dim "  track:   scripts/benchmark/farm/bench-result.sh ${SLOT}"
    dim "  log:     ${RUNDIR}/run.log"
    exit 0
fi

# ---- background worker ----
RUN_ID="${FARM_RUN_ID}"
RUNDIR="${RESULTS_ROOT}/${RUN_ID}"
set_status() { echo "$1" > "${RUNDIR}/status"; log "[${RUN_ID}] phase: $1"; }
fail() { echo "failed: $1" > "${RUNDIR}/status"; err "[${RUN_ID}] FAILED at $1"; exit 1; }

trap 'fail "${CURRENT_PHASE:-unknown}"' ERR

CURRENT_PHASE="droplet"; set_status droplet
if ! state_exists "$(farm_name_for "$SLOT")"; then
    bash "${FARM_SCRIPT_DIR}/bench-up.sh" "$SLOT"
fi

CURRENT_PHASE="build"; set_status build
bash "${FARM_SCRIPT_DIR}/bench-sync.sh" "$SLOT" "$BRANCH"

IP="$(farm_ip_for "$SLOT")"

# tests/e2e is a self-contained npm project (its own node_modules: tsx, undici,
# zod…). On a Docker-only host (no root node_modules) it must be installed once,
# same as scripts/e2e/run.sh does. tsx then resolves from tests/e2e/node_modules.
CURRENT_PHASE="deps"; set_status deps
( cd "$E2E_DIR" && [ -d node_modules ] || npm install --silent )

CURRENT_PHASE="clone"; set_status clone
( cd "$E2E_DIR" && FARM_RUN_ID="$RUN_ID" npx tsx benchmark/clone-run-repos.ts )

CURRENT_PHASE="review"; set_status review
( cd "$E2E_DIR" && FARM_RUN_ID="$RUN_ID" FARM_WEB_BASE_URL="http://${IP}:${WEB_PORT:-3000}" \
    FARM_MODEL_SLUG="${BENCH_MODEL:-}" FARM_MAX_PRS="${BENCH_MAX_PRS:-0}" npx tsx benchmark/farm-run.ts )

CURRENT_PHASE="judge"; set_status judge
( cd "$E2E_DIR" && SCORECARD_RESULTS="${E2E_DIR}/benchmark/results-farm-${RUN_ID}.json" \
    SCORECARD_OUT="${RUNDIR}/scorecard.json" npx tsx benchmark/scorecard.ts )
# Surface the headline F1 next to the run for bench-result.sh.
cp "${E2E_DIR}/benchmark/results-farm-${RUN_ID}.json" "${RUNDIR}/results.json" 2>/dev/null || true

CURRENT_PHASE="cleanup"; set_status cleanup
( cd "$E2E_DIR" && FARM_RUN_ID="$RUN_ID" npx tsx benchmark/clone-run-repos.ts --destroy ) || \
    warn "[${RUN_ID}] repo-set cleanup failed -- orphan kodus-e2e/*-${RUN_ID} may remain"

trap - ERR
set_status done
ok "[${RUN_ID}] done -- scorecard: ${RUNDIR}/scorecard.json"
