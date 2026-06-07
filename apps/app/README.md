# kodus-app (UI v2)

The strangler app: Vite + React 19 + TanStack Router/Query + `@kodus/ui`, replacing `apps/web` (Next) vertical by vertical. Only migrated surfaces live here; everything else hard-links back to the Next app.

## Why

Next dev/build/runtime slowness across the board; the product is 100% behind auth (no SEO), so a fast SPA is the right shape. Final state: one app again — `apps/web` shrinks until deletable, restoring the single-topology rule for cloud + self-hosted.

## Dev

```bash
yarn install
yarn dev          # http://localhost:5181
yarn typecheck
```

- `@kodus/ui` is consumed **from source** (vite alias + tsconfig paths + `@source` for Tailwind) — instant HMR across the package, no publish step. `resolve.dedupe` keeps one React at runtime; the tsconfig `react` paths keep one `@types/react` (otherwise the radix CSS-var augmentation mismatches).
- `/api/*` proxies to the Next app on `:3000` in dev so the Auth.js session cookie works (`src/lib/session.ts` reads `/api/auth/session`).

## Alpha rollout plan (per-org)

1. **Flag**: `ui_v2` on the org (feature-gate service).
2. **Routing**: same domain, path-based. Edge/nginx (cloud) routes migrated paths (`/settings/code-review/*/general` for now) to this app **when the `ui_v2` cookie is set**; otherwise Next. The Next middleware sets/clears the cookie from the org flag at session time.
3. **Rollback** = flag off. No data divergence: both UIs talk to the same API.
4. Cross-app navigation is a full page load during the transition — acceptable, temporary.
5. Self-hosted only ships this app when it becomes the default (no dual topology for customers).

## Migrated verticals

- Settings → Code review → General (`src/features/settings/`) — **API still stubbed** (`api.ts`, marked TODO(migration)): wire to the real parameters endpoints next.

## Next verticals (suggested order)

Settings (rest of code-review pages) → Kody Rules → Subscription/members → Cockpit → onboarding.
