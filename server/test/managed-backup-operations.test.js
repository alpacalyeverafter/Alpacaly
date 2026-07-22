import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
    BackupCatalogue,
    BackupHoldRegistry,
    ManagedBackupOperationsService,
    RecoveryDiagnosticsService,
    createBackupManifest,
    createManagedBackupEvidence,
    readManagedBackupEvidence,
    writeBackupManifest,
    writeManagedBackupEvidence
} from "../src/disaster-recovery/index.js";

const NOW = "2026-07-22T12:00:00.000Z";
const DATABASE_IDENTITY = `sha256:${"a".repeat(64)}`;

function temporaryDirectory(t) {
    const directory = mkdtempSync(join(tmpdir(), "alpacaly-managed-backup-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function managedEvidence(overrides = {}) {
    const base = {
        evidenceVersion: 1,
        evidenceId: "managed-evidence-2026-07-22-1155",
        collectedAt: "2026-07-22T11:55:00.000Z",
        environment: "staging",
        provider: {
            name: "example-managed-postgres",
            service: "managed-postgresql",
            region: "uk-south",
            backupReference: "snapshot-safe-reference"
        },
        database: {
            identity: DATABASE_IDENTITY,
            postgresVersion: "16.4"
        },
        backup: {
            status: "AVAILABLE",
            latestSuccessfulAt: "2026-07-22T06:00:00.000Z",
            encrypted: true,
            encryptionKeyManagement: "PROVIDER_MANAGED",
            restorable: true,
            retentionDays: 30
        },
        pitr: {
            enabled: true,
            continuous: true,
            earliestRecoveryAt: "2026-07-08T00:00:00.000Z",
            latestRecoveryAt: "2026-07-22T11:53:00.000Z",
            latestWalAt: "2026-07-22T11:54:00.000Z",
            gapDetected: false
        },
        access: {
            applicationRoleSeparated: true,
            backupRoleSeparated: true,
            restoreRoleSeparated: true,
            humanMfaRequired: true,
            administrativeAuditLogging: true
        },
        collection: {
            source: "PROVIDER_API",
            exporterVersion: "test-exporter-1"
        }
    };
    return {
        ...base,
        ...overrides,
        provider: { ...base.provider, ...overrides.provider },
        database: { ...base.database, ...overrides.database },
        backup: { ...base.backup, ...overrides.backup },
        pitr: { ...base.pitr, ...overrides.pitr },
        access: { ...base.access, ...overrides.access },
        collection: { ...base.collection, ...overrides.collection }
    };
}

function backupFixture(directory, {
    backupId = "backup-managed-operations-fixture",
    retentionExpiresAt = "2026-08-01T00:00:00.000Z",
    legalOrIncidentHold = false
} = {}) {
    const payload = "managed backup operations fixture";
    const artifactFileName = `${backupId}.dump`;
    writeFileSync(join(directory, artifactFileName), payload);
    const manifestPath = join(directory, `${backupId}.manifest.json`);
    writeBackupManifest(manifestPath, createBackupManifest({
        backupId,
        createdAt: "2026-07-20T10:00:00.000Z",
        environment: "staging",
        sourceDatabaseIdentity: DATABASE_IDENTITY,
        migrationVersion: 4,
        applicationVersion: "1.0.0",
        postgresVersion: "16.4",
        artifact: {
            fileName: artifactFileName,
            format: "POSTGRES_CUSTOM",
            compression: "pg_dump custom level 9",
            sizeBytes: Buffer.byteLength(payload),
            checksum: createHash("sha256").update(payload).digest("hex")
        },
        encryption: { status: "MANAGED_PROVIDER", provider: "test-provider" },
        retentionExpiresAt,
        legalOrIncidentHold,
        restoreTest: { status: "NOT_TESTED" },
        notes: "Managed operations test fixture"
    }));
    return { backupId, manifestPath };
}

function recordRecentRestoreDrill(directory) {
    const fixture = backupFixture(directory);
    writeFileSync(join(directory, "managed-restore-drill-pass.restore-report.json"), JSON.stringify({
        reportVersion: 1,
        reportId: "managed-restore-drill-pass",
        backupId: fixture.backupId,
        targetEnvironment: "staging",
        completedAt: "2026-07-21T12:00:00.000Z",
        status: "PASS",
        workersStarted: false,
        feedingStarted: false
    }));
    new BackupCatalogue({ directory }).recordRestoreTest(fixture.manifestPath, {
        status: "PASS",
        reportId: "managed-restore-drill-pass",
        testedAt: "2026-07-21T12:00:00.000Z"
    });
    return fixture;
}

test("managed provider evidence is allow-listed, checksummed and append-only", t => {
    const directory = temporaryDirectory(t);
    const evidence = createManagedBackupEvidence(managedEvidence());
    assert.match(evidence.evidenceDigest, /^[a-f0-9]{64}$/);
    assert.equal(evidence.backup.encrypted, true);

    const written = writeManagedBackupEvidence(directory, evidence);
    assert.deepEqual(readManagedBackupEvidence(written.path), evidence);
    assert.throws(
        () => writeManagedBackupEvidence(directory, evidence),
        error => error.code === "EEXIST"
    );

    const tampered = JSON.parse(readFileSync(written.path, "utf8"));
    tampered.backup.retentionDays = 1;
    writeFileSync(written.path, JSON.stringify(tampered));
    assert.throws(
        () => readManagedBackupEvidence(written.path),
        error => error.code === "MANAGED_BACKUP_EVIDENCE_DIGEST_MISMATCH"
    );
    const catalogueReport = new ManagedBackupOperationsService({
        directory,
        expectedEnvironment: "staging",
        expectedDatabaseIdentity: DATABASE_IDENTITY,
        expectedRegion: "uk-south"
    }).evaluate();
    assert.equal(catalogueReport.status, "BLOCKED");
    assert.equal(
        catalogueReport.alerts[0].code,
        "MANAGED_BACKUP_EVIDENCE_CATALOGUE_INVALID"
    );
    assert.throws(
        () => createManagedBackupEvidence({
            ...managedEvidence(),
            provider: {
                ...managedEvidence().provider,
                accessToken: "must-never-be-imported"
            }
        }),
        error => error.code === "MANAGED_BACKUP_EVIDENCE_SECRET_FIELD"
    );
});

test("healthy backup, PITR, access and restore evidence produces a PASS record", t => {
    const directory = temporaryDirectory(t);
    recordRecentRestoreDrill(directory);
    const service = new ManagedBackupOperationsService({
        directory,
        expectedEnvironment: "staging",
        expectedDatabaseIdentity: DATABASE_IDENTITY,
        expectedRegion: "uk-south",
        clock: () => new Date(NOW),
        idGenerator: () => "healthy-check"
    });
    const recorded = service.recordEvidence(managedEvidence());
    assert.equal(recorded.report.status, "PASS");
    assert.deepEqual(recorded.report.alerts, []);
    assert.equal(recorded.report.evidence.provider, "example-managed-postgres");
    assert.equal(recorded.report.evidence.backupAgeSeconds, 21_600);

    const check = service.recordCheck();
    assert.equal(check.record.status, "PASS");
    assert.equal(check.record.restoreDrill.reportId, "managed-restore-drill-pass");
    assert.doesNotMatch(JSON.stringify(check.record), /snapshot-safe-reference/);
});

test("managed backup evaluation fails closed on stale, unsafe and gapped evidence", t => {
    const directory = temporaryDirectory(t);
    recordRecentRestoreDrill(directory);
    const service = new ManagedBackupOperationsService({
        directory,
        expectedEnvironment: "production",
        expectedDatabaseIdentity: DATABASE_IDENTITY,
        expectedRegion: "uk-south",
        maximumEvidenceAgeMinutes: 10,
        clock: () => new Date(NOW)
    });
    const report = service.evaluate(managedEvidence({
        collectedAt: "2026-07-22T11:30:00.000Z",
        provider: { region: "eu-west" },
        database: { identity: `sha256:${"b".repeat(64)}` },
        backup: {
            status: "FAILED",
            encrypted: false,
            restorable: false,
            retentionDays: 7
        },
        pitr: {
            continuous: false,
            latestRecoveryAt: "2026-07-22T10:00:00.000Z",
            latestWalAt: "2026-07-22T10:00:00.000Z",
            gapDetected: true
        },
        access: { restoreRoleSeparated: false }
    }));
    const codes = new Set(report.alerts.map(alert => alert.code));
    assert.equal(report.status, "BLOCKED");
    for (const code of [
        "MANAGED_BACKUP_EVIDENCE_STALE",
        "MANAGED_BACKUP_ENVIRONMENT_MISMATCH",
        "MANAGED_BACKUP_DATABASE_MISMATCH",
        "MANAGED_BACKUP_REGION_MISMATCH",
        "MANAGED_BACKUP_NOT_AVAILABLE",
        "MANAGED_BACKUP_ENCRYPTION_DISABLED",
        "MANAGED_BACKUP_NOT_RESTORABLE",
        "MANAGED_BACKUP_RETENTION_TOO_SHORT",
        "MANAGED_PITR_NOT_CONTINUOUS",
        "MANAGED_PITR_GAP_DETECTED",
        "MANAGED_PITR_RPO_EXCEEDED",
        "MANAGED_RESTORE_ROLE_NOT_SEPARATED"
    ]) {
        assert.equal(codes.has(code), true, code);
    }
});

test("manifest-only restore metadata cannot satisfy the managed restore-drill check", t => {
    const directory = temporaryDirectory(t);
    const fixture = backupFixture(directory);
    new BackupCatalogue({ directory }).recordRestoreTest(fixture.manifestPath, {
        status: "PASS",
        reportId: "missing-restore-report",
        testedAt: "2026-07-21T12:00:00.000Z"
    });
    const report = new ManagedBackupOperationsService({
        directory,
        expectedEnvironment: "staging",
        expectedDatabaseIdentity: DATABASE_IDENTITY,
        expectedRegion: "uk-south",
        clock: () => new Date(NOW)
    }).evaluate(managedEvidence());
    assert.equal(report.status, "BLOCKED");
    assert.equal(report.alerts.some(
        alert => alert.code === "MANAGED_RESTORE_DRILL_OVERDUE"
    ), true);
});

test("append-only incident holds protect expired backups until explicit release", t => {
    const directory = temporaryDirectory(t);
    const fixture = backupFixture(directory, {
        retentionExpiresAt: "2026-07-01T00:00:00.000Z"
    });
    const ids = ["apply-event", "release-event"];
    const registry = new BackupHoldRegistry({
        directory,
        clock: () => new Date(NOW),
        idGenerator: () => ids.shift()
    });
    const catalogue = new BackupCatalogue({
        directory,
        clock: () => new Date(NOW)
    });
    assert.equal(catalogue.identifyExpired().length, 1);

    registry.apply({
        backupId: fixture.backupId,
        holdId: "incident-2026-07-22",
        holdType: "INCIDENT",
        decisionId: "incident-decision-apply",
        authorityReference: "incident-commander-01",
        reason: "Preserve the selected recovery point during incident review."
    });
    assert.equal(catalogue.identifyExpired().length, 0);
    assert.equal(catalogue.getDiagnostics().activeHoldCount, 1);
    assert.throws(() => registry.apply({
        backupId: fixture.backupId,
        holdId: "incident-2026-07-22",
        holdType: "INCIDENT",
        decisionId: "replay",
        authorityReference: "incident-commander-01",
        reason: "Replay"
    }), /already been used/);

    registry.release({
        holdId: "incident-2026-07-22",
        decisionId: "incident-decision-release",
        authorityReference: "incident-commander-02",
        reason: "Incident evidence was transferred to the approved archive."
    });
    assert.equal(catalogue.identifyExpired().length, 1);
    assert.equal(registry.events().length, 2);
    assert.equal(registry.activeHolds().length, 0);

    const firstEventPath = join(directory, readdirSync(directory)
        .find(name => name.includes("apply-event.backup-hold-event.json")));
    const tampered = JSON.parse(readFileSync(firstEventPath, "utf8"));
    tampered.reason = "Tampered hold reason";
    writeFileSync(firstEventPath, JSON.stringify(tampered));
    assert.throws(
        () => catalogue.identifyExpired(),
        /Backup hold event digest does not match/
    );
});

test("protected diagnostics expose safe managed-operation status without raw provider data", t => {
    const directory = temporaryDirectory(t);
    recordRecentRestoreDrill(directory);
    new ManagedBackupOperationsService({
        directory,
        expectedEnvironment: "staging",
        expectedDatabaseIdentity: DATABASE_IDENTITY,
        expectedRegion: "uk-south",
        clock: () => new Date(NOW)
    }).recordEvidence(managedEvidence());
    const diagnostics = new RecoveryDiagnosticsService({
        recoverySafetyService: {
            getDiagnostics: () => ({ mode: "NORMAL", workersBlocked: false })
        },
        config: {
            backupCatalogueDirectory: directory,
            backupMaximumAgeHours: 24,
            restoreDrillMaximumAgeDays: 30,
            managedBackupOperationsEnabled: true,
            managedBackupEvidenceDirectory: directory,
            managedBackupExpectedEnvironment: "staging",
            managedBackupExpectedDatabaseIdentity: DATABASE_IDENTITY,
            managedBackupExpectedRegion: "uk-south",
            managedBackupMaximumEvidenceAgeMinutes: 30,
            managedBackupRecoveryPointObjectiveMinutes: 15,
            managedBackupMinimumRetentionDays: 14
        },
        clock: () => new Date(NOW)
    }).getDiagnostics();
    assert.equal(diagnostics.managedBackup.status, "PASS");
    assert.equal(diagnostics.derivedCounters.managedBackupBlocked, 0);
    assert.equal(diagnostics.configuration.managedOperationsEnabled, true);
    const serialized = JSON.stringify(diagnostics);
    assert.doesNotMatch(serialized, /snapshot-safe-reference/);
    assert.doesNotMatch(serialized, /managed-backup-.*\.json/);
    assert.doesNotMatch(serialized, new RegExp(directory.replaceAll("/", "\\/")));
});

test("the scheduled managed-backup command emits machine-readable PASS and BLOCKED results", t => {
    const directory = temporaryDirectory(t);
    recordRecentRestoreDrill(directory);
    const now = Date.now();
    const currentEvidence = managedEvidence({
        evidenceId: "managed-evidence-cli-pass",
        collectedAt: new Date(now - 60_000).toISOString(),
        backup: { latestSuccessfulAt: new Date(now - 60 * 60_000).toISOString() },
        pitr: {
            earliestRecoveryAt: new Date(now - 7 * 24 * 60 * 60_000).toISOString(),
            latestRecoveryAt: new Date(now - 2 * 60_000).toISOString(),
            latestWalAt: new Date(now - 60_000).toISOString()
        }
    });
    const passInput = join(directory, "provider-pass-input.json");
    writeFileSync(passInput, JSON.stringify(currentEvidence));
    const command = join(process.cwd(), "scripts/managed-backup-check.js");
    const commonArguments = [
        command,
        "--directory", directory,
        "--restore-catalogue-directory", directory,
        "--expected-environment", "staging",
        "--expected-database-identity", DATABASE_IDENTITY,
        "--expected-region", "uk-south"
    ];
    const pass = spawnSync(process.execPath, [
        ...commonArguments,
        "--evidence", passInput
    ], { encoding: "utf8" });
    assert.equal(pass.status, 0, pass.stderr);
    assert.equal(JSON.parse(pass.stdout).status, "PASS");

    const blockedInput = join(directory, "provider-blocked-input.json");
    writeFileSync(blockedInput, JSON.stringify({
        ...currentEvidence,
        evidenceId: "managed-evidence-cli-blocked",
        pitr: { ...currentEvidence.pitr, gapDetected: true }
    }));
    const blocked = spawnSync(process.execPath, [
        ...commonArguments,
        "--evidence", blockedInput
    ], { encoding: "utf8" });
    assert.equal(blocked.status, 2, blocked.stderr);
    const report = JSON.parse(blocked.stdout);
    assert.equal(report.status, "BLOCKED");
    assert.equal(report.alerts.some(
        alert => alert.code === "MANAGED_PITR_GAP_DETECTED"
    ), true);
});
