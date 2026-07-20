import { PostgresEventStore } from "../src/event-store/postgres-event-store.js";
import { DistributedClaimStore } from "../src/worker-coordination/distributed-claim-store.js";

const logger = { info() {}, warn() {}, error() {} };
const config = {
    postgresUrl: process.env.POSTGRES_BENCHMARK_URL,
    postgresPoolMinimum: 0,
    postgresPoolMaximum: 2,
    postgresConnectionTimeoutMs: 5000,
    postgresStatementTimeoutMs: 30_000,
    postgresLockTimeoutMs: 10_000,
    postgresIdleTransactionTimeoutMs: 30_000,
    postgresSslMode: process.env.POSTGRES_BENCHMARK_SSL_MODE || "disable",
    postgresApplicationName: "alpacaly-contention-worker"
};
const workerNumber = Number(process.env.BENCHMARK_WORKER_NUMBER);
const itemCount = Number(process.env.BENCHMARK_ITEM_COUNT);
const prefix = process.env.BENCHMARK_ITEM_PREFIX;
const startAt = Number(process.env.BENCHMARK_START_AT);
const store = new PostgresEventStore({ config, logger });
const claims = new DistributedClaimStore({
    eventStore: store,
    leaseDurationMs: 10_000,
    maximumClaimDurationMs: 60_000,
    clockSkewToleranceMs: 0,
    reclaimDelayMs: 0,
    maximumAttempts: 3
});
const identity = {
    workerId: `${prefix}:worker:${workerNumber}`,
    serviceType: "contention-baseline",
    processInstanceId: String(process.pid),
    bootId: `${prefix}:${process.pid}`,
    startedAt: new Date().toISOString(),
    softwareVersion: "benchmark",
    environment: "benchmark",
    metadata: { workerNumber }
};
claims.registerWorker(identity);
await new Promise(resolve => setTimeout(resolve, Math.max(0, startAt - Date.now())));
const started = performance.now();
let acquired = 0;
for (let offset = 0; offset < itemCount; offset += 1) {
    const index = (offset + workerNumber) % itemCount;
    const claim = claims.claim("CONTENTION_BASELINE", `${prefix}:item:${index}`, identity);
    if (claim) {
        acquired += 1;
        claims.complete(claim, identity, { benchmark: true });
    }
}
const elapsedMs = performance.now() - started;
claims.stopWorker(identity);
store.close();
process.stdout.write(`${JSON.stringify({ acquired, elapsedMs })}\n`);
