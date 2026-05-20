#!/usr/bin/env bash
# Provision a Kodus self-hosted droplet wired for the SSO cookie-domain
# E2E test, then run the Playwright SAML round-trip against it.
#
# What this script does:
#   1. Re-uses scripts/selfhosted/provision.sh to provision the base
#      stack (api/web/worker/webhooks/mcp/postgres/mongo/rabbit) on a
#      DigitalOcean droplet — same path as every other E2E droplet,
#      so secrets live in one place (~/.kodus-dev/config).
#   2. Layers Caddy + Keycloak on top via docker/sso-e2e/droplet/compose.yml.
#      Caddy fronts three sslip.io hostnames:
#          api.<IP>.sslip.io  → kodus-api:3001
#          app.<IP>.sslip.io  → kodus-web-prod:3000
#          kc.<IP>.sslip.io   → kc-sso-e2e:8080
#      with Let's Encrypt auto-issued certs (HTTP-01 over port 80).
#   3. Rewrites the API_URL / API_FRONTEND_URL on the droplet to the
#      public sslip.io hostnames so deriveSsoCookieDomain sees the
#      production-shape host headers.
#   4. Bootstraps Keycloak (realm + SAML client + test user) ON the
#      droplet via SSH.
#   5. Signs up a Kodus tenant + POSTs /sso-config with the IdP
#      descriptor FROM the local Mac (uses the public API URL).
#   6. Re-runs Keycloak bootstrap once orgId is known, so the SAML
#      client's ACS URL is bound to the real org.
#   7. Runs the Playwright SAML round-trip + asserts cookie Domain.
#
# Variables you need to have set BEFORE running (all already used by
# the existing selfhosted scripts — nothing new):
#   DIGITALOCEAN_TOKEN          DO API token         (via ~/.kodus-dev/config)
#   API_OPEN_AI_API_KEY         LLM key              (via ~/.kodus-dev/config)
#   API_OPENAI_FORCE_BASE_URL   (optional, e.g. Moonshot)
#   API_LLM_PROVIDER_MODEL      (optional)
#   KODUS_INSTALLER_PATH        (optional; default ../kodus-installer)
#   SSO_E2E_DROPLET_NAME        (optional; default "sso-e2e")
#   CADDY_ACME_EMAIL            (optional; default "sso-e2e@kodus.io")
#   CADDY_ACME_CA               (optional; default LE production)
#
# Usage:
#   yarn sso-e2e:droplet:provision                 # provision + run test
#   yarn sso-e2e:droplet:provision --skip-test     # provision only
#   yarn sso-e2e:droplet:provision --reuse         # reuse existing droplet

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

# Reuse the selfhosted scripts' config loader. _common.sh sources
# ~/.kodus-dev/config and scripts/selfhosted/.env in the right order.
# shellcheck disable=SC1091
. "${REPO_ROOT}/scripts/selfhosted/_common.sh"

# ---------- args ----------
NAME_RAW="${SSO_E2E_DROPLET_NAME:-sso-e2e}"
SKIP_TEST=0
REUSE=0
HEADLESS="${SSO_E2E_HEADLESS:-1}"
while [ $# -gt 0 ]; do
    case "$1" in
        --name) NAME_RAW="$2"; shift 2 ;;
        --name=*) NAME_RAW="${1#--name=}"; shift ;;
        --skip-test) SKIP_TEST=1; shift ;;
        --reuse) REUSE=1; shift ;;
        --headed) HEADLESS=0; shift ;;
        -h|--help)
            grep -E '^#( |$)' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *) err "Unknown arg: $1"; exit 2 ;;
    esac
done
NAME=$(normalize_name "$NAME_RAW")
STATE_FILE=$(state_file_for "$NAME")
LOCAL_SSH_KEY=$(ssh_key_path_for "$NAME")

CADDY_ACME_EMAIL="${CADDY_ACME_EMAIL:-sso-e2e@kodus.io}"
CADDY_ACME_CA="${CADDY_ACME_CA:-https://acme-v02.api.letsencrypt.org/directory}"

# ---------- step 1: base droplet ----------
if [ "${REUSE}" = "1" ] && state_exists "${NAME}"; then
    log "Reusing existing droplet '${NAME}'"
    SERVER_IP=$(state_get "${NAME}" .server_ip)
else
    if state_exists "${NAME}"; then
        warn "Droplet '${NAME}' already exists (IP $(state_get "${NAME}" .server_ip))."
        warn "Pass --reuse to reuse it, or destroy first: yarn sso-e2e:droplet:destroy --name ${NAME}"
        exit 1
    fi
    log "Provisioning base Kodus stack on a fresh droplet (~5 min)…"
    "${REPO_ROOT}/scripts/selfhosted/provision.sh" --name "${NAME}"
    SERVER_IP=$(state_get "${NAME}" .server_ip)
