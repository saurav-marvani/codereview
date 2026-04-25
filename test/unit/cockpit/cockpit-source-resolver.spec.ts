import { COCKPIT_SOURCE } from '@libs/cockpit/domain/cockpit-source.enum';

// Mock the posthog module BEFORE importing the resolver. Default export
// is the client object; named export `FEATURE_FLAGS` carries the flag
// constants. The resolver only touches `isInitialized` and `isFeatureEnabled`.
jest.mock('@libs/common/utils/posthog', () => {
    const isFeatureEnabled = jest.fn();
    return {
        __esModule: true,
        default: {
            isInitialized: false,
            isFeatureEnabled,
        },
        FEATURE_FLAGS: { cockpitInternalSource: 'cockpit-internal-source' },
    };
});

import posthog from '@libs/common/utils/posthog';
import { CockpitSourceResolver } from '@libs/cockpit/infrastructure/services/cockpit-source.resolver';

const posthogMock = posthog as unknown as {
    isInitialized: boolean;
    isFeatureEnabled: jest.Mock;
};

describe('CockpitSourceResolver', () => {
    let resolver: CockpitSourceResolver;

    beforeEach(() => {
        resolver = new CockpitSourceResolver();
        posthogMock.isFeatureEnabled.mockReset();
    });

    it('short-circuits to INTERNAL when PostHog is not initialized (self-hosted)', async () => {
        posthogMock.isInitialized = false;

        const source = await resolver.resolve('org-1');

        expect(source).toBe(COCKPIT_SOURCE.INTERNAL);
        expect(posthogMock.isFeatureEnabled).not.toHaveBeenCalled();
    });

    it('returns INTERNAL when the feature flag is enabled for the org', async () => {
        posthogMock.isInitialized = true;
        posthogMock.isFeatureEnabled.mockResolvedValue(true);

        const source = await resolver.resolve('org-1');

        expect(source).toBe(COCKPIT_SOURCE.INTERNAL);
        expect(posthogMock.isFeatureEnabled).toHaveBeenCalledWith(
            'cockpit-internal-source',
            'org-1',
            { organizationId: 'org-1', teamId: '' },
        );
    });

    it('returns LEGACY_BQ when the feature flag is disabled for the org', async () => {
        posthogMock.isInitialized = true;
        posthogMock.isFeatureEnabled.mockResolvedValue(false);

        const source = await resolver.resolve('org-2');

        expect(source).toBe(COCKPIT_SOURCE.LEGACY_BQ);
    });
});
