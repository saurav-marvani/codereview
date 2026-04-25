import { Injectable } from '@nestjs/common';

import posthog, { FEATURE_FLAGS } from '@libs/common/utils/posthog';

import { COCKPIT_SOURCE, CockpitSource } from '../../domain/cockpit-source.enum';

/**
 * Decides whether cockpit reads should hit the new in-process Postgres
 * warehouse (`internal`) or keep proxying to `kodus-service-analytics` on
 * BigQuery (`legacy-bq`).
 *
 * Default until parity is validated = `legacy-bq`. Self-hosted (no PostHog
 * key) short-circuits to `internal` — there is no BQ path for self-hosted.
 */
@Injectable()
export class CockpitSourceResolver {
    async resolve(organizationId: string): Promise<CockpitSource> {
        if (!posthog.isInitialized) {
            return COCKPIT_SOURCE.INTERNAL;
        }

        const enabled = await posthog.isFeatureEnabled(
            FEATURE_FLAGS.cockpitInternalSource,
            organizationId,
            { organizationId, teamId: '' },
        );

        return enabled ? COCKPIT_SOURCE.INTERNAL : COCKPIT_SOURCE.LEGACY_BQ;
    }
}
