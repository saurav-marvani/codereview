/**
 * Shared Mongo connection for TypeORM migrations and their standalone CLIs.
 *
 * Why it lives here (and stays dependency-free — only the `mongodb` driver, no
 * `@libs`/Nest imports): the migration build (`tsconfig.migrations.json`)
 * compiles this tree in isolation, and the prod migration step
 * (`migration:run:prod`) loads it from `dist/` with no Nest context. Pulling the
 * app's DI graph in here would bloat/break that build.
 *
 * The migration ledger is Postgres (the TypeORM `migrations` table). A Mongo
 * migration is a normal TypeORM migration whose `up()` opens a connection via
 * this helper, does the work, and closes — so Mongo schema/data changes ride
 * the SAME "runs once on boot, pod-locked" mechanism as the SQL migrations.
 */
import { Db, MongoClient } from 'mongodb';

/**
 * Builds the Mongo URI from the same env the API uses (mongodb.config.loader).
 * Prefers a full URI; otherwise assembles host/port/creds with authSource=admin.
 */
export function buildMongoUri(): string {
    const uri = process.env.MONGODB_URI ?? process.env.API_MG_DB_URI;
    if (uri) return uri;

    const host = process.env.API_MG_DB_HOST ?? 'localhost';
    const port = process.env.API_MG_DB_PORT ?? '27017';
    const user = process.env.API_MG_DB_USERNAME;
    const pass = process.env.API_MG_DB_PASSWORD;
    const auth =
        user && pass ? `${user}:${encodeURIComponent(pass)}@` : '';
    const db = process.env.API_MG_DB_DATABASE ?? 'kodus';
    return `mongodb://${auth}${host}:${port}/${db}?authSource=admin`;
}

export function mongoDatabaseName(): string {
    return process.env.API_MG_DB_DATABASE ?? 'kodus';
}

export type MongoMigrationHandle = {
    client: MongoClient;
    db: Db;
    close: () => Promise<void>;
};

/**
 * Opens a Mongo connection scoped to the API's database. Always `await close()`
 * in a `finally` so a migration never leaks a socket into the boot sequence.
 */
export async function mongoMigrationClient(): Promise<MongoMigrationHandle> {
    const client = new MongoClient(buildMongoUri());
    await client.connect();
    const db = client.db(mongoDatabaseName());
    return { client, db, close: () => client.close() };
}
