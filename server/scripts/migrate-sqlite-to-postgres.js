#!/usr/bin/env node
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import dotenv from "dotenv";
import pg from "pg";

import { loadConfig } from "../src/config/index.js";
import { PostgresEventStore } from "../src/event-store/postgres-event-store.js";

dotenv.config({ quiet: true });

const TABLE_ORDER = [
    "Barns", "Feeders", "Cameras", "Devices", "Queues", "DailyFeedReservations",
    "ProviderEvents", "Contributions", "FeedIntents", "Outbox",
    "FeedIntentHistory", "Events", "LifecycleHistory", "Queue",
    "HardwareAcknowledgements", "Administrators", "RoleAssignments",
    "BarnScopes", "OperatorAuditRecords", "WelfareNotes", "ApprovalRequests",
    "ApprovalDecisions", "ApprovalRequestHistory", "EmergencyStops",
    "FeederDeviceAssignments", "OperatorResolutionCases", "DeviceCommands",
    "DeviceCommandOutbox", "DeviceCommandHistory", "DeviceAcknowledgements",
    "DeviceCommandAuditRecords", "SimulatedDeviceExecutions",
    "SimulatedDeviceFences", "WelfareSafetyLedger", "AuditRecords",
    "SimulatedControllers", "SimulatedControllerFeederAssignments",
    "ControllerAssignmentHistory", "SimulatedControllerCommandJournal",
    "SimulatedControllerJournalHistory", "MqttOutboundDeliveries",
    "MqttInboundMessages", "MqttProtocolEvents", "MqttSafetyStates",
    "EdgeControllerStatus", "EdgeControllerStatusHistory", "WorkerInstances",
    "DistributedWorkClaims", "WorkClaimHistory"
];

function usage() {
    return [
        "Usage: node scripts/migrate-sqlite-to-postgres.js --source <sqlite-file>",
        "       [--dry-run] [--approve-empty-target]",
        "",
        "The target is read only from DATABASE_URL; credentials are never accepted",
        "as command-line arguments or printed."
    ].join("\n");
}

function parseArguments(argv) {
    const options = {
        source: null,
        dryRun: false,
        approved: false
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--source") {
            options.source = argv[index + 1];
            index += 1;
        } else if (argument === "--dry-run") {
            options.dryRun = true;
        } else if (argument === "--approve-empty-target") {
            options.approved = true;
        } else if (["--help", "-h"].includes(argument)) {
            process.stdout.write(`${usage()}\n`);
            process.exit(0);
        } else {
            throw new Error(`Unknown argument: ${argument}`);
        }
    }
    if (!options.source) {
        throw new Error("--source is required.");
    }
    if (!existsSync(options.source)) {
        throw new Error("The SQLite source file does not exist.");
    }
    if (!options.dryRun && !options.approved) {
        throw new Error(
            "--approve-empty-target is required for a migration that writes data."
        );
    }
    return options;
}

function quoteIdentifier(identifier) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(identifier)) {
        throw new Error(`Unsafe database identifier: ${identifier}`);
    }
    return `"${identifier.toLowerCase()}"`;
}

function inspectSource(path) {
    const database = new DatabaseSync(path, { readOnly: true });
    database.exec("PRAGMA foreign_keys = ON;");
    const integrity = database.prepare("PRAGMA integrity_check;").get().integrity_check;
    if (integrity !== "ok") {
        database.close();
        throw new Error(`SQLite integrity check failed: ${integrity}`);
    }
    const names = new Set(database.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all().map(row => row.name));
    if (names.has("EdgeCommands") || !names.has("Events")) {
        database.close();
        throw new Error("The source is not an Alpacaly central SQLite database.");
    }
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check;").all();
    if (foreignKeyViolations.length > 0) {
        database.close();
        throw new Error("The SQLite source contains foreign-key violations.");
    }
    const counts = Object.fromEntries(TABLE_ORDER.filter(name => names.has(name)).map(
        name => [name, Number(database.prepare(
            `SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`
        ).get().count)]
    ));
    return { database, names, counts };
}

async function assertTargetIsEmpty(client) {
    const protectedTables = [
        "Events", "ProviderEvents", "Administrators", "DeviceCommands",
        "DistributedWorkClaims"
    ];
    for (const table of protectedTables) {
        const result = await client.query(
            `SELECT COUNT(*)::bigint AS count FROM ${quoteIdentifier(table)}`
        );
        if (Number(result.rows[0].count) !== 0) {
            throw new Error(`Target table ${table} is not empty; migration stopped.`);
        }
    }
}

async function insertTable(client, source, table) {
    if (!source.names.has(table)) {
        return 0;
    }
    const columns = source.database.prepare(
        `PRAGMA table_info(${quoteIdentifier(table)})`
    ).all().map(row => row.name);
    const rows = source.database.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all();
    if (rows.length === 0) {
        return 0;
    }
    const columnSql = columns.map(quoteIdentifier).join(", ");
    const parameters = columns.map((_, index) => `$${index + 1}`).join(", ");
    const conflict = ["Barns", "Feeders", "Devices", "Queues"].includes(table)
        ? " ON CONFLICT DO NOTHING" : "";
    for (const row of rows) {
        await client.query(
            `INSERT INTO ${quoteIdentifier(table)} (${columnSql}) VALUES (${parameters})${conflict}`,
            columns.map(column => {
                if (table === "FeedIntents" && column === "status"
                    && row[column] === "COMPLETED") {
                    return "PROCESSING";
                }
                if (table === "Outbox" && column === "status"
                    && row[column] === "COMPLETED") {
                    return "PROCESSING";
                }
                return row[column];
            })
        );
    }
    return rows.length;
}

