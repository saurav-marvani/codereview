import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime (preview-env alpha): register the organization_parameters enum
 * values the feature persists — the encrypted secrets vault, the org-level
 * BYO-cloud infra config, and the golden-snapshot registry.
 *
 * Uses the DO-block pattern (same as 2026042900200-addFirstReviewAtOrgParamEnum
 * and 2026031600000-addIpE2bEnumValue) rather than a bare
 * `ALTER TYPE ... ADD VALUE IF NOT EXISTS` under `transaction = false`. The
 * latter was observed to be RECORDED-as-run but NOT actually persist the enum
 * values on a fresh database (TypeORM's per-migration `transaction = false`
 * path didn't commit the ADD VALUE), which broke the vault on a clean install.
 * The guarded DO block runs inside the normal 'each' transaction and commits
 * reliably, and is idempotent (checks pg_enum before adding).
 */
export class AddEnvironmentParams1783360000000 implements MigrationInterface {
    name = 'AddEnvironmentParams1783360000000';

    private static readonly VALUES = [
        'environment_secrets',
        'environment_infra',
        'environment_snapshots',
    ];

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const value of AddEnvironmentParams1783360000000.VALUES) {
            await queryRunner.query(`
                DO $$ BEGIN
                    IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'organization_parameters_configkey_enum') THEN
                        IF NOT EXISTS (
                            SELECT 1 FROM pg_enum
                            WHERE enumlabel = '${value}'
                            AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'organization_parameters_configkey_enum')
                        ) THEN
                            ALTER TYPE "public"."organization_parameters_configkey_enum"
                            ADD VALUE '${value}';
                        END IF;
                    END IF;
                END $$;
            `);
        }
    }

    public async down(): Promise<void> {
        // PostgreSQL can't drop enum values without a type rebuild; the values
        // are harmless if left, so this is a no-op (matches the add-value
        // migrations that came before).
    }
}
