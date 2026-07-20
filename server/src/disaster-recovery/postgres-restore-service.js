import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { PostgresEventStore } from "../event-store/postgres-event-store.js";
import { POSTGRES_SCHEMA_VERSION } from "../event-store/postgres/migrations/index.js";
import { BackupCatalogue } from "./backup-catalogue.js";
import {
    databaseName,
    isSameDatabase,
    readBackupManifest,
    safeDatabaseIdentity,
    verifyBackupChecksum
} from "./backup-manifest.js";
import {
    assertPostgresToolAvailable,
    createPostgresClient,
    runPostgresTool
} from "./postgres-tools.js";
import { RecoverySafetyService } from "./recovery-safety-service.js";
import { RestoredDataReconciler } from "./restored-data-reconciler.js";

const NULL_LOGGER = Object.freeze({
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}
});

function targetStoreConfig(connectionString, config) {
    return {
        ...config,
        centralDatabaseType: "postgres",
        postgresUrl: connectionString,
        postgresPoolMinimum: config.postgresPoolMinimum ?? 0,
        postgresPoolMaximum: config.postgresPoolMaximum ?? 4,
        postgresConnectionTimeoutMs: config.postgresConnectionTimeoutMs ?? 5000,
        postgresStatementTimeoutMs: config.postgresStatementTimeoutMs ?? 15000,
        postgresLockTimeoutMs: config.postgresLockTimeoutMs ?? 5000,
        postgresIdleTransactionTimeoutMs:
            config.postgresIdleTransactionTimeoutMs ?? 15000,
        postgresSslMode: config.postgresSslMode || "disable",
        postgresApplicationName: "alpacaly-isolated-restore",
        recoverySafetyMode: true
    };
}

function writeRestoreReport(reportPath, report) {
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: "utf8",
        flag: "w",
        mode: 0o600
    });
}

async function inspectTarget(connectionString, config) {
    const client = createPostgresClient(connectionString, {
        sslMode: config.postgresSslMode,
        tlsCaPath: config.postgresTlsCaPath
    });
    await client.connect();
    try {
        const tables = await client.query(`
            SELECT COUNT(*)::integer AS count
            FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        `);
        const connections = await client.query(`
            SELECT COUNT(*)::integer AS count
            FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
        `);
        return {
            tableCount: Number(tables.rows[0].count),
            otherConnectionCount: Number(connections.rows[0].count)
        };
    } finally {
        await client.end();
    }
}

async function resetTarget(connectionString, config) {
    const client = createPostgresClient(connectionString, {
        sslMode: config.postgresSslMode,
        tlsCaPath: config.postgresTlsCaPath
    });
    await client.connect();
    try {
        await client.query("DROP SCHEMA public CASCADE");
        await client.query("CREATE SCHEMA public");
    } finally {
        await client.end();
    }
}

async function restoredSchemaVersion(connectionString, config) {
    const client = createPostgresClient(connectionString, {
        sslMode: config.postgresSslMode,
        tlsCaPath: config.postgresTlsCaPath
    });
    await client.connect();
    try {
        const result = await client.query(`
            SELECT COALESCE(MAX(version), 0)::integer AS version
            FROM AlpacalySchemaMigrations
        `);
        return Number(result.rows[0].version);
    } finally {
        await client.end();
    }
}