fi

if [ -z "${SERVER_IP}" ]; then
    err "Failed to resolve droplet IP from state file ${STATE_FILE}"
    exit 1
fi
ok "Droplet '${NAME}' at ${SERVER_IP}"

# Hostnames derived from the droplet's public IP via sslip.io wildcard DNS.
# sslip.io resolves *.<ip>.sslip.io → <ip> for any prefix — no DNS setup
# required. Cookie Domain expected on the handoff cookie:
#       .<IP>.sslip.io     (6 labels for a /32 IPv4)
SSO_E2E_BASE="${SERVER_IP}.sslip.io"
API_BASE_URL="https://api.${SSO_E2E_BASE}"
APP_BASE_URL="https://app.${SSO_E2E_BASE}"
KC_BASE_URL="https://kc.${SSO_E2E_BASE}"

ssh_vm() {
    ssh -i "${LOCAL_SSH_KEY}" \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR \
        -o ConnectTimeout=10 \
        "root@${SERVER_IP}" "$@"
}

scp_vm() {
    scp -i "${LOCAL_SSH_KEY}" \
        -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null \
        -o LogLevel=ERROR \
        "$@"
}

# Keycloak admin password: minted fresh on every provision and paired
# with a `down -v` of the kc-sso-e2e container so KC bootstraps from
# scratch with this exact password. Why not just reuse an existing
# password from .env: KC_BOOTSTRAP_ADMIN_PASSWORD is honored only at
# the very first container start (when the admin user is created).
# After that, the env var is ignored and the admin keeps whatever
# password the FIRST boot set. On --reuse, the .env and the running
# KC's admin can drift (e.g. a previous broken run wrote a different
# password). The bootstrap then fails with an empty token + cryptic
# JSON decode error in python. Wiping kc-sso-e2e-data + force-recreate
# is the cheapest robust fix: ~45s extra on --reuse, and the realm /
# SAML client / test user are re-seeded by bootstrap-keycloak-remote.sh
# (already idempotent).
KC_ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -d '=+/' | head -c 28)"

log "Public hostnames:"
log "  API       ${API_BASE_URL}"
log "  Web       ${APP_BASE_URL}"
log "  Keycloak  ${KC_BASE_URL}"

# ---------- step 2: align base stack to public hostnames ----------
# The base provision baked API_URL/API_FRONTEND_URL pointing at the raw
# IP (http://<IP>:3001 / :3000). For the SSO test we need them to point
# at the public TLS hostnames so the cookie domain calculation sees the
# production-shape Host header. Rewrite .env + restart the affected
# services. The rest of the stack (db, worker, etc.) is untouched.
log "Aligning .env on droplet to public hostnames"
ssh_vm bash -s <<REMOTE_ENV
set -euo pipefail
cd /opt/kodus-installer
env_set() {
    local k=\$1 v=\$2
    if grep -qE "^\${k}=" .env; then
        sed -i "s|^\${k}=.*|\${k}=\${v}|" .env
    else
        echo "\${k}=\${v}" >> .env
    fi
}
env_set API_URL "${API_BASE_URL}"
env_set API_FRONTEND_URL "${APP_BASE_URL}"
env_set NEXTAUTH_URL "${APP_BASE_URL}"
env_set WEB_HOSTNAME_API "${API_BASE_URL}"
# kodus-installer defaults API_NODE_ENV to "development" for the
# self-hosted dev experience. The SSO cookie code path explicitly
# bails out under development (returns no Domain, omits Secure)
# so the handoff cookie ends up host-only on api.<IP>.sslip.io and
# the browser refuses to send it to app.<IP>.sslip.io — confirmed
# at provision time on 2026-05-19. Force production here so the
# Domain attribute (the thing under test) actually lands.
env_set API_NODE_ENV "production"
# Web container's SSR fetches go to API_BASE_URL directly. Caddy
# terminates TLS so the cert chain is whatever ACME issued; Node trusts
# the public LE roots out of the box. No NODE_EXTRA_CA_CERTS mount.
env_set SSO_E2E_BASE "${SSO_E2E_BASE}"
env_set SSO_E2E_KC_ADMIN_PASSWORD "${KC_ADMIN_PASSWORD}"
REMOTE_ENV

# ---------- step 3: ship Caddy + Keycloak overlay ----------
log "Shipping SSO E2E overlay compose + Caddyfile"
ssh_vm "mkdir -p /opt/sso-e2e"

