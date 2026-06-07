# @kodus/ui

Kodus design system — **Forge** direction. React components on Radix primitives + Tailwind v4, themed with the Kodus brand palette (contract values, see `DESIGN.md` at the repo root).

## Development

```bash
yarn install
yarn dev        # interactive playground at http://localhost:5180
yarn typecheck
yarn build      # tsup → dist (esm + cjs + dts)
```

## Consuming (Tailwind v4 app)

```css
/* your tailwind entry css */
@import "tailwindcss";
@import "@kodus/ui/styles.css";
@source "../node_modules/@kodus/ui/src";
```

```tsx
import { Button, SettingsGroup, Setting, Switch } from "@kodus/ui";

<SettingsGroup title="Automated review">
    <Setting
        title="Automated code review"
        description="Kody reviews every new pull request automatically."
        control={<Switch defaultChecked />}
    />
</SettingsGroup>;
```

Fonts (DM Sans + Overpass Mono) are the consumer's responsibility — load them via `next/font` or a `<link>`.

## What's here

Primitives: Button, Badge, Input/Textarea/Field, Switch, Checkbox, RadioGroup, Select, Tabs, Tooltip, DropdownMenu, Dialog, Alert, Avatar, Skeleton, Spinner, Progress, Separator, Kbd, InlineCode, Card.

Kodus patterns: SettingsGroup/Setting, Sidebar (SidebarGroup/SidebarItem/SidebarScope — the settings scope tree), PageHeader, Breadcrumb.

Visual contract: `docs-internal/design-system/forge.html` (spec sheet) and `DESIGN.md`.

## Pending

- Toast (apps/web uses a bespoke toaster; decide sonner vs port)
- Command palette (⌘K), Popover, Sheet, DataTable helpers
- npm publish wiring (GAR registry like @kodus/kodus-common, or public npm — decide)
