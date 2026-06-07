# Design

Direction: **Forge** — the current Kodus brand, systematized. Committed orange, soft radii, quiet elevation. Dark-only. Chosen 2026-06-06 over Ledger (restrained) and Instrument (mono-dense); playground at `docs-internal/design-system/proposals.html`, full component spec at `docs-internal/design-system/forge.html`.

## Color

Two modes. **Dark is canonical** — the brand palette below is contract. **Light** is a derivation of the same identity: warm paper neutrals (`#f5f4f0` → `#fcfbf9`), burnt orange accent `#b35c08` (the contract amber fails AA on light surfaces), darker state colors, lilac `#6553ab`. Tokens are runtime CSS vars (`--kds-*` switched by the `light` class on `<html>`, mapped via `@theme inline`); components never branch on mode.

Dark palette (contract — these exact values, no regeneration):

| Token | Value | Use |
|---|---|---|
| `bg` | `#101019` | App background |
| `surface-1` | `#181825` | Cards, inputs, panels (card-lv1) |
| `surface-2` | `#202032` | Nested surfaces, hover, table headers (card-lv2) |
| `surface-3` | `#30304b` | Active states, tooltips (card-lv3) |
| `border` | `#30304b` | Default border |
| `border-strong` | `#3e3e5e` | Hover borders, dialog borders (derived elevation step) |
| `text-1` | `#ffffff` | Primary text |
| `text-2` | `#cdcddf` | Secondary text |
| `text-3` | `#f3f3f780` | Tertiary text, placeholders, meta |
| `accent` | `#f8b76d` | Primary actions, selection, focus. Hover `#fac68b`, pressed `#f0a958` |
| `on-accent` | `#443024` | Text/icons on accent fills (the brand primary-dark) |
| `accent-soft` | `#f8b76d21` | Selected backgrounds, soft fills |
| `violet` | `#c9bbf2` | Kody/AI identity, "in review" states. Soft: `#c9bbf224` |
| `success` | `#42be65` | Merged, passed. Soft: `22` alpha |
| `danger` | `#fa5867` | Critical, destructive. Soft: `22` alpha |
| `warning` | `#ff8b40` | High severity. Soft: `22` alpha |
| `alert` | `#f2c631` | Attention/pending. Soft: `22` alpha |
| `info` | `#5190ff` | Medium severity, informational. Soft: `22` alpha |
| `ring` | `#f8b76d66` | Focus ring (3px, outside) |

Rules:
- Orange is **committed**: primary buttons, selected states, focus, active nav. Never decoration on inactive elements.
- Violet is Kody's color: AI-generated content markers, Kody Rules, in-review status.
- Severity scale: critical=danger, high=warning, medium=info, low=neutral (surface-2 + text-2).
- State colors never carry meaning alone; pair with icon or label.

## Typography

- Sans: **DM Sans** (400/500/600/700). Mono: **Overpass Mono** (400/500/600) for code, paths, PR numbers, metrics, kbd.
- Fixed rem scale, ratio ~1.2: display 26/700/-0.02em · h1 22/700/-0.015em · h2 18/650 · h3 15.5/600 · body 14/400 · small 13 · caption 11/600 uppercase +0.09em (section labels) · code 12 mono.
- Tabular numerals on all numeric data.
- Body prose max 70ch; tables run full width.

## Shape & space

- Radii: lg 10px (cards, dialogs) · md 8px (buttons, inputs) · sm 6px (badges-square, kbd, small controls) · pills 999px (badges).
- Spacing unit 4px. Control heights: button 32px (sm 28px), input 34px.
- Borders 1px solid. Elevation = border + background step; shadow only on floating layers (dialog, dropdown, toast): `0 8px 32px #05050eaa`.

## Components (conventions)

- **Button**: primary (accent fill, on-accent text), secondary (surface-2 + border), ghost, danger (danger-soft text-danger, fills on hover). Loading swaps icon for spinner, keeps width.
- **Badge**: filled soft-color pills with 5px status dot. 22px tall.
- **Input**: surface-1 fill, border → border-strong on hover → accent + ring on focus. Invalid = danger border + danger-soft ring.
- **Switch/checkbox/radio**: checked = accent fill, on-accent glyph.
- **Tabs**: underline style, accent indicator, text-2 → text-1.
- **Dialog/magic-modal**: surface-1, border-strong, shadow-pop, max 440-560px.
- **Toast**: surface-2, state icon, bottom-right.
- **Tooltip**: surface-3, 12px text, 6px radius.
- **Alert**: full 1px border in state color + soft bg + icon. Never side-stripes.
- **Empty states** teach: icon, one-line what, one action.
- **Loading**: skeleton blocks (surface-2 shimmer) for content, spinner only inside buttons/inline.
- Every interactive component ships default/hover/focus/active/disabled/loading states.
- **disabled vs readOnly vs Locked**: `disabled` (45% opacity) = temporarily unavailable. `readOnly` = RBAC view-only — value stays FULLY legible, interaction off, cursor default; available on Input, Textarea, Switch, Checkbox, RadioGroupItem, SelectTrigger. `<Locked reason>` wraps any control with a lock icon + tooltip explaining the missing permission; `Setting lockedReason` does it inline. Never use disabled for permission gating.
- **Icons**: lucide-react only — never emoji or unicode glyphs in product UI. Sizes: `size-3.5` (14px) inline/buttons/sidebar, `size-4` (16px) inputs/alerts, `size-5` (20px) feature tiles. Default strokeWidth (2); 3 only for tiny check/minus glyphs inside controls. Icon color follows text color of the slot (text-3 for muted slots).

## Motion

150-250ms, ease-out (cubic-bezier(0.22,1,0.36,1)). Motion conveys state only: fades, 4-8px slides, no bounce, no page choreography. Respect `prefers-reduced-motion`.