# Substitute \${BASE}/\${CADDY_*} in Caddyfile.tpl with the actual values
# before shipping. envsubst would be cleaner, but droplet may not have
# it; sed handles three placeholders trivially.
TMP_CADDYFILE="$(mktemp)"
sed \
    -e "s|\${BASE}|${SSO_E2E_BASE}|g" \
    -e "s|\${CADDY_ACME_EMAIL}|${CADDY_ACME_EMAIL}|g" \
    -e "s|\${CADDY_ACME_CA}|${CADDY_ACME_CA}|g" \
    "${REPO_ROOT}/docker/sso-e2e/droplet/Caddyfile.tpl" > "${TMP_CADDYFILE}"

scp_vm "${TMP_CADDYFILE}" "root@${SERVER_IP}:/opt/sso-e2e/Caddyfile"
scp_vm "${REPO_ROOT}/docker/sso-e2e/droplet/compose.yml" "root@${SERVER_IP}:/opt/sso-e2e/compose.yml"
scp_vm "${SCRIPT_DIR}/bootstrap-keycloak-remote.sh" "root@${SERVER_IP}:/opt/sso-e2e/bootstrap-keycloak.sh"
ssh_vm "chmod +x /opt/sso-e2e/bootstrap-keycloak.sh"
rm -f "${TMP_CADDYFILE}"

# ---------- step 4: restart api/web with new env, boot overlay ----------
# Use an explicit project name (-p kodus-installer) so the overlay
# compose layers ONTO the existing base stack instead of spinning up
# a parallel project called "opt" (which would happen if Docker derived
# the project name from the parent of the first -f flag).
log "Restarting api+web with new env, booting Caddy + Keycloak overlay"
ssh_vm bash -s <<'REMOTE_BOOT'
set -euo pipefail
cd /opt/kodus-installer

# Recreate api + web so they pick up the new API_URL / API_FRONTEND_URL.
# Service names in the installer compose: `api`, `kodus-web`.
docker compose -p kodus-installer up -d --force-recreate api kodus-web

# Wipe + recreate Keycloak so it bootstraps fresh with the password
# we just wrote to .env. KC_BOOTSTRAP_ADMIN_PASSWORD is only honored
# on the very first start (when the admin user is created), so if a
# prior run left an admin user with a stale password, subsequent
# admin-API calls fail with empty tokens. Cheapest robust fix: drop
# the kc-sso-e2e-data volume + force-recreate. The realm, SAML client
# and test user are re-seeded by bootstrap-keycloak.sh — idempotent
# by design — so wiping doesn't lose anything that survives a
# provision invocation anyway.
docker compose \
    -p kodus-installer \
    -f /opt/kodus-installer/docker-compose.yml \
    -f /opt/sso-e2e/compose.yml \
    --env-file /opt/kodus-installer/.env \
    rm -fsv kc-sso-e2e || true
docker volume rm -f kodus-installer_kc-sso-e2e-data 2>/dev/null || true

# Layer the overlay. Caddy stays (no-recreate); KC comes up fresh.
docker compose \
    -p kodus-installer \
    -f /opt/kodus-installer/docker-compose.yml \
    -f /opt/sso-e2e/compose.yml \
    --env-file /opt/kodus-installer/.env \
    up -d --no-recreate caddy-sso-e2e kc-sso-e2e
REMOTE_BOOT

# ---------- step 5: wait for Caddy + LE cert ----------
log "Waiting for Caddy to terminate TLS at ${API_BASE_URL} (LE cert issuance)"
# Caddy obtains LE certs lazily on first request to each host. Hit each
# hostname to trigger issuance, then poll until the chain validates.
CURL_DROP=(curl -sk -o /dev/null -w '%{http_code}')
for url in "${API_BASE_URL}/health" "${APP_BASE_URL}" "${KC_BASE_URL}/realms/master"; do
    "${CURL_DROP[@]}" "${url}" >/dev/null || true
done

TLS_OK=0
for i in $(seq 1 90); do
    api_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 "${API_BASE_URL}/health" || echo 000)
    if [ "${api_code}" = "200" ]; then
        # Now verify TLS validation (without -k) — only then is the
        # LE chain in place. Caddy may temporarily serve its internal
        # CA cert before the ACME challenge completes.
        if curl -s --max-time 6 -o /dev/null "${API_BASE_URL}/health"; then
            TLS_OK=1
            break
        fi
    fi
    sleep 4
done

if [ "${TLS_OK}" = "0" ]; then
    warn "TLS not validated yet — Caddy may have fallen back to its internal CA."
    warn "Continuing with --ignore-certificate-errors. Set CADDY_ACME_CA="
    warn "https://acme-staging-v02.api.letsencrypt.org/directory and re-run if hitting LE rate limits."
    IGNORE_TLS=1
