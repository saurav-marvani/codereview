#!/usr/bin/env bash
# Destroys a persistent self-hosted dev stack provisioned via provision.sh.
#
# Usage:
#   yarn selfhosted:destroy                   # destroys default instance
#   yarn selfhosted:destroy --name wellington # named instance

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# _common.sh loads ~/.kodus-dev/config + scripts/selfhosted/.env in the
# right priority order. Don't duplicate that here.
# shellcheck disable=SC1091
. "$SCRIPT_DIR/_common.sh"

NAME_RAW="default"
ASSUME_YES=0
while [ $# -gt 0 ]; do
    case "$1" in
        --name) NAME_RAW="$2"; shift 2 ;;
        --name=*) NAME_RAW="${1#--name=}"; shift ;;
        -y|--yes) ASSUME_YES=1; shift ;;
        -h|--help)
            grep -E '^#( |$)' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        *) err "Unknown arg: $1"; exit 2 ;;
    esac
done
NAME=$(normalize_name "$NAME_RAW")

if ! state_exists "$NAME"; then
    warn "No state file for instance '$NAME'."
    warn "Either nothing to destroy, or you provisioned it elsewhere."
    warn "Active instances:"
    list_instances | sed 's/^/  /' || dim "  (none)"
    exit 0
fi

PROVIDER=$(state_get "$NAME" .provider)
SERVER_ID=$(state_get "$NAME" .server_id)
SERVER_IP=$(state_get "$NAME" .server_ip)
SSH_KEY_ID=$(state_get "$NAME" .ssh_key_id)
SSH_KEY_PATH=$(state_get "$NAME" .ssh_key_path)
CREATED_AT=$(state_get "$NAME" .created_at)

log "About to destroy:"
echo "  name:        $NAME"
echo "  provider:    $PROVIDER"
echo "  server:      $SERVER_ID ($SERVER_IP)"
echo "  created at:  $CREATED_AT"

if [ "$ASSUME_YES" != "1" ]; then
    read -p "$(echo -e "${YELLOW}Continue? (y/N): ${NC}")" -r REPLY
    if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
        dim "Aborted."
        exit 0
    fi
fi

# Cleaner error if the provider token isn't around — better than the generic
# "Required env X is not set" because we know exactly what the user can do
# about it.
require_provider_token() {
    local var="$1"
    if [ -n "${!var:-}" ]; then return 0; fi
    err "$var is not set — needed to destroy '$NAME' on $PROVIDER."
    err ""
    err "Fix options:"
    err "  1) Save it once in your global config:"
    err "       yarn selfhosted:setup"
    err "  2) Or pass it inline for this run:"
    err "       $var=<your-token> yarn selfhosted:destroy${NAME:+ --name $NAME}"
    err ""
    err "The droplet (id=$SERVER_ID, ip=$SERVER_IP) is still alive."
    err "You can also delete it manually at the provider's console."
    exit 1
}

# ---------- destroy server ----------
case "$PROVIDER" in
    digitalocean)
        require_provider_token DIGITALOCEAN_TOKEN
        curl -sS -X DELETE \
            -H "Authorization: Bearer ${DIGITALOCEAN_TOKEN}" \
            "https://api.digitalocean.com/v2/droplets/$SERVER_ID" >/dev/null \
            && ok "Destroyed DO droplet $SERVER_ID" \
            || warn "Could not destroy droplet $SERVER_ID — check at cloud.digitalocean.com"
        ;;
    hetzner)
        require_provider_token HCLOUD_TOKEN
        curl -sS -X DELETE \
            -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
            "https://api.hetzner.cloud/v1/servers/$SERVER_ID" >/dev/null \
            && ok "Destroyed Hetzner server $SERVER_ID" \
            || warn "Could not destroy server $SERVER_ID — check at hetzner.cloud"
        ;;
    *)
        err "Unknown provider in state file: $PROVIDER"
        exit 1
        ;;
esac

# ---------- destroy SSH key ----------
if [ -n "$SSH_KEY_ID" ]; then
    case "$PROVIDER" in
        digitalocean)
            curl -sS -X DELETE \
                -H "Authorization: Bearer ${DIGITALOCEAN_TOKEN}" \
                "https://api.digitalocean.com/v2/account/keys/$SSH_KEY_ID" >/dev/null \
                && ok "Removed DO SSH key $SSH_KEY_ID" \
                || warn "Could not remove DO SSH key — clean up at cloud.digitalocean.com/account/security"
            ;;
        hetzner)
            curl -sS -X DELETE \
                -H "Authorization: Bearer ${HCLOUD_TOKEN}" \
                "https://api.hetzner.cloud/v1/ssh_keys/$SSH_KEY_ID" >/dev/null \
                && ok "Removed Hetzner SSH key $SSH_KEY_ID" \
                || warn "Could not remove SSH key — clean up at hetzner.cloud/ssh-keys"
            ;;
    esac
fi

# ---------- local cleanup ----------
if [ -n "$SSH_KEY_PATH" ] && [ -f "$SSH_KEY_PATH" ]; then
    rm -f "$SSH_KEY_PATH" "${SSH_KEY_PATH}.pub"
    ok "Removed local SSH key $SSH_KEY_PATH"
fi

rm -f "$(state_file_for "$NAME")"
ok "Removed state file for '$NAME'"

echo ""
ok "Destroyed. No further charges from this VM."
