/**
 * code-review (domain) — resolve the BYOK config + Vercel AI SDK model for a run.
 *
 * Phase 4 of the provider decomposition. Pulls the "config → model" resolution
 * out of BaseCodeReviewAgentProvider: org BYOK config + per-repo/directory model
 * override + trial default fallback. The permission service is injected.
 */
import { byokToVercelModel, getModelName } from '@libs/llm/byok-to-vercel';
import type { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';

import type { ReviewAgentInput } from '@libs/code-review/infrastructure/agents/review-agent.contract';

type ModelInput = Pick<
    ReviewAgentInput,
    'organizationAndTeamData' | 'byokModel' | 'defaultModelOverride'
>;

/**
 * Resolve the run's model:
 *  1. org-level BYOK config (scoped locally — no cross-review race)
 *  2. apply the per-repo/directory `byokModel` override onto `main`
 *  3. build the Vercel model; `defaultModelOverride` only kicks in when there
 *     is no BYOK config (trial/public-demo).
 */
export async function resolveAgentModel(
    input: ModelInput,
    permissionService: PermissionValidationService,
) {
    let byokConfig = await permissionService.getBYOKConfig(
        input.organizationAndTeamData,
    );

    const overrideModel = input.byokModel?.trim();
    if (overrideModel && byokConfig?.main) {
        byokConfig = {
            ...byokConfig,
            main: { ...byokConfig.main, model: overrideModel },
        };
    }

    const model = byokToVercelModel(
        byokConfig,
        'main',
        {},
        input.defaultModelOverride,
    );
    const modelName = getModelName(byokConfig, input.defaultModelOverride);

    return { byokConfig, model, modelName };
}
