import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config/index.js";

const productionPostgres = {
    NODE_ENV: "production",
    CENTRAL_DATABASE_TYPE: "postgres",
    DATABASE_URL: "postgresql://app_user:secret@db.example.com/alpacaly",
    POSTGRES_SSL_MODE: "verify-full"
};

test("production requires PostgreSQL without a SQLite fallback", () => {
    assert.throws(() => loadConfig({
        NODE_ENV: "production",
        DATABASE_PATH: ":memory:"
    }, { loadEnvFile: false }), /requires CENTRAL_DATABASE_TYPE=postgres/);
    assert.throws(() => loadConfig({
        NODE_ENV: "production",
        CENTRAL_DATABASE_TYPE: "postgres"
    }, { loadEnvFile: false }), /DATABASE_URL is required/);
});

test("production rejects unsafe PostgreSQL endpoints and TLS modes", () => {
    assert.throws(() => loadConfig({
        ...productionPostgres,
        DATABASE_URL: "postgresql://app_user:secret@localhost/alpacaly"
    }, { loadEnvFile: false }), /loopback/);
    assert.throws(() => loadConfig({
        ...productionPostgres,
        DATABASE_URL: "postgresql://dev_user:secret@db.example.com/alpacaly"
    }, { loadEnvFile: false }), /development database credentials/);
    assert.throws(() => loadConfig({
        ...productionPostgres,
        POSTGRES_SSL_MODE: "require"
    }, { loadEnvFile: false }), /requires POSTGRES_SSL_MODE=verify-full/);
});

test("connection and lease bounds fail closed", () => {
    assert.throws(() => loadConfig({
        POSTGRES_POOL_MINIMUM: "5",
        POSTGRES_POOL_MAXIMUM: "4"
    }, { loadEnvFile: false }), /must not exceed/);
    assert.throws(() => loadConfig({
        WORKER_LEASE_DURATION_MS: "1000",
        WORKER_HEARTBEAT_INTERVAL_MS: "1000"
    }, { loadEnvFile: false }), /must be shorter/);
    assert.throws(() => loadConfig({
        WORKER_LEASE_DURATION_MS: "5000",
        WORKER_HEARTBEAT_INTERVAL_MS: "500",
        WORKER_STALE_THRESHOLD_MS: "1000"
    }, { loadEnvFile: false }), /at least the worker lease/);
});

test("recovery configuration rejects unsafe catalogue paths and parses worker blocking", () => {
    assert.throws(() => loadConfig({
        BACKUP_CATALOGUE_DIRECTORY: "relative/backups"
    }, { loadEnvFile: false }), /must be an absolute path/);
    const config = loadConfig({
        RECOVERY_SAFETY_MODE: "true",
        BACKUP_CATALOGUE_DIRECTORY: "/tmp/alpacaly-backup-catalogue"
    }, { loadEnvFile: false });
    assert.equal(config.recoverySafetyMode, true);
    assert.equal(config.backupCatalogueDirectory, "/tmp/alpacaly-backup-catalogue");
    assert.equal(config.backupRetentionDailyDays, 14);
    assert.equal(config.restoreDrillMaximumAgeDays, 30);
});

test("managed backup operations require an external evidence directory", () => {
    assert.throws(() => loadConfig({
        MANAGED_BACKUP_OPERATIONS_ENABLED: "true"
    }, { loadEnvFile: false }), /MANAGED_BACKUP_EVIDENCE_DIRECTORY is required/);
    assert.throws(() => loadConfig({
        MANAGED_BACKUP_EVIDENCE_DIRECTORY: "relative/provider-evidence"
    }, { loadEnvFile: false }), /must be an absolute path/);
    assert.throws(() => loadConfig({
        MANAGED_BACKUP_OPERATIONS_ENABLED: "true",
        MANAGED_BACKUP_EVIDENCE_DIRECTORY: "/tmp/alpacaly-managed-evidence"
    }, { loadEnvFile: false }), /EXPECTED_DATABASE_IDENTITY/);
    const config = loadConfig({
        MANAGED_BACKUP_OPERATIONS_ENABLED: "true",
        MANAGED_BACKUP_EVIDENCE_DIRECTORY: "/tmp/alpacaly-managed-evidence",
        MANAGED_BACKUP_EXPECTED_ENVIRONMENT: "production",
        MANAGED_BACKUP_EXPECTED_DATABASE_IDENTITY: `sha256:${"a".repeat(64)}`,
        MANAGED_BACKUP_EXPECTED_REGION: "uk-south",
        MANAGED_BACKUP_RPO_MINUTES: "20"
    }, { loadEnvFile: false });
    assert.equal(config.managedBackupOperationsEnabled, true);
    assert.equal(config.managedBackupExpectedEnvironment, "production");
    assert.equal(config.managedBackupExpectedRegion, "uk-south");
    assert.equal(config.managedBackupRecoveryPointObjectiveMinutes, 20);
});

test("SQLite remains the zero-setup non-production default", () => {
    const config = loadConfig({
        NODE_ENV: "development",
        DATABASE_PATH: ":memory:"
    }, { loadEnvFile: false });
    assert.equal(config.centralDatabaseType, "sqlite");
    assert.equal(config.postgresUrl, null);
    assert.equal(config.databasePath, ":memory:");
});