async function resetIdentitySequences(client) {
    const identities = await client.query(`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND is_identity = 'YES'
    `);
    for (const row of identities.rows) {
        const table = quoteIdentifier(row.table_name);
        const column = quoteIdentifier(row.column_name);
        await client.query(`
            SELECT setval(
                pg_get_serial_sequence($1, $2),
                GREATEST(COALESCE((SELECT MAX(${column}) FROM ${table}), 0), 1),
                COALESCE((SELECT MAX(${column}) FROM ${table}), 0) > 0
            )
        `, [row.table_name, row.column_name]);
    }
    await client.query(`
        SELECT setval(
            'alpacalyeventsequence',
            GREATEST(COALESCE((SELECT MAX(sequencenumber) FROM events), 0), 1),
            COALESCE((SELECT MAX(sequencenumber) FROM events), 0) > 0
        )
    `);
}

async function restoreCompletedFeedStatuses(client, source) {
    for (const table of ["FeedIntents", "Outbox"]) {
        if (!source.names.has(table)) {
            continue;
        }
        const rows = source.database.prepare(`
            SELECT feedIntentId, status FROM ${quoteIdentifier(table)}
            WHERE status = 'COMPLETED'
        `).all();
        for (const row of rows) {
            await client.query(`
                UPDATE ${quoteIdentifier(table)} SET status = $1
                WHERE feedintentid = $2
            `, [row.status, row.feedIntentId]);
        }
    }
}

async function run() {
    const options = parseArguments(process.argv.slice(2));
    const source = inspectSource(options.source);
    const config = loadConfig({
        ...process.env,
        CENTRAL_DATABASE_TYPE: "postgres"
    }, { loadEnvFile: false });
    const pool = new pg.Pool({
        connectionString: config.postgresUrl,
        ssl: config.postgresSslMode === "disable" ? false : {
            rejectUnauthorized: config.postgresSslMode === "verify-full"
        },
        max: 1,
        connectionTimeoutMillis: config.postgresConnectionTimeoutMs,
        application_name: `${config.postgresApplicationName}-migration`
    });

    try {
        await pool.query("SELECT 1");
        if (options.dryRun) {
            const schema = await pool.query(`
                SELECT to_regclass('public.events') IS NOT NULL AS present
            `);
            let targetEmpty = null;
            if (schema.rows[0].present) {
                try {
                    await assertTargetIsEmpty(pool);
                    targetEmpty = true;
                } catch {
                    targetEmpty = false;
                }
            }
            process.stdout.write(`${JSON.stringify({
                dryRun: true,
                sourceIntegrity: "ok",
                sourceSchemaVersion: Number(source.database.prepare(
                    "PRAGMA user_version;"
                ).get().user_version),
                sourceRows: source.counts,
                targetReachable: true,
                targetSchemaPresent: schema.rows[0].present,
                targetDomainTablesEmpty: targetEmpty,
                writesPerformed: false
            }, null, 2)}\n`);
            return;
        }

        // Apply the target schema through the same production migration path.
        const migrationStore = new PostgresEventStore({
            config,
            logger: { info() {}, warn() {}, error() {} }
        });
        migrationStore.close();

        const client = await pool.connect();
        const migrated = {};
        try {
            await assertTargetIsEmpty(client);
            await client.query("BEGIN");
            await client.query("SET CONSTRAINTS ALL DEFERRED");
            for (const table of TABLE_ORDER) {
                migrated[table] = await insertTable(client, source, table);
            }
            await restoreCompletedFeedStatuses(client, source);
            const recoveryTime = new Date().toISOString();
            await client.query(`
                UPDATE distributedworkclaims
                SET state = 'FAILED', failedat = $1,
                    failurecode = 'OFFLINE_MIGRATION_RECOVERY',
                    failuremessage = 'Active SQLite ownership ended during offline migration',
                    nexteligibleat = $1, leaseexpiresat = NULL,
                    maximumexpiresat = NULL, heartbeatat = NULL,
                    terminal = 0, updatedat = $1
                WHERE state = 'ACTIVE'
            `, [recoveryTime]);
            await resetIdentitySequences(client);

            const verification = {};
            for (const [table, sourceCount] of Object.entries(source.counts)) {
                const targetResult = await client.query(
                    `SELECT COUNT(*)::bigint AS count FROM ${quoteIdentifier(table)}`
                );
                const targetCount = Number(targetResult.rows[0].count);
                if (targetCount < sourceCount) {
                    throw new Error(`Row-count reconciliation failed for ${table}.`);
                }
                verification[table] = { source: sourceCount, target: targetCount };
            }
            const constraints = await client.query(`
                SELECT COUNT(*)::bigint AS count
                FROM pg_constraint
                WHERE connamespace = 'public'::regnamespace AND NOT convalidated
            `);
            if (Number(constraints.rows[0].count) !== 0) {
                throw new Error("The target has unvalidated constraints.");
            }
            await client.query("COMMIT");
            process.stdout.write(`${JSON.stringify({
                dryRun: false,
                migrated,
                verification,
                activeClaimsRecovered: true,
                committed: true
            }, null, 2)}\n`);
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    } finally {
        source.database.close();
        await pool.end();
    }
}

run().catch(error => {
    process.stderr.write(`Migration failed safely: ${error.message}\n`);
    process.exitCode = 1;
});
