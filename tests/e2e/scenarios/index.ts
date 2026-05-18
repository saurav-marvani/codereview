import type { Scenario } from "../lib/types.js";
import codeReviewBasic from "./code-review-basic.js";
import kodyRulesCreateAndApply from "./kody-rules.js";
import licenseAttribution from "./license-attribution.js";
import onboardingWebhookRegistration from "./onboarding-webhook-registration.js";
import upgradeNMinusOneToN from "./upgrade.js";

export const allScenarios: Record<string, Scenario> = {
    [onboardingWebhookRegistration.id]: onboardingWebhookRegistration,
    [codeReviewBasic.id]: codeReviewBasic,
    [kodyRulesCreateAndApply.id]: kodyRulesCreateAndApply,
    [licenseAttribution.id]: licenseAttribution,
    [upgradeNMinusOneToN.id]: upgradeNMinusOneToN,
};

export function resolveScenarios(ids: string[]): Scenario[] {
    return ids.map((id) => {
        const s = allScenarios[id];
        if (!s) {
            throw new Error(
                `Unknown scenario: ${id}. Known: ${Object.keys(allScenarios).join(", ")}`,
            );
        }
        return s;
    });
}

export {
    codeReviewBasic,
    kodyRulesCreateAndApply,
    licenseAttribution,
    onboardingWebhookRegistration,
    upgradeNMinusOneToN,
};
