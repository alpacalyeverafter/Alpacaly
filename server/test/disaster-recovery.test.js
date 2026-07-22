import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import request from "supertest";

import { createApp } from "../src/app.js";
import { createAdministratorSecurityServices } from "../src/administrator-security/index.js";
import { createContributionLedgerServices } from "../src/contribution-ledger/index.js";
import { createDeviceCommandServices } from "../src/device-commands/index.js";
import {
    BackupCatalogue,
    RecoverySafetyService,
    RestoredDataReconciler,
    calculateRetentionExpiry,
    createBackupManifest,
    readBackupManifest,
    safeDatabaseIdentity,
    verifyBackupChecksum,
    writeBackupManifest
} from "../src/disaster-recovery/index.js";
import { createPostgresBackup } from "../src/disaster-recovery/postgres-backup-service.js";
import { restorePostgresBackup } from "../src/disaster-recovery/postgres-restore-service.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import { POSTGRES_SCHEMA_VERSION } from "../src/event-store/postgres/migrations/index.js";
import { createOperatorSafetyServices } from "../src/operator-safety/index.js";
import { DEFAULT_RESOURCE_IDS } from "../src/domain/resources.js";
import { createTestLogger, testConfig } from "./helpers.js";

function temporaryDirectory(t, prefix = "alpacaly-recovery-") {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function checksum(value) {
    return createHash("sha256").update(value).digest("hex");
}

function createManifestFixture(t, overrides = {}) {
    const directory = temporaryDirectory(t, "alpacaly-manifest-");
    const backupId = overrides.backupId || "backup-test-fixture";
    const artifactFileName = `${backupId}.dump`;
    const artifactPath = join(directory, artifactFileName);
    const payload = overrides.payload || "representative-postgresql-backup";
    writeFileSync(artifactPath, payload);
    const manifest = createBackupManifest({
        backupId,
        createdAt: overrides.createdAt || "2026-07-20T10:00:00.000Z",
        environment: overrides.environment || "test",
        sourceDatabaseIdentity: safeDatabaseIdentity(
            "postgres://source:secret@localhost/source_test"
        ),
        migrationVersion: overrides.migrationVersion || POSTGRES_SCHEMA_VERSION,
        applicationVersion: "1.0.0",
        postgresVersion: "16.4",
        artifact: {
            fileName: artifactFileName,
            format: "POSTGRES_CUSTOM",
            compression: "pg_dump custom level 9",
            sizeBytes: Buffer.byteLength(payload),
            checksum: overrides.checksum || checksum(payload)
        },
        encryption: { status: "NONE", provider: null },
        retentionExpiresAt: overrides.retentionExpiresAt
            || "2026-08-20T10:00:00.000Z",
        legalOrIncidentHold: overrides.legalOrIncidentHold || false,
        restoreTest: { status: "NOT_TESTED" },
        notes: "Test fixture"
    });
    const manifestPath = join(directory, `${backupId}.manifest.json`);
    writeBackupManifest(manifestPath, manifest);
    return { directory, artifactPath, manifest, manifestPath };
}

function createCentralContext({ config = {}, databasePath = ":memory:" } = {}) {
    const resolvedConfig = { ...testConfig, ...config, databasePath };
    const logger = createTestLogger();
    const eventEngine = new EventEngine({
        config: resolvedConfig,
        logger,
        autoProcess: false
    });
    const devices = createDeviceCommandServices({
        eventEngine,
        config: resolvedConfig,
        logger,
        startWorker: false
    });
    const ledger = createContributionLedgerServices({
        eventEngine,
        config: resolvedConfig,
        logger,
        startOutboxWorker: false
    });
    return { resolvedConfig, logger, eventEngine, devices, ledger };
}

test("backup manifests record version, checksum, compatibility and catalogue evidence", async t => {
    const fixture = createManifestFixture(t);
    const restored = readBackupManifest(fixture.manifestPath);
    assert.equal(restored.manifestVersion, 1);
    assert.equal(restored.artifact.format, "POSTGRES_CUSTOM");
    assert.match(restored.sourceDatabaseIdentity, /^sha256:[a-f0-9]{64}$/);
    assert.equal((await verifyBackupChecksum(fixture.manifestPath)).valid, true);

    const catalogue = new BackupCatalogue({ directory: fixture.directory });
    assert.equal(catalogue.list().length, 1);
    const updated = catalogue.recordRestoreTest(fixture.manifestPath, {
        status: "PASS",
        reportId: "restore-report-1",
        testedAt: "2026-07-21T10:00:00.000Z"
    });
    assert.equal(updated.restoreTest.status, "PASS");
    assert.equal(
        updated.restoreTest.mostRecentSuccessfulAt,
        "2026-07-21T10:00:00.000Z"
    );
});

test("checksum failure is detected before restore tooling runs", async t => {
    const fixture = createManifestFixture(t);
    writeFileSync(fixture.artifactPath, "tampered-backup");
    const verification = await verifyBackupChecksum(fixture.manifestPath);
    assert.equal(verification.valid, false);
    await assert.rejects(
        restorePostgresBackup({
            manifestPath: fixture.manifestPath,
            targetConnectionString: "postgres://target:secret@localhost/restore_test",
            isolatedTarget: true,
            approveEmptyTarget: true,
            config: { postgresSslMode: "disable" },
            commandRunner: async () => {
                throw new Error("tool must not run");
            }
        }),
        error => error.code === "BACKUP_CHECKSUM_FAILED"
    );
});

test("retention supports daily, weekly, monthly, minimum and incident hold", () => {
    const createdAt = "2026-07-20T10:00:00.000Z";
    const policy = {
        dailyDays: 14,
        weeklyWeeks: 8,
        monthlyMonths: 12,
        minimumDays: 30
    };
    assert.equal(
        calculateRetentionExpiry({ createdAt, cadence: "daily", policy }),
        "2026-08-19T10:00:00.000Z"
    );
    assert.equal(
        calculateRetentionExpiry({ createdAt, cadence: "weekly", policy }),
        "2026-09-14T10:00:00.000Z"
    );
    assert.equal(calculateRetentionExpiry({
        createdAt,
        cadence: "monthly",
        policy,
        legalOrIncidentHold: true
    }), null);
});

test("expired deletion is explicit, test-only and leaves audit evidence", t => {
    const fixture = createManifestFixture(t, {
        retentionExpiresAt: "2026-07-01T00:00:00.000Z"
    });
    const catalogue = new BackupCatalogue({
        directory: fixture.directory,
        clock: () => new Date("2026-07-20T00:00:00.000Z"),
        idGenerator: () => "deletion-test"
    });
    assert.throws(() => catalogue.deleteExpiredTestBackups(), /explicit approval/);
    assert.equal(catalogue.deleteExpiredTestBackups({ approved: true }).length, 1);
    assert.equal(existsSync(fixture.artifactPath), false);
    const evidence = join(
        fixture.directory,
        "backup-deletion-deletion-test.deletion-audit.json"
    );
    assert.equal(JSON.parse(readFileSync(evidence, "utf8")).deleted.length, 1);
});

test("backup refuses SQLite and reports missing PostgreSQL-native tooling", async t => {
    const outputDirectory = temporaryDirectory(t, "alpacaly-backup-output-");
    await assert.rejects(createPostgresBackup({
        config: { centralDatabaseType: "sqlite", nodeEnv: "test" },
        outputDirectory
    }), /PostgreSQL central persistence is required/);
    await assert.rejects(createPostgresBackup({
        config: {
            ...testConfig,
            centralDatabaseType: "postgres",
            postgresUrl: "postgres://source:secret@localhost/source_test",
            postgresSslMode: "disable"
        },
        outputDirectory,
        commandRunner: async () => {
            const error = new Error("pg_dump is not installed or is not executable.");
            error.code = "POSTGRES_TOOL_UNAVAILABLE";
            throw error;
        }
    }), error => error.code === "POSTGRES_TOOL_UNAVAILABLE");
});

test("restore refuses active targets and unsupported future schemas before mutation", async t => {
    const active = "postgres://active:secret@localhost/active_test";
    const fixture = createManifestFixture(t);
    await assert.rejects(restorePostgresBackup({
        manifestPath: fixture.manifestPath,
        targetConnectionString: active,
        activeConnectionString: active,
        isolatedTarget: true,
        approveEmptyTarget: true
    }), /active application database/);

    const future = createManifestFixture(t, {
        backupId: "future-schema",
        migrationVersion: POSTGRES_SCHEMA_VERSION + 1
    });
    await assert.rejects(restorePostgresBackup({
        manifestPath: future.manifestPath,
        targetConnectionString: "postgres://target:secret@localhost/target_test",
        isolatedTarget: true,
        approveEmptyTarget: true
    }), /newer than supported schema/);
});

test("recovery safety mode blocks lifecycle, FeedIntent, commands and controllers", async () => {
    const context = createCentralContext({ config: { recoverySafetyMode: true } });
    assert.equal(context.eventEngine.lifecycleWorkerRegistered, false);
    assert.equal(context.ledger.outboxWorker.start(), false);
    assert.equal(context.devices.worker.start(), false);
    assert.throws(() => context.eventEngine.createFeedRequestFromFeedIntent({
        supporterName: "Blocked restore"
    }, {
        feedIntentId: "intent_blocked",
        contributionId: "contribution_blocked"
    }), error => error.code === "RECOVERY_SAFETY_MODE_ACTIVE");
    assert.throws(() => context.devices.deviceCommandService.ensureCommandForEvent({
        eventId: "event_blocked",
        barnId: DEFAULT_RESOURCE_IDS.barnId,
        feederId: DEFAULT_RESOURCE_IDS.feederId,
        contributionId: "contribution_blocked"
    }, "DISPENSE_FEED"), error => error.code === "RECOVERY_SAFETY_MODE_ACTIVE");
    const controller = context.devices.controllerService.list()[0];
    assert.throws(
        () => context.devices.controllerService.setEnabled(controller.controllerId, true, {}),
        error => error.code === "RECOVERY_SAFETY_MODE_ACTIVE"
    );
    await context.devices.worker.stop();
    context.eventEngine.close();
});

test("restore fencing invalidates old workers and individually locks uncertain commands", async () => {
    const context = createCentralContext();
    const feed = context.ledger.developmentWebsiteContributionService.simulate({
        supporterName: "Recovery fixture",
        clientRequestId: "recovery-fixture"
    }).feedRequest;
    let command = context.devices.deviceCommandService.ensureCommandForEvent(
        feed,
        "DISPENSE_FEED"
    ).command;
    const completedCommand = context.devices.deviceCommandStore.transitionCommand(
        context.devices.deviceCommandService.ensureCommandForEvent(
            feed,
            "RING_BELL"
        ).command.commandId,
        "ACKNOWLEDGED",
        { timestamp: "2026-07-20T10:00:00.500Z" }
    );
    command = context.devices.deviceCommandStore.transitionCommand(command.commandId, "SENT", {
        timestamp: "2026-07-20T10:00:01.000Z",
        acknowledgementDeadline: "2026-07-20T10:00:02.000Z",
        incrementAttempt: true
    });
    context.devices.claimStore.registerWorker(context.devices.workerIdentity);
    const active = context.devices.claimStore.claim(
        "DEVICE_COMMAND",
        command.commandId,
        context.devices.workerIdentity
    );
    const completed = context.devices.claimStore.claim(
        "RECOVERY_TEST",
        "completed-work",
        context.devices.workerIdentity
    );
    context.devices.claimStore.complete(completed, context.devices.workerIdentity);

    const recovery = context.eventEngine.recoverySafetyService;
    recovery.markRestored({ backupId: "backup-restore-test" });
    const classifications = recovery.classifyRestoredCommands({
        backupId: "backup-restore-test"
    });
    const fencing = recovery.fenceRestoredClaims({ backupId: "backup-restore-test" });
    assert.equal(classifications.counts.UNCERTAIN, 1);
    assert.equal(classifications.counts.COMPLETED, 1);
    assert.equal(fencing.operatorReview, 1);
    assert.equal(
        context.devices.claimStore.get("DEVICE_COMMAND", command.commandId).state,
        "OPERATOR_REVIEW"
    );
    assert.ok(
        context.devices.claimStore.get("DEVICE_COMMAND", command.commandId)
            .claimGeneration > active.claimGeneration
    );
    assert.equal(
        context.devices.claimStore.get("RECOVERY_TEST", "completed-work").state,
        "COMPLETED"
    );
    assert.equal(
        context.devices.claimStore.getHistory("DEVICE_COMMAND", command.commandId)
            .at(-1).action,
        "RESTORE_FENCED"
    );
    assert.throws(() => context.eventEngine.eventStore.database.prepare(`
        UPDATE DisasterRecoveryEvents SET eventType = 'MUTATED'
    `).run(), /append-only/);

    const report = new RestoredDataReconciler({
        eventStore: context.eventEngine.eventStore
    }).run();
    assert.equal(report.status, "PASS");
    recovery.recordReconciliation(report);
    recovery.releaseWorkers({ decisionId: "approved-recovery-release" });
    const before = context.devices.deviceCommandStore.getCommand(command.commandId);
    const after = await context.devices.worker.processCommand(command.commandId);
    assert.equal(after.status, before.status);
    assert.equal(
        context.devices.deviceCommandStore.getSimulatedExecution(command.commandId),
        null
    );
    assert.equal(
        context.devices.deviceCommandStore.getCommand(completedCommand.commandId).status,
        "ACKNOWLEDGED"
    );
    await context.devices.worker.stop();
    context.eventEngine.close();
});

test("releaseSafeWork releases only genuinely proven-not-sent restored commands", async () => {
    const context = createCentralContext();
    const feed = context.ledger.developmentWebsiteContributionService.simulate({
        supporterName: "Safe restored work fixture",
        clientRequestId: "safe-restored-work-fixture"
    }).feedRequest;
    const command = context.devices.deviceCommandService.ensureCommandForEvent(
        feed,
        "RING_BELL"
    ).command;
    assert.equal(command.status, "READY");

    const recovery = context.eventEngine.recoverySafetyService;
    recovery.markRestored({ backupId: "backup-proven-not-sent" });
    const classifications = recovery.classifyRestoredCommands({
        backupId: "backup-proven-not-sent"
    });
    assert.deepEqual(classifications, {
        total: 1,
        counts: {
            PROVEN_NOT_SENT: 1,
            UNCERTAIN: 0,
            COMPLETED: 0,
            OUTCOME_UNKNOWN: 0
        },
        unresolved: 1
    });

    const firstRelease = recovery.releaseSafeWork({
        decisionId: "approved-safe-work-release"
    });
    assert.deepEqual(firstRelease, { released: 1, unresolved: 0 });
    assert.equal(context.eventEngine.eventStore.database.prepare(`
        SELECT reviewStatus FROM RestoredCommandReviews WHERE commandId = ?
    `).get(command.commandId).reviewStatus, "SAFE_WORK_RELEASED");
    assert.deepEqual(recovery.releaseSafeWork({
        decisionId: "duplicate-safe-work-release"
    }), { released: 0, unresolved: 0 });

    await context.devices.worker.stop();
    context.ledger.outboxWorker.stop();
    context.eventEngine.close();
});

test("emergency stops, OUTCOME_UNKNOWN cases and audit history survive recovery blocking", async t => {
    const directory = temporaryDirectory(t, "alpacaly-recovery-persistence-");
    const databasePath = join(directory, "central.sqlite");
    const resolvedConfig = { ...testConfig, databasePath };
    const logger = createTestLogger();
    const eventEngine = new EventEngine({
        config: resolvedConfig,
        logger,
        autoProcess: false
    });
    const devices = createDeviceCommandServices({
        eventEngine,
        config: resolvedConfig,
        logger
    });
    const ledger = createContributionLedgerServices({
        eventEngine,
        config: resolvedConfig,
        logger
    });
    const administrators = createAdministratorSecurityServices({
        eventEngine,
        deviceCommandServices: devices,
        config: resolvedConfig
    });
    const safety = createOperatorSafetyServices({
        eventEngine,
        deviceCommandServices: devices,
        administratorSecurityServices: administrators,
        config: resolvedConfig
    });
    const feed = ledger.developmentWebsiteContributionService.simulate({
        supporterName: "Unknown recovery fixture",
        clientRequestId: "unknown-recovery-fixture"
    }).feedRequest;
    let command = devices.deviceCommandService.ensureCommandForEvent(
        feed,
        "DISPENSE_FEED"
    ).command;
    command = devices.deviceCommandStore.transitionCommand(command.commandId,
        "OUTCOME_UNKNOWN", {
            timestamp: "2026-07-20T10:00:03.000Z",
            lastError: "Physical outcome cannot be proven"
        });
    devices.deviceCommandService.commandOutcomeUnknown(command);
    const late = devices.acknowledgementService.record({
        acknowledgementId: "late-restored-acknowledgement",
        commandId: command.commandId,
        deviceId: command.deviceId,
        acknowledgementType: "DISPENSE_FEED_RESULT",
        receivedAt: "2026-07-20T10:00:04.000Z",
        deviceTimestamp: "2026-07-20T10:00:03.500Z",
        result: "SUCCEEDED",
        measuredQuantity: 1,
        metadata: { delayedDuringRecovery: true }
    });
    assert.equal(late.command.status, "OUTCOME_UNKNOWN");
    assert.equal(late.late, true);
    const administratorId = "administrator_development_platform_admin";
    const identity = administrators.store.getAdministrator(administratorId);
    const actionContext = {
        identity: {
            ...identity,
            authenticationStrength: "DEVELOPMENT",
            assignments: administrators.store.getIdentityAssignments(administratorId)
        },
        authorization: { effectiveRole: "ADMINISTRATOR" },
        requestId: "recovery-emergency-stop",
        reason: "Recovery safety test"
    };
    safety.emergencyStopService.activate({
        level: "PLATFORM",
        reason: "Disaster recovery fixture"
    }, actionContext);
    eventEngine.recoverySafetyService.markRestored({ backupId: "backup-persistent" });
    eventEngine.close();

    const restored = new EventEngine({
        config: resolvedConfig,
        logger,
        autoProcess: true
    });
    assert.equal(restored.recoverySafetyService.isBlocked(), true);
    assert.equal(restored.lifecycleWorkerRegistered, false);
    assert.equal(Number(restored.eventStore.database.prepare(`
        SELECT COUNT(*) AS count FROM EmergencyStops WHERE status = 'ACTIVE'
    `).get().count), 1);
    assert.equal(Number(restored.eventStore.database.prepare(`
        SELECT COUNT(*) AS count FROM OperatorResolutionCases WHERE status = 'OPEN'
    `).get().count), 1);
    assert.ok(Number(restored.eventStore.database.prepare(`
        SELECT COUNT(*) AS count FROM OperatorAuditRecords
    `).get().count) > 0);
    restored.close();
});

test("protected recovery diagnostics are secret-free and report blocked workers", async () => {
    const config = { ...testConfig, recoverySafetyMode: true };
    const app = createApp({ config, logger: createTestLogger() });
    const readiness = await request(app).get("/health/ready").expect(503);
    assert.equal(readiness.body.persistence.reachable, true);
    assert.equal(readiness.body.recovery.workersBlocked, true);
    const response = await request(app)
        .get("/api/admin/diagnostics/persistence")
        .set("authorization", "Development local-admin")
        .expect(200);
    assert.equal(response.body.disasterRecovery.workersBlocked, true);
    assert.equal(response.body.disasterRecovery.mode, "BLOCKED");
    const serialized = JSON.stringify(response.body);
    assert.doesNotMatch(serialized, /postgres:\/\//i);
    assert.doesNotMatch(serialized, /backupCatalogueDirectory/i);
    await app.locals.deviceCommandServices.worker.stop();
    app.locals.contributionLedgerServices.outboxWorker.stop();
    app.locals.eventEngine.close();
});
