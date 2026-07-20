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

test("SQLite remains the zero-setup non-production default", () => {
    const config = loadConfig({
        NODE_ENV: "development",
        DATABASE_PATH: ":memory:"
    }, { loadEnvFile: false });
    assert.equal(config.centralDatabaseType, "sqlite");
    assert.equal(config.postgresUrl, null);
    assert.equal(config.databasePath, ":memory:");
});
