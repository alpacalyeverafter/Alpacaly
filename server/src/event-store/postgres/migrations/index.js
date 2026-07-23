import { createHash } from "node:crypto";

import { migration001CentralSchema } from "./001-central-schema.js";
import {
    migration002DistributedWorkerCoordination
} from "./002-distributed-worker-coordination.js";
import {
    migration003RelationalSafetyGuards
} from "./003-relational-safety-guards.js";
import {
    migration004DisasterRecoverySafety
} from "./004-disaster-recovery-safety.js";
import { migration005SandboxPayments } from "./005-sandbox-payments.js";
import { migration006FeedCreditWallets } from "./006-feed-credit-wallets.js";

export const POSTGRES_SCHEMA_VERSION = 6;

export const POSTGRES_MIGRATIONS = Object.freeze([
    migration001CentralSchema,
    migration002DistributedWorkerCoordination,
    migration003RelationalSafetyGuards,
    migration004DisasterRecoverySafety,
    migration005SandboxPayments,
    migration006FeedCreditWallets
]);

function checksum(sql) {
    return createHash("sha256").update(sql).digest("hex");
}

export function runPostgresMigrations(database, logger) {
    database.registerIdentifiers(POSTGRES_MIGRATIONS.map(item => item.sql).join("\n"));
    const appliedVersions = [];
    database.exec("BEGIN");
    try {
        // Transaction-scoped advisory locking serializes startup across every
        // application instance without requiring an external migration service.
        database.prepare(`
            SELECT pg_advisory_xact_lock(hashtext('alpacaly-central-schema'))
        `).get();
        database.exec(`
            CREATE TABLE IF NOT EXISTS AlpacalySchemaMigrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                checksum TEXT NOT NULL,
                appliedAt TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
        const applied = new Map(database.prepare(`
            SELECT version, name, checksum
            FROM AlpacalySchemaMigrations
            ORDER BY version
        `).all().map(row => [Number(row.version), row]));
        const unexpected = [...applied.keys()].filter(
            version => version > POSTGRES_SCHEMA_VERSION
        );
        if (unexpected.length > 0) {
            throw new Error(
                `PostgreSQL schema version ${Math.max(...unexpected)} is newer than supported version ${POSTGRES_SCHEMA_VERSION}.`
            );
        }

        for (const migration of POSTGRES_MIGRATIONS) {
            const expectedChecksum = checksum(migration.sql);
            const prior = applied.get(migration.version);
            if (prior) {
                if (prior.name !== migration.name || prior.checksum !== expectedChecksum) {
                    throw new Error(
                        `PostgreSQL migration ${migration.version} does not match its applied checksum.`
                    );
                }
                continue;
            }
            database.exec(migration.sql);
            database.prepare(`
                INSERT INTO AlpacalySchemaMigrations (version, name, checksum)
                VALUES (?, ?, ?)
            `).run(migration.version, migration.name, expectedChecksum);
            appliedVersions.push(migration);
        }
        database.exec("COMMIT");
    } catch (error) {
        database.exec("ROLLBACK");
        throw error;
    }

    for (const migration of appliedVersions) {
        logger.info({
            event: "event_store_migrated",
            databaseType: "postgres",
            schemaVersion: migration.version,
            migration: migration.name
        }, "PostgreSQL Event Store migration applied");
    }

    return Number(database.prepare(`
        SELECT COALESCE(MAX(version), 0) AS version
        FROM AlpacalySchemaMigrations
    `).get().version);
}
