import { BYOKConfig } from '@kodus/kodus-common/llm';

import { environment } from '@libs/ee/configs/environment';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';

/**
 * Model forced for Kody Rules generation on cloud trial (no BYOK). Routed to
 * the Moonshot official API (`API_MOONSHOT_API_KEY`) by `byokToVercelModel`'s
 * `kimi-*` prefix detection.
 */
export const KODY_RULES_TRIAL_MODEL = 'kimi-k2.7-code';

/**
 * Resolved model policy for a Kody Rules generation run.
 *
 * `generate: false` means the run must be skipped (no model the org is
 * entitled to). `byokConfig`/`modelOverride` feed `byokToVercelModel`:
 * BYOK wins when present; otherwise `modelOverride` forces the trial model;
 * self-hosted resolves the env model (both undefined).
 */
export interface KodyRulesModelPolicy {
    generate: boolean;
    byokConfig?: BYOKConfig;
    modelOverride?: string;
    /** Set when `generate` is false — human-readable reason for the skip. */
    skipReason?: string;
}

/**
 * Decides which model (if any) a Kody Rules generation run may use.
 *
 * Policy (see docs/plans/fix-kody-rules-generation.md):
 * - BYOK configured        → generate with the client's BYOK model.
 * - Self-hosted / dev       → generate with the env model (no BYOK/trial concept).
 * - Cloud, no BYOK, trial   → generate with Kimi K2.7 (Kodus-funded, Moonshot).
 * - Cloud, no BYOK, other   → SKIP (free/paid without BYOK generates nothing).
 */
export async function resolveKodyRulesModelPolicy(
    permissionValidationService: PermissionValidationService,
    organizationAndTeamData: OrganizationAndTeamData,
): Promise<KodyRulesModelPolicy> {
    const byokConfig = await permissionValidationService.getBYOKConfig(
        organizationAndTeamData,
    );
    if (byokConfig) {
        return { generate: true, byokConfig };
    }

    // Self-hosted / dev have no BYOK/trial concept — the model comes from the
    // deployment's env config. Always generate; byokToVercelModel(undefined)
    // resolves the env model.
    if (!environment.API_CLOUD_MODE || environment.API_DEVELOPMENT_MODE) {
        return { generate: true };
    }

    const subscriptionStatus =
        await permissionValidationService.getSubscriptionStatus(
            organizationAndTeamData,
        );

    if (subscriptionStatus === 'trial') {
        return { generate: true, modelOverride: KODY_RULES_TRIAL_MODEL };
    }

    return {
        generate: false,
        skipReason: subscriptionStatus
            ? `no BYOK configured on '${subscriptionStatus}' plan — Kody Rules generation requires BYOK outside the trial`
            : 'no BYOK configured and no active trial — Kody Rules generation skipped',
    };
}
