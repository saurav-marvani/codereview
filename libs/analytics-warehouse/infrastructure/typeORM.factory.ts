import { join } from 'path';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions, TypeOrmOptionsFactory } from '@nestjs/typeorm';

import { AnalyticsDatabaseConnection } from '@libs/core/infrastructure/config/types';

import { ANALYTICS_ENTITIES } from '../entities';
import { ANALYTICS_DATA_SOURCE } from '../schema.constant';

@Injectable()
export class AnalyticsTypeORMFactory implements TypeOrmOptionsFactory {
    constructor(private readonly configService: ConfigService) {}

    createTypeOrmOptions(): TypeOrmModuleOptions {
        const config = this.configService.get<AnalyticsDatabaseConnection>(
            'analyticsPostgresDatabase',
        );

        if (!config) {
            throw new Error(
                'Analytics Postgres configuration not found. Did you import analyticsPostgresConfigLoader?',
            );
        }

        // Prefer ConfigService over direct process.env access to match
        // the project-wide convention (see kody-rules/4368bf47-...):
        // env reads go through the config layer so they can be tested
        // and overridden uniformly. `configService.get` transparently
        // falls back to `process.env` when no loader is registered for
        // the key, so no extra config loader is required here.
        const env =
            this.configService.get<string>('API_DATABASE_ENV') ??
            this.configService.get<string>('API_NODE_ENV');
        const isProduction = !['development', 'test'].includes(env ?? '');
        const disableSSL =
            this.configService.get<string>('API_DATABASE_DISABLE_SSL') ===
            'true';
        const useSSL = isProduction && !disableSSL;
        const poolMax = parseInt(
            this.configService.get<string>('ANALYTICS_PG_POOL_MAX') ?? '5',
            10,
        );

        return {
            name: ANALYTICS_DATA_SOURCE,
            type: 'postgres',
            host: config.host,
            port: config.port,
            username: config.username,
            password: config.password,
            database: config.database,
            schema: config.schema,
            entities: ANALYTICS_ENTITIES,
            autoLoadEntities: false,
            cache: false,
            synchronize: false,
            migrationsRun: false,
            migrations: [join(__dirname, '../migrations/*{.ts,.js}')],
            migrationsTableName: 'migrations',
            logging: !isProduction,
            ssl: useSSL,
            extra: {
                max: poolMax,
                min: 1,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 60000,
                keepAlive: true,
                ...(useSSL ? { ssl: { rejectUnauthorized: false } } : {}),
            },
        };
    }
}
