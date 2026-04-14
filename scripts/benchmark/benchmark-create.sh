#!/bin/bash
#
# Step 1: Create benchmark PRs
#
# Usage:
#   ./benchmark-create.sh <name> [TOTAL_PRS]
#
# Examples:
#   ./benchmark-create.sh sonnet-v1 20
#   ./benchmark-create.sh kimi-baseline 50
#   ./benchmark-create.sh test-run        # default: 20 PRs
#
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: ./benchmark-create.sh <name> [TOTAL_PRS]"
  echo ""
  echo "Examples:"
  echo "  ./benchmark-create.sh sonnet-v1 20"
  echo "  ./benchmark-create.sh kimi-baseline"
  echo ""
  # List existing runs
  RUNS_DIR="$(cd "$(dirname "$0")" && pwd)/runs"
  if [ -d "$RUNS_DIR" ] && [ "$(ls -A "$RUNS_DIR" 2>/dev/null)" ]; then
    echo "Existing runs:"
    for f in "$RUNS_DIR"/*.json; do
      NAME=$(basename "$f" .json)
      PRS=$(node -e "const d=JSON.parse(require('fs').readFileSync('$f','utf8')); console.log(d.prs.length + ' PRs, created ' + d.created)" 2>/dev/null || echo "?")
      echo "  $NAME — $PRS"
    done
  fi
  exit 1
fi

RUN_NAME="$1"
TOTAL_PRS=${2:-20}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUNS_DIR="$SCRIPT_DIR/runs"
BENCHMARK_OWNER="${BENCHMARK_OWNER:-Wellington01}"
mkdir -p "$RUNS_DIR"
WORKER=$(docker ps --format '{{.Names}}' | grep worker | head -1)
WORKER="${WORKER:-kodus_worker}"
BASE_ENV_FILE="${BASE_ENV_FILE:-.env}"

if [[ "$BASE_ENV_FILE" = /* ]]; then
  SOURCE_ENV_FILE="$BASE_ENV_FILE"
else
  SOURCE_ENV_FILE="$REPO_DIR/$BASE_ENV_FILE"
fi

if [ ! -f "$SOURCE_ENV_FILE" ]; then
  echo "Environment file '$SOURCE_ENV_FILE' not found"
  exit 1
fi

RUNTIME_ENV_FILE="/tmp/kodus-benchmark-${RUN_NAME}.env"

echo "============================================================"
echo "Benchmark — Create PRs"
echo "============================================================"
echo "Run: $RUN_NAME | PRs: $TOTAL_PRS"
echo "Owner: $BENCHMARK_OWNER"
echo ""

# Clean pipeline + MongoDB benchmark PRs
echo "▸ Cleaning pipeline..."
docker exec db_postgres psql -U kodusdev -d kodus_db -c \
  "DELETE FROM kodus_workflow.inbox_messages WHERE status = 'PROCESSING';" -q 2>/dev/null || true
docker exec db_postgres psql -U kodusdev -d kodus_db -c \
  "DELETE FROM kodus_workflow.outbox_messages WHERE status IN ('READY','PROCESSING','FAILED');" -q 2>/dev/null || true
docker exec rabbitmq rabbitmqctl purge_queue -p kodus-ai workflow.jobs.code_review.queue 2>/dev/null || true
docker exec rabbitmq rabbitmqctl purge_queue -p kodus-ai workflow.jobs.webhook.queue 2>/dev/null || true

# Delete ALL PRs from MongoDB to avoid stale data matching
DELETED=$(docker exec mongodb mongosh -u kodusdev -p 123456 --authenticationDatabase admin kodus_db --quiet --eval \
  "var r = db.pullRequests.deleteMany({}); print(r.deletedCount)" 2>/dev/null || echo 0)
echo "  ✓ Pipeline cleaned (removed $DELETED PRs from MongoDB)"

# Recreate worker with benchmark-specific env overrides
echo "▸ Recreating worker..."
cp "$SOURCE_ENV_FILE" "$RUNTIME_ENV_FILE"
ENV_FILE="$RUNTIME_ENV_FILE" docker compose -f "$REPO_DIR/docker-compose.dev.yml" --profile local-db up -d --force-recreate worker db_postgres db_mongodb > /dev/null
# Clear webpack cache AFTER recreate so it persists in the volume
docker exec $WORKER rm -rf /usr/src/app/node_modules/.cache/webpack 2>/dev/null || true

READY=0
for _ in $(seq 1 18); do
  INSPECT=$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$WORKER" 2>/dev/null || true)
  STATE=$(echo "$INSPECT" | awk '{print $1}')
  HEALTH=$(echo "$INSPECT" | awk '{print $2}')

  if [ "$STATE" = "running" ] && { [ "$HEALTH" = "healthy" ] || [ "$HEALTH" = "no-healthcheck" ]; }; then
    READY=1
    break
  fi

  sleep 5
done

if [ "$READY" -eq 1 ]; then
  echo "  ✓ Worker recreated and is healthy"
else
  echo "  ✗ Worker failed to become healthy after recreate"
  docker logs --since 2m $WORKER 2>&1 | tail -n 120
  exit 1
fi

# Close ALL open PRs in benchmark repos first
echo "▸ Closing all open PRs..."
for repo in sentry grafana-codex discourse-cursor cal.com keycloak; do
  OPEN_PRS=$(gh api "repos/$BENCHMARK_OWNER/$repo/pulls?state=open&per_page=100" --jq '.[].number' 2>/dev/null || true)
  for pr in $OPEN_PRS; do
    gh api "repos/$BENCHMARK_OWNER/$repo/pulls/$pr" -X PATCH -f state=closed --silent 2>/dev/null || true
  done
  COUNT=$(printf '%s' "$OPEN_PRS" | grep -c '[0-9]' 2>/dev/null || true)
  COUNT=${COUNT:-0}
  [ "$COUNT" -gt 0 ] && echo "  $repo: closed $COUNT PRs"
done
echo "  ✓ All PRs closed"

# Bump HEAD of benchmark branches so GitHub allows new PRs
# (GitHub caps at 100 PRs per identical head_sha).
# Pass TOTAL_PRS so we only bump the branches that will actually be used —
# bumping every branch in prs.json fires synchronize webhooks on orphan PRs
# from previous runs and triggers spurious reviews.
if [ "${SKIP_BUMP_HEADS:-0}" != "1" ]; then
  TOTAL_PRS="$TOTAL_PRS" "$(cd "$(dirname "$0")" && pwd)/bump-benchmark-heads.sh"
else
  echo "▸ Skipping HEAD bump (SKIP_BUMP_HEADS=1)"
fi

# Create PRs
echo "▸ Creating $TOTAL_PRS PRs..."
cd "$REPO_DIR/scripts/pr-creator"
RESULT=$(GITHUB_TOKEN=$(gh auth token) TOTAL_PRS=$TOTAL_PRS node create-test-prs.mjs 2>&1)
CREATED=$(printf '%s\n' "$RESULT" | sed -n 's/.*Total: \([0-9][0-9]*\).*/\1/p' | tail -n 1)
echo "$RESULT" | grep "✅" || true
echo "$RESULT" | grep "❌" || true
echo ""
if [ -n "$CREATED" ]; then
  echo "  ✓ PR creator reported $CREATED successful create actions"
