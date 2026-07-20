import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import pg from "pg";

import { createAdministratorSecurityServices } from "../src/administrator-security/index.js";
import { createContributionLedgerServices } from "../src/contribution-ledger/index.js";
import { createDeviceCommandServices } from "../src/device-commands/index.js";
import { createPostgresBackup } from "../src/disaster-recovery/postgres-backup-service.js";
import { RecoverySafetyService } from "../src/disaster-recovery/recovery-safety-service.js";
import { restorePostgresBackup } from "../src/disaster-recovery/postgres-restore-service.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import { PostgresEventStore } from "../src/event-store/postgres-event-store.js";
import { createOperatorSafetyServices } from "../src/operator-safety/index.js";
import { createTestLogger, testConfig } from "./helpers.js";

const { Client } = pg;
const postgresUrl = process.env.POSTGRES_TEST_URL;
const skip = postgresUrl ? false : "POSTGRES_TEST_URL is not configured";

function databaseUrl(base, name) {
    const parsed = new URL(base);
    parsed.pathname = `/${name}`;
    return parsed.toString();
}

function safeDatabaseName(prefix) {
    return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function quoteIdentifier(value) {
    if (!/^[a-z0-9_]+$/.test(value)) {
        throw new Error("Unsafe disposable database identifier.");
    }
    return `"${value}"`;
}

function postgresConfig(url, applicationName) {
    return {
        ...testConfig,
        centralDatabaseType: "postgres",
        postgresUrl: url,
        postgresPoolMinimum: 0,
        postgresPoolMaximum: 4,
        postgresConnectionTimeoutMs: 5000,
        postgresStatementTimeoutMs: 15000,
        postgresLockTimeoutMs: 5000,
        postgresIdleTransactionTimeoutMs: 15000,
        postgresSslMode: process.env.POSTGRES_TEST_SSL_MODE || "disable",
        postgresApplicationName: applicationName,
        workerLeaseDurationMs: 5000,
        workerHeartbeatIntervalMs: 500,
        workerStaleThresholdMs: 5000,
        workerReclaimDelayMs: 0,
        workerMaximumClaimDurationMs: 30_000,
        workerClockSkewToleranceMs: 0,
        workerMaximumAttempts: 3,
        workerSoftwareVersion: "restore-drill-test",
        workerId: null,
        workerInstanceId: null,
        recoverySafetyMode: false,
        backupRetentionDailyDays: 14,
        backupRetentionWeeklyWeeks: 8,
        backupRetentionMonthlyMonths: 12,
        backupMinimumRetentionDays: 7
    };
}

async function withAdminClient(callback) {
    const maintenanceUrl = databaseUrl(postgresUrl, "postgres");
    const client = new Client({ connectionString: maintenanceUrl });
    await client.connect();
    try {
        return await callback(client);
    } finally {
        await client.end();
    }
}

async function createDatabase(name) {
    await withAdminClient(client => client.query(
        `CREATE DATABASE ${quoteIdentifier(name)}`
    ));
}

async function dropDatabase(name) {
    await withAdminClient(async client => {
        await client.query(`
            SELECT pg_terminate_backend(pid)
            FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()
        `, [name]);
        await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
    });
}

function administratorContext(administrators) {
    const administratorId = "administrator_development_platform_admin";
    const administrator = administrators.store.getAdministrator(administratorId);
    return {
        identity: {
            ...administrator,
            authenticationStrength: "DEVELOPMENT",
            assignments: administrators.store.getIdentityAssignments(administratorId)
        },
        authorization: { effectiveRole: "ADMINISTRATOR" },
        requestId: "postgres-restore-drill-emergency-stop",
        reason: "PostgreSQL restore drill"
    };
}

test("PostgreSQL native backup restores safely into a disposable database", {
    skip,
    timeout: 120_000
}, async t => {
    const sourceName = safeDatabaseName("alpacaly_backup_source");
    const targetName = safeDatabaseName("alpacaly_restore_target");
    const sourceUrl = databaseUrl(postgresUrl, sourceName);
    const targetUrl = databaseUrl(postgresUrl, targetName);
    const outputDirectory = mkdtempSync(join(tmpdir(), "alpacaly-pg-restore-drill-"));
    t.after(() => rmSync(outputDirectory, { recursive: true, force: true }));
    t.after(async () => {
        await dropDatabase(targetName);
        await dropDatabase(sourceName);
    });
    await createDatabase(sourceName);
    await createDatabase(targetName);

    const logger = createTestLogger();
    const sourceConfig = postgresConfig(
        sourceUrl,
        "alpacaly-backup-source-test"
    );
    const sourceEngine = new EventEngine({
        config: sourceConfig,
        logger,
        autoProcess: false
    });
    const sourceDevices = createDeviceCommandServices({
        eventEngine: sourceEngine,
        config: sourceConfig,
        logger,
        startWorker: false
    });
    const sourceLedger = createContributionLedgerServices({
        eventEngine: sourceEngine,
        config: sourceConfig,
        logger,
        startOutboxWorker: false
    });
    const sourceAdministrators = createAdministratorSecurityServices({
        eventEngine: sourceEngine,
        deviceCommandServices: sourceDevices,
        config: sourceConfig
    });
    const sourceSafety = createOperatorSafetyServices({
        eventEngine: sourceEngine,
        deviceCommandServices: sourceDevices,
        administratorSecurityServices: sourceAdministrators,
        config: sourceConfig
    });

    const externalEventId = `restore-drill-${randomUUID()}`;
    const contribution = sourceLedger.developmentWebsiteContributionService.simulate({
        supporterName: "PostgreSQL restore drill",
        externalEventId,
        amountMinor: 750,
        currency: "GBP",
        message: "Disposable restore verification"
    });
    const safeCommand = sourceDevices.deviceCommandService.ensureCommandForEvent(
        contribution.feedRequest,
        "RING_BELL"
    ).command;
    let uncertainCommand = sourceDevices.deviceCommandService.ensureCommandForEvent(
        contribution.feedRequest,
        "DISPENSE_FEED"
    ).command;
    uncertainCommand = sourceDevices.deviceCommandStore.transitionCommand(
        uncertainCommand.commandId,
        "OUTCOME_UNKNOWN",
        {
            timestamp: "2026-07-20T12:00:03.000Z",
            lastError: "Restore drill uncertain physical outcome"
        }
    );
    sourceDevices.deviceCommandService.commandOutcomeUnknown(uncertainCommand);
    sourceSafety.emergencyStopService.activate({
        level: "PLATFORM",
        reason: "Restore drill emergency stop"
    }, administratorContext(sourceAdministrators));

    sourceDevices.claimStore.registerWorker(sourceDevices.workerIdentity);
    const activeClaim = sourceDevices.claimStore.claim(
        "RESTORE_DRILL",
        "active-claim",
        sourceDevices.workerIdentity
    );
    const completedClaim = sourceDevices.claimStore.claim(
        "RESTORE_DRILL",
        "completed-claim",
        sourceDevices.workerIdentity
    );
    sourceDevices.claimStore.complete(completedClaim, sourceDevices.workerIdentity);

    const beforeCounts = {
        events: Number(sourceEngine.eventStore.database.prepare(`
            SELECT COUNT(*) AS count FROM Events
        `).get().count),
        commands: Number(sourceEngine.eventStore.database.prepare(`
            SELECT COUNT(*) AS count FROM DeviceCommands
        `).get().count),
        audit: Number(sourceEngine.eventStore.database.prepare(`
            SELECT COUNT(*) AS count FROM OperatorAuditRecords
        `).get().count)
    };
    const backup = await createPostgresBackup({
        config: sourceConfig,
        outputDirectory,
        environment: "test",
        notes: "GitHub PostgreSQL disposable restore drill",
        logger
    });

    await sourceDevices.worker.stop();
    sourceLedger.outboxWorker.stop();
    sourceEngine.close();

    await assert.rejects(restorePostgresBackup({
        manifestPath: backup.manifestPath,
        targetConnectionString: sourceUrl,
        activeConnectionString: postgresUrl,
        targetEnvironment: "test",
        isolatedTarget: true,
        approveEmptyTarget: true,
        config: sourceConfig,
        logger
    }), /Non-empty restore target requires destructive approval/);

    const targetConfig = postgresConfig(
        targetUrl,
        "alpacaly-restore-target-test"
    );
    const restored = await restorePostgresBackup({
        manifestPath: backup.manifestPath,
        targetConnectionString: targetUrl,
        activeConnectionString: postgresUrl,
        targetEnvironment: "test",
        isolatedTarget: true,
        approveEmptyTarget: true,
        approveMigrations: false,
        config: targetConfig,
        logger
    });
    assert.equal(restored.report.status, "PASS");
    assert.equal(restored.report.workersStarted, false);
    assert.equal(restored.report.feedingStarted, false);
    assert.equal(restored.report.claimFencing.fenced >= 1, true);
    assert.equal(restored.report.commandClassification.counts.PROVEN_NOT_SENT, 1);
    assert.equal(restored.report.commandClassification.counts.OUTCOME_UNKNOWN, 1);

    const restoredStore = new PostgresEventStore({
        config: targetConfig,
        logger
    });
    const recovery = new RecoverySafetyService({
        eventStore: restoredStore,
        config: { recoverySafetyMode: false },
        logger
    });
    assert.equal(recovery.isBlocked(), true);
    assert.equal(Number(restoredStore.database.prepare(`
        SELECT COUNT(*) AS count FROM EmergencyStops WHERE status = 'ACTIVE'
    `).get().count), 1);
    assert.equal(Number(restoredStore.database.prepare(`
        SELECT COUNT(*) AS count FROM OperatorResolutionCases WHERE status = 'OPEN'
    `).get().count), 1);
    assert.equal(Number(restoredStore.database.prepare(`
        SELECT COUNT(*) AS count FROM OperatorAuditRecords
    `).get().count), beforeCounts.audit);
    assert.equal(restoredStore.database.prepare(`
        SELECT state, claimGeneration FROM DistributedWorkClaims
        WHERE workType = 'RESTORE_DRILL' AND workItemId = 'active-claim'
    `).get().state, "AVAILABLE");
    assert.ok(Number(restoredStore.database.prepare(`
        SELECT claimGeneration FROM DistributedWorkClaims
        WHERE workType = 'RESTORE_DRILL' AND workItemId = 'active-claim'
    `).get().claimGeneration) > activeClaim.claimGeneration);
    assert.equal(restoredStore.database.prepare(`
        SELECT state FROM DistributedWorkClaims
        WHERE workType = 'RESTORE_DRILL' AND workItemId = 'completed-claim'
    `).get().state, "COMPLETED");
    assert.throws(
        () => recovery.assertCommandMayProgress(uncertainCommand.commandId),
        error => error.code === "RECOVERY_SAFETY_MODE_ACTIVE"
    );

    const safeRelease = recovery.releaseSafeWork({
        decisionId: "restore-drill-safe-work-review"
    });
    assert.equal(safeRelease.released, 1);
    const workerRelease = recovery.releaseWorkers({
        decisionId: "restore-drill-supervised-release"
    });
    assert.equal(workerRelease.mode, "NORMAL");
    assert.throws(
        () => recovery.assertCommandMayProgress(uncertainCommand.commandId),
        error => error.code === "RESTORED_COMMAND_REVIEW_REQUIRED"
    );
    restoredStore.close();

    const releasedEngine = new EventEngine({
        config: targetConfig,
        logger,
        autoProcess: false
    });
    const releasedDevices = createDeviceCommandServices({
        eventEngine: releasedEngine,
        config: targetConfig,
        logger,
        startWorker: false
    });
    const releasedLedger = createContributionLedgerServices({
        eventEngine: releasedEngine,
        config: targetConfig,
        logger,
        startOutboxWorker: false
    });
    const duplicate = releasedLedger.developmentWebsiteContributionService.simulate({
        supporterName: "PostgreSQL restore drill",
        externalEventId,
        amountMinor: 750,
        currency: "GBP",
        message: "Disposable restore verification"
    });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.feedRequest.eventId, contribution.feedRequest.eventId);
    assert.equal(releasedDevices.deviceCommandService.ensureCommandForEvent(
        duplicate.feedRequest,
        "RING_BELL"
    ).created, false);
    assert.equal(releasedDevices.deviceCommandService.ensureCommandForEvent(
        duplicate.feedRequest,
        "DISPENSE_FEED"
    ).created, false);
    assert.equal(Number(releasedEngine.eventStore.database.prepare(`
        SELECT COUNT(*) AS count FROM Events
    `).get().count), beforeCounts.events);
    assert.equal(Number(releasedEngine.eventStore.database.prepare(`
        SELECT COUNT(*) AS count FROM DeviceCommands
    `).get().count), beforeCounts.commands);
    assert.equal(
        releasedDevices.deviceCommandStore.getSimulatedExecution(
            uncertainCommand.commandId
        ),
        null
    );
    assert.equal(
        releasedDevices.deviceCommandStore.getCommand(safeCommand.commandId).status,
        "PENDING"
    );
    await releasedDevices.worker.stop();
    releasedLedger.outboxWorker.stop();
    releasedEngine.close();
});
