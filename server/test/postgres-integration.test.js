import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import test from "node:test";

import { createContributionLedgerServices } from "../src/contribution-ledger/index.js";
import { DEFAULT_RESOURCE_IDS } from "../src/domain/resources.js";
import { createPaymentRequest } from "../src/domain/payments.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import { PostgresEventStore } from "../src/event-store/postgres-event-store.js";
import {
    SqliteOperatorSafetyStore
} from "../src/operator-safety/sqlite-operator-safety-store.js";
import { DistributedClaimStore } from "../src/worker-coordination/distributed-claim-store.js";
import { createTestLogger, testConfig } from "./helpers.js";

const postgresUrl = process.env.POSTGRES_TEST_URL;
const skip = postgresUrl ? false : "POSTGRES_TEST_URL is not configured";

function postgresConfig() {
    return {
        ...testConfig,
        nodeEnv: "test",
        centralDatabaseType: "postgres",
        postgresUrl,
        postgresPoolMinimum: 0,
        postgresPoolMaximum: 4,
        postgresConnectionTimeoutMs: 5000,
        postgresStatementTimeoutMs: 15000,
        postgresLockTimeoutMs: 5000,
        postgresIdleTransactionTimeoutMs: 15000,
        postgresSslMode: process.env.POSTGRES_TEST_SSL_MODE || "disable",
        postgresApplicationName: "alpacaly-postgres-integration",
        workerLeaseDurationMs: 5000,
        workerHeartbeatIntervalMs: 500,
        workerStaleThresholdMs: 5000,
        workerReclaimDelayMs: 0,
        workerMaximumClaimDurationMs: 30_000,
        workerClockSkewToleranceMs: 0,
        workerMaximumAttempts: 3,
        workerSoftwareVersion: "test",
        workerId: null,
        workerInstanceId: null
    };
}

function runClaimProcess({ workerId, workItemId, startAt }) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [new URL("./fixtures/postgres-claim-process.js", import.meta.url).pathname],
            {
                env: {
                    ...process.env,
                    POSTGRES_TEST_URL: postgresUrl,
                    CLAIM_TEST_WORKER_ID: workerId,
                    CLAIM_TEST_WORK_ITEM_ID: workItemId,
                    CLAIM_TEST_START_AT: String(startAt)
                },
                stdio: ["ignore", "pipe", "pipe"]
            }
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.on("error", reject);
        child.on("exit", code => {
            if (code !== 0) {
                reject(new Error(`Claim process failed: ${stderr}`));
                return;
            }
            resolve(JSON.parse(stdout.trim()));
        });
    });
}

test("PostgreSQL migrations and the central Event Store preserve domain behavior", {
    skip
}, () => {
    const config = postgresConfig();
    const logger = createTestLogger();
    const eventStore = new PostgresEventStore({ config, logger });
    const eventEngine = new EventEngine({
        config,
        logger,
        eventStore,
        autoProcess: false
    });
    const services = createContributionLedgerServices({
        eventEngine,
        eventStore,
        config,
        logger,
        startOutboxWorker: false,
        outboxRetryDelayMs: 0
    });
    const externalEventId = `postgres-integration-${randomUUID()}`;
    const result = services.developmentWebsiteContributionService.simulate({
        externalEventId,
        supporterName: "PostgreSQL Integration",
        amountMinor: 500,
        currency: "GBP",
        message: "PostgreSQL persistence parity"
    });

    const paymentRequest = createPaymentRequest({
        provider: "STRIPE",
        mode: "TEST",
        clientRequestId: `postgres-payment-${randomUUID()}`,
        supporterDisplayName: "PostgreSQL Payment",
        amountMinor: 500,
        currency: "GBP"
    });
    eventStore.createPaymentRequest(paymentRequest);
    eventStore.attachPaymentCheckoutSession(paymentRequest.paymentRequestId, {
        checkoutSessionId: `cs_test_${randomUUID()}`,
        checkoutUrl: "https://checkout.stripe.test/postgres",
        providerStatus: "open",
        updatedAt: new Date().toISOString()
    });

    assert.equal(eventStore.getSchemaVersion(), 5);
    assert.equal(result.created, true);
    assert.equal(eventStore.getFeedIntent(result.feedIntent.feedIntentId).status, "COMPLETED");
    assert.equal(eventStore.getEventIdByFeedIntent(result.feedIntent.feedIntentId),
        result.feedRequest.eventId);
    assert.equal(eventStore.getPersistenceDiagnostics().databaseType, "postgres");
    assert.equal(
        eventStore.getPaymentRequest(paymentRequest.paymentRequestId).status,
        "PENDING"
    );

    services.outboxWorker.stop();
    eventEngine.close();
});

