import { registerAs } from '@nestjs/config';

import { AnalyticsDatabaseConnection } from '@libs/core/infrastructure/config/types';

/**
 * Config for the analytics Postgres DataSource (cockpit warehouse).
 *
 * Cloud: dedicated Postgres instance (ANALYTICS_PG_DB_HOST set) to preserve
 * blast-radius separation from the OLTP primary (same property BigQuery gives
 * us today, where it lives in a separate GCP project).
 *
 * Self-hosted: ANALYTICS_PG_DB_HOST unset → reuse the main API Postgres, but
 * still scoped to the `analytics` schema so reads/writes can never reach
 * OLTP tables accidentally.
 */
export const analyticsPostgresConfigLoader = registerAs(
    'analyticsPostgresDatabase',
    (): AnalyticsDatabaseConnection => {
        const env = process.env.API_DATABASE_ENV ?? process.env.API_NODE_ENV;
        const isHosted = ['homolog', 'production'].includes(env ?? '');

        const host =
            process.env.ANALYTICS_PG_DB_HOST ??
            (isHosted
                ? process.env.API_PG_DB_HOST
                : (process.env.API_PG_DB_HOST ?? 'localhost'));

        const port = parseInt(
            process.env.ANALYTICS_PG_DB_PORT ??
                process.env.API_PG_DB_PORT ??
                '5432',
            10,
        );

        return {
            host,
            port,
            username:
                process.env.ANALYTICS_PG_DB_USERNAME ??
                process.env.API_PG_DB_USERNAME,
            password:
                process.env.ANALYTICS_PG_DB_PASSWORD ??
                process.env.API_PG_DB_PASSWORD,
            database:
                process.env.ANALYTICS_PG_DB_DATABASE ??
                process.env.API_PG_DB_DATABASE,
            schema: process.env.ANALYTICS_PG_DB_SCHEMA ?? 'analytics',
        };
    },
);
