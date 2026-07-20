#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { PostgresEventStore } from "../src/event-store/postgres-event-store.js";

function integerArgument(name, fallback, maximum) {
    const index = process.argv.indexOf(name);
    if (index === -1) {
        return fallback;
    }
    const value = Number(process.argv[index + 1]);
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
        throw new Error(`${name} must be between 1 and ${maximum}.`);
    }
    return value;
}

function runWorker(environment) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [new URL("./postgres-contention-worker.js", import.meta.url).pathname],
            { env: environment, stdio: ["ignore", "pipe", "pipe"] }
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.on("error", reject);
        child.on("exit", code => {
            if (code === 0) {
                resolve(JSON.parse(stdout.trim()));
            } else {
                reject(new Error(`Contention worker failed: ${stderr}`));
            }
        });
    });
}

async function run() {
    if (!process.argv.includes("--approve-test-database")) {
        throw new Error("--approve-test-database is required; the baseline writes test rows.");
    }
    const url = process.env.POSTGRES_BENCHMARK_URL;
    if (!url) {
        throw new Error("POSTGRES_BENCHMARK_URL is required.");
    }
    const workers = integerArgument("--workers", 4, 16);
    const items = integerArgument("--items", 500, 10_000);
    const prefix = `contention-${randomUUID()}`;
    const startAt = Date.now() + 2000;
    const wallStarted = performance.now();
    const results = await Promise.all(Array.from({ length: workers }, (_, index) => (
        runWorker({
            ...process.env,
            POSTGRES_BENCHMARK_URL: url,
            BENCHMARK_WORKER_NUMBER: String(index),
            BENCHMARK_ITEM_COUNT: String(items),
            BENCHMARK_ITEM_PREFIX: prefix,
            BENCHMARK_START_AT: String(startAt)
        })
    )));
    const wallElapsedMs = performance.now() - wallStarted;

    const config = {
        postgresUrl: url,
        postgresPoolMinimum: 0,
        postgresPoolMaximum: 2,
        postgresConnectionTimeoutMs: 5000,
        postgresStatementTimeoutMs: 30_000,
        postgresLockTimeoutMs: 10_000,
        postgresIdleTransactionTimeoutMs: 30_000,
        postgresSslMode: process.env.POSTGRES_BENCHMARK_SSL_MODE || "disable",
        postgresApplicationName: "alpacaly-contention-baseline"
    };
    const store = new PostgresEventStore({
        config,
        logger: { info() {}, warn() {}, error() {} }
    });
    const verification = store.database.prepare(`
        SELECT state, COUNT(*) AS count
        FROM DistributedWorkClaims
        WHERE workType = 'CONTENTION_BASELINE' AND workItemId LIKE ?
        GROUP BY state
    `).all(`${prefix}:%`);
    store.close();
    const acquired = results.reduce((sum, result) => sum + result.acquired, 0);
    const completed = Number(
        verification.find(row => row.state === "COMPLETED")?.count || 0
    );
    if (acquired !== items || completed !== items) {
        throw new Error(
            `Correctness check failed: acquired=${acquired}, completed=${completed}, items=${items}.`
        );
    }
    process.stdout.write(`${JSON.stringify({
        workers,
        uniqueItems: items,
        totalClaimAttempts: workers * items,
        completed,
        duplicateOwners: 0,
        wallElapsedMs: Math.round(wallElapsedMs * 100) / 100,
        completedItemsPerSecond: Math.round((items * 1000 / wallElapsedMs) * 100) / 100,
        workerElapsedMs: results.map(result => Math.round(result.elapsedMs * 100) / 100)
    }, null, 2)}\n`);
}

run().catch(error => {
    process.stderr.write(`Contention baseline failed safely: ${error.message}\n`);
    process.exitCode = 1;
});
