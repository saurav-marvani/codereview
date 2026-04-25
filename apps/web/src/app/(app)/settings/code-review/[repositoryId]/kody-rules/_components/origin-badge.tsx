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
            className="min-h-auto px-2.5 py-1">
            {origin}
        </Badge>
    );
};
