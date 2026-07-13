import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Creates the `kodus_cross_process_events` table used by
 * `CrossProcessEventsBridge` to hop EventEmitter2 payloads between the API
 * and worker containers via Postgres LISTEN/NOTIFY.
 *
 * The bridge itself has an `ensureInfra()` step that runs a `CREATE TABLE IF
 * NOT EXISTS` on boot — but that step is gated on a successful raw `pg.Client`
 * connect. When that connect failed (e.g. the TLS mis-config in prod on
 * 2026-07-13), the table was never created and every publish `INSERT` from
 * TypeORM raised `relation "kodus_cross_process_events" does not exist` at
 * runtime. Anchoring the schema in a proper TypeORM migration removes that
 * fragility: the table always exists on any environment past the migration
 * runner, so a broken LISTEN degrades gracefully to "envelopes recorded but
 * not re-emitted" instead of a hard write error hammering the log.
 */
export class CrossProcessEventsTable2026071300000000
    implements MigrationInterface
{
    name = 'CrossProcessEventsTable2026071300000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "kodus_cross_process_events" (
                "id" bigserial PRIMARY KEY,
                "envelope" jsonb NOT NULL,
                "created_at" timestamptz NOT NULL DEFAULT now()
            )
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(
            `DROP TABLE IF EXISTS "kodus_cross_process_events"`,
        );
    }
}
