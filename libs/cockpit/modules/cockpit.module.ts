import { Module } from '@nestjs/common';

import { AnalyticsWarehouseModule } from '@libs/analytics-warehouse';
import { LicenseModule } from '@libs/ee/license/license.module';

import { CockpitTierGuard } from '../infrastructure/guards/cockpit-tier.guard';
import { CockpitCodeHealthService } from '../infrastructure/services/cockpit-code-health.service';
import { CockpitDeveloperProductivityService } from '../infrastructure/services/cockpit-developer-productivity.service';
import { CockpitHealthService } from '../infrastructure/services/cockpit-health.service';
import { CockpitSourceResolver } from '../infrastructure/services/cockpit-source.resolver';
import { CockpitValidationService } from '../infrastructure/services/cockpit-validation.service';

/**
 * Entry point for the in-process cockpit — replaces the external
 * `kodus-service-analytics` deployment on both cloud and self-hosted.
 * Queries go against `analytics.*` tables that the worker ingestion
 * pipeline keeps in sync with Mongo.
 */
@Module({
    imports: [AnalyticsWarehouseModule.forRoot(), LicenseModule],
    providers: [
        CockpitSourceResolver,
        CockpitHealthService,
        CockpitValidationService,
        CockpitCodeHealthService,
        CockpitDeveloperProductivityService,
        CockpitTierGuard,
    ],
    exports: [
        CockpitSourceResolver,
        CockpitHealthService,
        CockpitValidationService,
        CockpitCodeHealthService,
        CockpitDeveloperProductivityService,
        CockpitTierGuard,
    ],
})
export class CockpitModule {}
