import { readFileSync } from "node:fs";

import { PostgresSyncDatabase } from "./postgres/postgres-sync-database.js";
import { runPostgresMigrations } from "./postgres/migrations/index.js";
import { SqliteEventStore } from "./sqlite-event-store.js";

export class PostgresEventStore extends SqliteEventStore {
    constructor({ config, logger }) {
        if (!config?.postgresUrl) {
            throw new Error("PostgresEventStore requires a configured DATABASE_URL.");
        }
        const database = new PostgresSyncDatabase({
            connectionString: config.postgresUrl,
            poolMin: config.postgresPoolMinimum,
            poolMax: config.postgresPoolMaximum,
            connectionTimeoutMs: config.postgresConnectionTimeoutMs,
            statementTimeoutMs: config.postgresStatementTimeoutMs,
            lockTimeoutMs: config.postgresLockTimeoutMs,
            idleTransactionTimeoutMs: config.postgresIdleTransactionTimeoutMs,
            sslMode: config.postgresSslMode,
            applicationName: config.postgresApplicationName,
            ...(config.postgresTlsCaPath
                ? { tlsCa: readFileSync(config.postgresTlsCaPath, "utf8") }
                : {})
        });
        try {
            super({
                database,
                databaseType: "postgres",
                logger,
                migrationRunner: runPostgresMigrations
            });
        } catch (error) {
            database.close();
            throw error;
        }
    }
}
