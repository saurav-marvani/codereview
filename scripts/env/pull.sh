#!/usr/bin/env bash
# Materialize .env from .env.template by resolving 1Password refs (op://...).
#
# Usage:
#   pnpm run env:pull              # writes ./.env, backing up any existing file
#   pnpm run env:pull --force      # overwrites without backup
#   pnpm run env:pull --check      # validates auth + template; writes nothing
#
# Requirements:
#   - 1Password CLI (`op`) installed and signed in
#     macOS:  brew install 1password-cli
#             For zero-friction signin, enable "Connect with 1Password CLI"
#             in 1Password app → Settings → Developer.
#   - Membership in the "Kodus Dev" 1Password vault.
#
# First-time setup: scripts/env/README.md (section: Pulling values from 1Password)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEMPLATE="${REPO_ROOT}/.env.template"
OUTPUT="${REPO_ROOT}/.env"
VAULT="Kodus-Dev"

FORCE=0
CHECK_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        --check) CHECK_ONLY=1 ;;
        -h|--help)
            sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "Unknown arg: $arg" >&2
            exit 2
            ;;
    esac
done

# ── Preflight ────────────────────────────────────────────────────────────────

if ! command -v op >/dev/null 2>&1; then
    cat >&2 <<EOF
error: 1Password CLI (op) not installed.

  macOS:  brew install 1password-cli
  other:  https://developer.1password.com/docs/cli/get-started

Then enable "Integrate with 1Password CLI" in the 1Password desktop app
(Settings → Developer) — this is the zero-signin path most of the team uses.
EOF
    exit 1
fi

# `op whoami` returns non-zero under desktop biometric integration (no
# persistent session token — each call prompts). So we check auth
# implicitly via a lightweight vault read: if it works, we're
# authenticated AND the vault is reachable. If it fails, we can't tell
# which is which, so we print both possibilities.
if ! op vault get "$VAULT" >/dev/null 2>&1; then
    cat >&2 <<EOF
error: cannot read the "$VAULT" 1Password vault.

Either:
  - The op CLI isn't signed in. If you have the desktop app, open it and
    make sure "Integrate with 1Password CLI" is enabled (Settings → Developer).
    Otherwise: op signin
  - Or your account doesn't have access to the "$VAULT" vault. Ask an
    admin to add you.

Then re-run: pnpm run env:pull
EOF
    exit 1
fi

if [[ ! -f "$TEMPLATE" ]]; then
    echo "error: $TEMPLATE not found. Run \`pnpm run env:apply\` to regenerate it from .env.schema." >&2
    exit 1
fi

if [[ "$CHECK_ONLY" -eq 1 ]]; then
    echo "ok: op CLI signed in, \"$VAULT\" vault accessible, .env.template present."
    exit 0
fi

# ── Materialize ──────────────────────────────────────────────────────────────

if [[ -f "$OUTPUT" && "$FORCE" -eq 0 ]]; then
    BACKUP="${OUTPUT}.bak.$(date +%Y%m%d-%H%M%S)"
    mv "$OUTPUT" "$BACKUP"
    echo "backed up existing .env → $(basename "$BACKUP")"
fi

# `op inject` resolves every op://... ref and writes the result. Any
# unresolved ref (missing item/field) becomes a hard error and we exit
# non-zero so the dev sees what's missing instead of a half-broken .env.
#
# Inject to a temp file first, validate it, then move into place — so a
# malformed value never lands as the active .env (see the guard below).
TMP="${OUTPUT}.tmp.$$"
trap 'rm -f "$TMP"' EXIT
op inject --in-file "$TEMPLATE" --out-file "$TMP" --force

# ── Guard: no raw newlines inside values ──────────────────────────────────────
#
# `docker compose` reads .env via `env_file:`, and its parser does NOT
# support multi-line values. A secret stored in 1Password with literal
# newlines (e.g. a raw multi-line PEM private key) injects as a value
# spanning several physical lines — which leaves a dangling quote and
# makes compose choke with a cryptic "unexpected character in variable
# name" error on some *later* line. We catch it here with a clear message
# instead. Multi-line secrets must be stored single-line with `\n`
# escapes; the app un-escapes them at read time (see github.service.ts).
#
# A continuation line is any non-blank line that is neither a comment nor
# a `KEY=` assignment — i.e. the overflow of a multi-line value.
OFFENDER="$(awk '
    /^[A-Za-z_][A-Za-z0-9_]*=/ { key=$0; sub(/=.*/, "", key); next }
    /^[[:space:]]*$/ || /^[[:space:]]*#/ { next }
    { print key; exit }
' "$TMP")"

if [[ -n "$OFFENDER" ]]; then
    cat >&2 <<EOF
error: the value for "$OFFENDER" contains a raw newline.

The 1Password item "$OFFENDER" holds a multi-line value. \`docker compose\`
cannot parse multi-line values in an env file, so the resulting .env would
break the whole stack.

Fix the vault item to be single-line with escaped newlines:

  # turn a PEM (or any multi-line secret) into one line with \\n
  awk 'NR>1{printf "\\\\n"} {printf "%s", \$0}' key.pem | \\
    op item edit "$OFFENDER" --vault "$VAULT" "password=-"

The app un-escapes \\n at read time (see github.service.ts). Then re-run
\`pnpm run env:pull\`. The malformed .env was NOT written.
EOF
    exit 1
fi

mv "$TMP" "$OUTPUT"
trap - EXIT

echo "wrote $OUTPUT from .env.template (vault: $VAULT)"
