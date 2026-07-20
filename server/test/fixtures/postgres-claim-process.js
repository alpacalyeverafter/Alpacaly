import { PostgresEventStore } from "../../src/event-store/postgres-event-store.js";
import { DistributedClaimStore } from "../../src/worker-coordination/distributed-claim-store.js";

const logger = { info() {}, warn() {}, error() {} };
const workerId = process.env.CLAIM_TEST_WORKER_ID;
const workItemId = process.env.CLAIM_TEST_WORK_ITEM_ID;
const startAt = Number(process.env.CLAIM_TEST_START_AT);
const config = {
    postgresUrl: process.env.POSTGRES_TEST_URL,
    postgresPoolMinimum: 0,
    postgresPoolMaximum: 2,
    postgresConnectionTimeoutMs: 5000,
    postgresStatementTimeoutMs: 15000,
    postgresLockTimeoutMs: 5000,
    postgresIdleTransactionTimeoutMs: 15000,
    postgresSslMode: process.env.POSTGRES_TEST_SSL_MODE || "disable",
    postgresApplicationName: "alpacaly-postgres-claim-test"
};

const store = new PostgresEventStore({ config, logger });
const claims = new DistributedClaimStore({
    eventStore: store,
    leaseDurationMs: 5000,
    maximumClaimDurationMs: 30_000,
    clockSkewToleranceMs: 0,
    reclaimDelayMs: 0,
    maximumAttempts: 3
});
const identity = {
    workerId,
    serviceType: "postgres-process-test",
    processInstanceId: `${process.pid}`,
    bootId: `${workerId}-${process.pid}`,
    startedAt: new Date().toISOString(),
    softwareVersion: "test",
    environment: "test",
    metadata: { pid: process.pid }
};
claims.registerWorker(identity);

await new Promise(resolve => setTimeout(resolve, Math.max(0, startAt - Date.now())));
const claim = claims.claim("POSTGRES_PROCESS_TEST", workItemId, identity);
process.stdout.write(`${JSON.stringify({ acquired: Boolean(claim), workerId })}\n`);
store.close();
