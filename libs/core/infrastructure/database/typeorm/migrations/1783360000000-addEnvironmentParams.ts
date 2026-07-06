import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Kody Runtime (preview-env alpha): register the two new
 * organization_parameters keys — the encrypted per-repo secrets vault and the
 * org-level BYO-cloud infra config. Hand-written because TypeORM does not
 * auto-generate ALTER TYPE ... ADD VALUE, and Postgres requires it to run
 * outside a transaction.
 */
export class AddEnvironmentParams1783360000000 implements MigrationInterface {
    name = 'AddEnvironmentParams1783360000000';
    transaction = false;

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            ALTER TYPE "public"."organization_parameters_configkey_enum"
            ADD VALUE IF NOT EXISTS 'environment_secrets'
        `);
        await queryRunner.query(`
            ALTER TYPE "public"."organization_parameters_configkey_enum"
            ADD VALUE IF NOT EXISTS 'environment_infra'
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // PostgreSQL does not support removing enum values; leave in place.
    }
}