test("PostgreSQL optional emergency-stop filters accept null and typed values", {
    skip
}, () => {
    const eventStore = new PostgresEventStore({
        config: postgresConfig(),
        logger: createTestLogger()
    });
    const store = new SqliteOperatorSafetyStore({ eventStore });
    const activeId = `postgres-null-filter-active-${randomUUID()}`;
    const clearedId = `postgres-null-filter-cleared-${randomUUID()}`;
    const administratorId = `postgres-null-filter-admin-${randomUUID()}`;
    const stopIds = [activeId, clearedId];
    const selectTestStops = filters => store.getEmergencyStops(filters)
        .filter(stop => stopIds.includes(stop.emergencyStopId));

    eventStore.database.exec("BEGIN");
    try {
        eventStore.database.prepare(`
            INSERT INTO Administrators (
                administratorId, externalIdentityId, displayName, email,
                status, createdAt, updatedAt, lastAuthenticatedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            administratorId,
            `postgres:null-filter:${administratorId}`,
            "PostgreSQL Null Filter Test",
            "postgres-null-filter@testing.alpacaly.invalid",
            "ACTIVE",
            "2026-07-20T12:00:00.000Z",
            "2026-07-20T12:00:00.000Z",
            null
        );
        store.createEmergencyStop({
            emergencyStopId: activeId,
            level: "FEEDER",
            barnId: DEFAULT_RESOURCE_IDS.barnId,
            feederId: DEFAULT_RESOURCE_IDS.feederId,
            status: "ACTIVE",
            activatedBy: administratorId,
            activatedRole: "ADMINISTRATOR",
            reason: "PostgreSQL nullable filter coverage",
            requestId: null,
            activatedAt: "2026-07-20T12:00:00.000Z",
            clearedAt: null,
            clearanceApprovalRequestId: null
        });
        store.createEmergencyStop({
            emergencyStopId: clearedId,
            level: "FEEDER",
            barnId: DEFAULT_RESOURCE_IDS.barnId,
            feederId: DEFAULT_RESOURCE_IDS.feederId,
            status: "CLEARED",
            activatedBy: administratorId,
            activatedRole: "ADMINISTRATOR",
            reason: "PostgreSQL nullable filter coverage",
            requestId: null,
            activatedAt: "2026-07-20T12:00:00.000Z",
            clearedAt: "2026-07-20T12:01:00.000Z",
            clearanceApprovalRequestId: null
        });

        assert.deepEqual(
            new Set(selectTestStops().map(stop => stop.emergencyStopId)),
            new Set(stopIds)
        );
        assert.deepEqual(
            selectTestStops({ status: "ACTIVE" }).map(stop => stop.emergencyStopId),
            [activeId]
        );
        assert.deepEqual(
            new Set(selectTestStops({
                barnId: DEFAULT_RESOURCE_IDS.barnId
            }).map(stop => stop.emergencyStopId)),
            new Set(stopIds)
        );
        assert.deepEqual(
            new Set(selectTestStops({
                feederId: DEFAULT_RESOURCE_IDS.feederId
            }).map(stop => stop.emergencyStopId)),
            new Set(stopIds)
        );
        assert.deepEqual(selectTestStops({
            status: "ACTIVE",
            barnId: DEFAULT_RESOURCE_IDS.barnId,
            feederId: DEFAULT_RESOURCE_IDS.feederId
        }).map(stop => stop.emergencyStopId), [activeId]);
    } finally {
        eventStore.database.exec("ROLLBACK");
        eventStore.close();
    }
});

test("PostgreSQL aggregate aliases retain the row shape used by reconciliation", {
    skip
}, () => {
    const eventStore = new PostgresEventStore({
        config: postgresConfig(),
        logger: createTestLogger()
    });
    try {
        const row = eventStore.database.prepare(`
            SELECT COUNT(*) AS count, COUNT(*) AS reconciliationCount
            FROM Events
        `).get();
        assert.equal(Number.isInteger(row.count), true);
        assert.equal(row.reconciliationCount, row.count);
        assert.equal("COUNT" in row, false);
    } finally {
        eventStore.close();
    }
});

test("two PostgreSQL processes cannot acquire the same claim", { skip }, async () => {
    const workItemId = `process-contention-${randomUUID()}`;
    const startAt = Date.now() + 1500;
    const results = await Promise.all([
        runClaimProcess({ workerId: `process-a-${randomUUID()}`, workItemId, startAt }),
        runClaimProcess({ workerId: `process-b-${randomUUID()}`, workItemId, startAt })
    ]);
    assert.equal(results.filter(result => result.acquired).length, 1);

    const store = new PostgresEventStore({
        config: postgresConfig(),
        logger: createTestLogger()
    });
    const claimStore = new DistributedClaimStore({ eventStore: store });
    const claim = claimStore.get("POSTGRES_PROCESS_TEST", workItemId);
    assert.equal(claim.state, "ACTIVE");
    assert.equal(claim.attemptNumber, 1);
    assert.equal(claimStore.getHistory(
        "POSTGRES_PROCESS_TEST",
        workItemId
    ).filter(entry => entry.action === "CLAIMED").length, 1);
    store.close();
});
