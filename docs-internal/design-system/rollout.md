# UI v2 — alpha rollout (strangler)

How an org gets the new app (`apps/app`) for migrated verticals, with instant rollback. Three pieces:

## 1. Org allow-list → routing cookie (done)

`apps/web/src/middleware.ts` sets the `kodus_ui_v2=1` cookie when the session's `organizationId` is in `WEB_UI_V2_ORG_IDS` (comma-separated env on the web container). No env → no-op. Removing the org clears the cookie on the next request.

```bash
# web container
WEB_UI_V2_ORG_IDS=<kodus-org-uuid>,<alpha-org-2-uuid>
```

## 2. Edge routes migrated paths by cookie

The SPA is a static build (nginx serving `apps/app/dist`). Vite asset paths live under `/assets/` (no collision with Next's `/_next/`).

### nginx (self-hosted / simple cloud)

```nginx
# upstream choice by routing cookie (nginx vars can't contain "-")
map $cookie_kodus_ui_v2 $kodus_web_upstream {
    "1"     kodus_app:8080;   # UI v2 static container
    default kodus_web:3000;   # Next
}

server {
    # migrated verticals — extend this list as verticals move
    location ~ ^/settings/code-review/[^/]+/general$ {
        proxy_pass http://$kodus_web_upstream;
    }

    # UI v2 static assets (unique prefix, safe to always route)
    location /assets/ {
        proxy_pass http://kodus_app:8080;
    }

    # everything else → Next (incl. /api/proxy/*, which UI v2 also uses)
    location / {
        proxy_pass http://kodus_web:3000;
    }
}
```

### CloudFront (cloud)

CloudFront function on the default behavior: if `kodus_ui_v2=1` cookie AND the URI matches a migrated path, rewrite origin to the kodus-app origin (or use a separate cache behavior per migrated path pattern with an origin-request function checking the cookie).

## 3. kodus-app container

```dockerfile
# apps/app/Dockerfile (build stage: yarn install in packages/kodus-ui + apps/app, vite build)
FROM nginx:alpine
COPY dist /usr/share/nginx/html
# SPA fallback
RUN printf 'server { listen 8080; root /usr/share/nginx/html; location / { try_files $uri /index.html; } }' \
    > /etc/nginx/conf.d/default.conf
```

The SPA calls the API exclusively through `/api/proxy/api/*` (same origin) — the Next proxy injects the bearer token from the Auth.js session, so the new app never handles tokens. `/api/*` must keep routing to Next at the edge.

## Rollback

Remove the org from `WEB_UI_V2_ORG_IDS`. Next request clears the cookie; the edge routes everything back to Next. No deploy, no data divergence (both UIs hit the same API).

## Self-hosted

Ships only when UI v2 becomes the default for everyone (single topology rule). Until then this is cloud-only plumbing.