else
  echo "  ⚠️ Could not determine PR creator summary from output"
fi

if [ -n "$CREATED" ] && [ "$CREATED" -ne "$TOTAL_PRS" ]; then
  echo "  ⚠️ PR creator summary differs from requested total ($CREATED vs $TOTAL_PRS)."
  echo "  Continuing to manifest validation because duplicated benchmark heads can collapse into fewer active PRs."
fi

# Save run manifest — maps repo/branch to PR number
cd "$REPO_DIR"
echo "▸ Building run manifest..."
node -e "
const fs = require('fs');
const { execSync } = require('child_process');

// prs.json has the real repo names (Wellington01/sentry-greptile etc.)
const prsConfig = JSON.parse(fs.readFileSync('scripts/pr-creator/prs.json', 'utf8'));
const sourcePrs = Array.isArray(prsConfig) ? prsConfig : prsConfig.prs;

// prs-benchmark.json has golden comments (matched by head branch)
const benchmark = JSON.parse(fs.readFileSync('scripts/benchmark/prs-benchmark.json', 'utf8'));
const goldenByHead = {};
for (const pr of benchmark.prs) { goldenByHead[pr.head] = pr; }

// Group by repo and distribute evenly
const byRepo = {};
for (const pr of sourcePrs) {
  const repo = pr.repo; // e.g. 'Wellington01/sentry-greptile'
  if (!byRepo[repo]) byRepo[repo] = [];
  byRepo[repo].push(pr);
}
const repos = Object.keys(byRepo);
const perRepo = Math.ceil($TOTAL_PRS / repos.length);
const selected = [];
for (const repo of repos) {
  selected.push(...byRepo[repo].slice(0, perRepo));
}
selected.splice($TOTAL_PRS);

const prs = [];
// For each selected PR, find the actual GitHub PR number by head branch
for (const spr of selected) {
  const [owner, repoName] = spr.repo.split('/');
  let ghPrs = [];
  try {
    ghPrs = JSON.parse(execSync(
      'gh api \"repos/' + owner + '/' + repoName + '/pulls?state=all&per_page=50&sort=created&direction=desc\" --jq \"[.[] | {number, head: .head.ref}]\"',
      { encoding: 'utf8', timeout: 30000 }
    ));
  } catch {}
  const match = ghPrs.find(p => p.head === spr.head);
  const golden = goldenByHead[spr.head];
  prs.push({
    repo: repoName,
    head: spr.head,
    title: spr.title || golden?.title || spr.head,
    prNumber: match ? match.number : null,
  });
  const status = match ? 'PR#' + match.number : 'NOT FOUND';
  console.log('  ' + repoName.padEnd(22) + spr.head.substring(0,35).padEnd(37) + status);
}

const manifest = {
  name: '$RUN_NAME',
  created: new Date().toISOString(),
  totalPrs: $TOTAL_PRS,
  benchmarkConfig: {},
  prs,
};

fs.writeFileSync('$RUNS_DIR/$RUN_NAME.json', JSON.stringify(manifest, null, 2));
const mapped = prs.filter(p => p.prNumber).length;
console.log('');
console.log('Manifest: scripts/benchmark/runs/$RUN_NAME.json (' + mapped + '/' + prs.length + ' mapped)');
if (mapped !== prs.length) {
  const missing = prs.filter(p => !p.prNumber).map(p => p.repo + '/' + p.head);
  console.error('');
  console.error('⚠ Not all PRs mapped: ' + missing.join(', '));
  console.error('Some PRs may not have been created. Continuing...');
}
"

echo ""
echo "Wait for reviews to finish, then run:"
echo "  ./scripts/benchmark/benchmark-evaluate.sh $RUN_NAME"
echo ""
echo "Or wait programmatically with:"
echo "  node scripts/benchmark/wait-for-run.js $RUN_NAME"