else
    ok "Public TLS chain valid"
    IGNORE_TLS=0
fi

# ---------- step 6: bootstrap Keycloak (pass 1, wildcard ACS) ----------
log "Bootstrapping Keycloak realm + SAML client (pass 1)"
KC_JSON_LOCAL="${REPO_ROOT}/.tmp/sso-e2e-droplet-keycloak.json"
mkdir -p "${REPO_ROOT}/.tmp"

ssh_vm "KC_BASE_URL='${KC_BASE_URL}' \
        KC_ADMIN_PASSWORD='${KC_ADMIN_PASSWORD}' \
        API_BASE_URL='${API_BASE_URL}' \
        ORG_ID='*' \
        bash /opt/sso-e2e/bootstrap-keycloak.sh" > "${KC_JSON_LOCAL}"

if [ ! -s "${KC_JSON_LOCAL}" ]; then
    err "bootstrap-keycloak (pass 1) produced empty output"
    exit 1
fi

# ---------- step 7: signup Kodus tenant + post SSO config ----------
log "Signing up Kodus tenant + posting SSO config"
ORG_ID=$(API_BASE_URL="${API_BASE_URL}" \
    KC_JSON_PATH="${KC_JSON_LOCAL}" \
    OUT_DIR="${REPO_ROOT}/.tmp" \
    bash "${SCRIPT_DIR}/bootstrap-kodus-sso.sh")

# ---------- step 8: bootstrap Keycloak (pass 2, real ACS) ----------
log "Re-bootstrapping Keycloak with real orgId=${ORG_ID}"
ssh_vm "KC_BASE_URL='${KC_BASE_URL}' \
        KC_ADMIN_PASSWORD='${KC_ADMIN_PASSWORD}' \
        API_BASE_URL='${API_BASE_URL}' \
        ORG_ID='${ORG_ID}' \
        bash /opt/sso-e2e/bootstrap-keycloak.sh" > "${KC_JSON_LOCAL}"

# ---------- step 9: persist state ----------
STATE_JSON="$(jq -n \
    --arg base "${SSO_E2E_BASE}" \
    --arg api "${API_BASE_URL}" \
    --arg app "${APP_BASE_URL}" \
    --arg kc "${KC_BASE_URL}" \
    --arg org "${ORG_ID}" \
    --arg ignore_tls "${IGNORE_TLS}" \
    '{
        base: $base,
        api_url: $api,
        app_url: $app,
        kc_url: $kc,
        org_id: $org,
        ignore_tls: $ignore_tls
    }')"
echo "${STATE_JSON}" > "${REPO_ROOT}/.tmp/sso-e2e-droplet.json"
ok "Saved test state to .tmp/sso-e2e-droplet.json"

cat <<EOF

══════════════════════════════════════════════════════════════════
 SSO E2E droplet ready
══════════════════════════════════════════════════════════════════
  Droplet     ${SERVER_IP} (name: ${NAME})
  API         ${API_BASE_URL}
  Web         ${APP_BASE_URL}
  Keycloak    ${KC_BASE_URL}  (admin / ${KC_ADMIN_PASSWORD})
  Org         ${ORG_ID}
  TLS chain   $( [ "${IGNORE_TLS}" = "0" ] && echo "Let's Encrypt (trusted)" || echo "Caddy internal — Playwright will ignore" )

  Test user   sso-user@kodus-test.com / TestSso!2026

  Run test    yarn sso-e2e:droplet:run
  Destroy     yarn sso-e2e:droplet:destroy --name ${NAME}

EOF

# ---------- step 10: run Playwright ----------
if [ "${SKIP_TEST}" = "1" ]; then
    log "Skipping Playwright (--skip-test). Run later: yarn sso-e2e:droplet:run"
    exit 0
fi

log "Running Playwright cookie-domain test against droplet"
cd "${REPO_ROOT}/tests/e2e/playwright"
if [ ! -d node_modules ]; then
    log "Installing Playwright (first run only)"
    npm install --no-audit --no-fund --silent
    npx playwright install chromium --with-deps 2>/dev/null \
        || npx playwright install chromium
fi

env \
    SSO_E2E_API_URL="${API_BASE_URL}" \
    SSO_E2E_APP_URL="${APP_BASE_URL}" \
    SSO_E2E_BASE="${SSO_E2E_BASE}" \
    SSO_E2E_ORG_ID="${ORG_ID}" \
    SSO_E2E_IGNORE_TLS="${IGNORE_TLS}" \
    SSO_E2E_HEADLESS="${HEADLESS}" \
    node sso-cookie-domain.mjs
