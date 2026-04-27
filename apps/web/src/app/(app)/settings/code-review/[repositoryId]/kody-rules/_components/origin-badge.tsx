"use client";

import { Badge } from "@components/ui/badge";
import {
    inferRuleOrigin,
    type InferredRuleOrigin,
} from "src/core/utils/kody-rules/infer-origin";

const ORIGIN_TOOLTIPS: Record<Exclude<InferredRuleOrigin, "manual">, string> = {
    "Auto-sync": "Imported from an IDE rule file in the repo",
    Onboard: "Suggested by onboarding analysis",
    "Kody-generated":
        "Suggested by the Kody rule generator from past reviews",
};

// Distinct colour per origin so users can tell where a rule came from
// at a glance. Intentionally avoids the severity palette (danger /
// warning / alert / info) so the origin badge doesn't read as a
// severity. Tokens used here come from globals.css.
//
//   Auto-sync       → secondary (purple) — IDE / dev tooling
//   Onboard         → success   (green)  — "welcome", first-run
//   Kody-generated  → tertiary  (pink)   — Kody / LLM brand
const ORIGIN_CLASSES: Record<
    Exclude<InferredRuleOrigin, "manual">,
    string
> = {
    "Auto-sync":
        "bg-secondary-light/10 text-secondary-light ring-secondary-light/40 [--button-foreground:var(--color-secondary-light)]",
    Onboard:
        "bg-success/10 text-success ring-success/40 [--button-foreground:var(--color-success)]",
    "Kody-generated":
        "bg-tertiary-light/10 text-tertiary-light ring-tertiary-light/40 [--button-foreground:var(--color-tertiary-light)]",
};

type OriginBadgeProps = {
    rule: { sourcePath?: string | null; origin?: string | null };
};

// Static visual badge that names the rule's origin (Auto-sync / Onboard /
// Kody-generated). Intentionally avoids Radix Tooltip because nesting a
// Radix Slot trigger inside arbitrary parents (TooltipTrigger > Badge >
// asChild) created a setRef loop in our setup. The hover tooltip is
// rendered as a native `title` attribute instead — no Radix slot, no
// composed refs, zero risk of infinite update.
export const OriginBadge = ({ rule }: OriginBadgeProps) => {
    const origin = inferRuleOrigin(rule);
    if (origin === "manual") return null;

    const tooltip =
        origin === "Auto-sync" && rule.sourcePath
            ? "Imported from " + rule.sourcePath
            : ORIGIN_TOOLTIPS[origin];

    return (
        <Badge
            active
            size="xs"
            title={tooltip}
            className={
                "min-h-auto px-2.5 py-1 ring-1 " + ORIGIN_CLASSES[origin]
            }>
            {origin}
        </Badge>
    );
};