export async function restorePostgresBackup({
    manifestPath,
    targetConnectionString,
    activeConnectionString = null,
    targetEnvironment = "test",
    isolatedTarget = false,
    approveEmptyTarget = false,
    approveDestructive = false,
    confirmTargetDatabase = null,
    approveMigrations = false,
    config = {},
    clock = () => new Date(),
    idGenerator = randomUUID,
    commandRunner = runPostgresTool,
    pgRestoreBinary = "pg_restore",
    logger = NULL_LOGGER
}) {
    const restoreId = `restore-${idGenerator()}`;
    const startedAt = clock().toISOString();
    const reportPath = resolve(
        dirname(manifestPath),
        `${restoreId}.restore-report.json`
    );
    const manifest = readBackupManifest(manifestPath);
    const baseReport = {
        reportVersion: 1,
        reportId: restoreId,
        backupId: manifest.backupId,
        startedAt,
        targetEnvironment: String(targetEnvironment).toLowerCase(),
        targetDatabaseIdentity: safeDatabaseIdentity(targetConnectionString),
        workersStarted: false,
        feedingStarted: false
    };
    let eventStore = null;
    let recoverySafetyService = null;
    try {
        if (!["test", "staging"].includes(baseReport.targetEnvironment)) {
            throw new Error(
                "This phase permits restore execution only in test or staging environments."
            );
        }
        if (!isolatedTarget) {
            throw new Error("Restore requires an explicitly isolated target database.");
        }
        if (activeConnectionString && isSameDatabase(
            activeConnectionString,
            targetConnectionString
        )) {
            throw new Error("Restore refuses the configured active application database.");
        }
        if (manifest.migrationVersion > POSTGRES_SCHEMA_VERSION) {
            throw new Error(
                `Backup schema ${manifest.migrationVersion} is newer than supported schema ${POSTGRES_SCHEMA_VERSION}.`
            );
        }
        const checksum = await verifyBackupChecksum(manifestPath, manifest);
        if (!checksum.valid) {
            const error = new Error("Backup checksum verification failed.");
            error.code = "BACKUP_CHECKSUM_FAILED";
            throw error;
        }
        await assertPostgresToolAvailable(pgRestoreBinary, commandRunner);
        const targetName = databaseName(targetConnectionString);
        const target = await inspectTarget(targetConnectionString, config);
        if (target.otherConnectionCount > 0) {
            throw new Error(
                "Restore target has active connections; application writers must be stopped."
            );
        }
        const tableCount = target.tableCount;
        if (tableCount === 0 && !approveEmptyTarget) {
            throw new Error("Empty restore target requires explicit approval.");
        }
        if (tableCount > 0) {
            if (!approveDestructive || confirmTargetDatabase !== targetName) {
                throw new Error(
                    "Non-empty restore target requires destructive approval and exact database-name confirmation."
                );
            }
            await resetTarget(targetConnectionString, config);
        }

        await commandRunner(pgRestoreBinary, [
            "--exit-on-error",
            "--no-owner",
            "--no-privileges",
            resolve(dirname(manifestPath), manifest.artifact.fileName)
        ], { connectionString: targetConnectionString });

        const restoredVersion = await restoredSchemaVersion(
            targetConnectionString,
            config
        );
        if (restoredVersion > POSTGRES_SCHEMA_VERSION) {
            throw new Error(
                `Restored schema ${restoredVersion} is newer than supported schema ${POSTGRES_SCHEMA_VERSION}.`
            );
        }
        if (restoredVersion < POSTGRES_SCHEMA_VERSION && !approveMigrations) {
            throw new Error(
                "Restored schema is older; migrations require explicit approval."
            );
        }

        eventStore = new PostgresEventStore({
            config: targetStoreConfig(targetConnectionString, config),
            logger
        });
        recoverySafetyService = new RecoverySafetyService({
            eventStore,
            config: { recoverySafetyMode: false },
            logger,
            clock
        });
        recoverySafetyService.markRestored({ backupId: manifest.backupId });
        recoverySafetyService.insertEvent(
            "RESTORE_STARTED",
            manifest.backupId,
            startedAt,
            { restoreId }
        );
        const commandClassification = recoverySafetyService
            .classifyRestoredCommands({ backupId: manifest.backupId });
        const claimFencing = recoverySafetyService.fenceRestoredClaims({
            backupId: manifest.backupId
        });
        const reconciler = new RestoredDataReconciler({
            eventStore,
            expectedSchemaVersion: POSTGRES_SCHEMA_VERSION,
            clock,
            idGenerator
        });
        const reconciliation = reconciler.run({ requireRecoveryMode: true });
        recoverySafetyService.recordReconciliation(reconciliation);
        recoverySafetyService.insertEvent(
            "RESTORE_COMPLETED",
            manifest.backupId,
            clock().toISOString(),
            { restoreId, reconciliationStatus: reconciliation.status }
        );
        const report = {
            ...baseReport,
            completedAt: clock().toISOString(),
            status: reconciliation.status,
            checksum: { status: "PASS", algorithm: checksum.algorithm },
            manifestCompatibility: "PASS",
            restoredSchemaVersion: eventStore.getSchemaVersion(),
            commandClassification,
            claimFencing,
            reconciliation,
            recoverySafety: recoverySafetyService.getDiagnostics()
        };
        writeRestoreReport(reportPath, report);
        new BackupCatalogue({ directory: dirname(manifestPath), clock })
            .recordRestoreTest(manifestPath, {
                status: reconciliation.status,
                reportId: restoreId,
                testedAt: report.completedAt
            });
        return { report, reportPath };
    } catch (error) {
        if (recoverySafetyService) {
            recoverySafetyService.insertEvent(
                "RESTORE_FAILED",
                manifest.backupId,
                clock().toISOString(),
                { restoreId, failureCode: error.code || "RESTORE_FAILED" }
            );
        }
        const report = {
            ...baseReport,
            failedAt: clock().toISOString(),
            status: "FAILED",
            failureCode: error.code || "RESTORE_FAILED",
            manifestFileName: basename(manifestPath)
        };
        writeRestoreReport(reportPath, report);
        throw error;
    } finally {
        eventStore?.close();
    }
}

export function reconcileRestoredDatabase({
    eventStore,
    recoverySafetyService,
    expectedSchemaVersion = POSTGRES_SCHEMA_VERSION,
    clock = () => new Date(),
    idGenerator = randomUUID
}) {
    const report = new RestoredDataReconciler({
        eventStore,
        expectedSchemaVersion,
        clock,
        idGenerator
    }).run({ requireRecoveryMode: true });
    recoverySafetyService.recordReconciliation(report);
    return report;
}
