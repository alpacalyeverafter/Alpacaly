import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createContributionLedgerServices } from "../src/contribution-ledger/index.js";
import { DEFAULT_RESOURCE_IDS } from "../src/domain/resources.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import { migration001InitialSchema } from "../src/event-store/migrations/001-initial-schema.js";
import { migration002ResourceModel } from "../src/event-store/migrations/002-resource-model.js";
import { migration003ContributionLedger } from "../src/event-store/migrations/003-contribution-ledger.js";
import { SqliteEventStore } from "../src/event-store/sqlite-event-store.js";
import { createTestLogger, testConfig } from "./helpers.js";

const TEST_TIME = "2026-07-19T12:00:00.000Z";

function temporaryDatabase(t) {
    const directory = mkdtempSync(join(tmpdir(), "alpacaly-feed-intent-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return join(directory, "events.sqlite");
}

function createContext({
    databasePath = ":memory:",
    startOutboxWorker = false,
    clock = () => new Date(TEST_TIME),
    retryDelayMs = 0
} = {}) {
    const logger = createTestLogger();
    let nextEventId = 0;
    const eventStore = new SqliteEventStore({ databasePath, logger });
    const eventEngine = new EventEngine({
        config: { ...testConfig, databasePath },
        logger,
        eventStore,
        clock,
        idGenerator: () => `outbox-event-${++nextEventId}`,
        sleep: async () => {},
        autoProcess: false
    });
    const services = createContributionLedgerServices({
        eventEngine,
        eventStore,
        logger,
        clock,
        startOutboxWorker,
        outboxPollIntervalMs: 5,
        outboxRetryDelayMs: retryDelayMs
    });
    return { eventStore, eventEngine, ...services };
}

function createPendingFeedIntent(context, externalEventId, overrides = {}) {
    const providerEvent = context.providerEventIngestionService.ingest({
        provider: overrides.provider || "WEBSITE",
        externalEventId,
        rawMetadata: { message: overrides.message || "Durable message" }
    }).providerEvent;
    return context.contributionVerificationService.verify(
        providerEvent.providerEventId,
        {
            verified: true,
            eligible: true,
            amountMinor: overrides.amountMinor ?? 500,
            currency: "GBP",
            supporterDisplayName: overrides.supporterDisplayName || "Durable Supporter",
            feedQuantity: 1,
            feederId: overrides.feederId,
            message: overrides.message || "Durable message"
        }
    );
}

function closeContext(context) {
    context.outboxWorker.stop();
    context.eventEngine.close();
}

test("creates a FeedIntent and Outbox entry atomically with every Contribution", () => {
    const context = createContext();
    const verified = createPendingFeedIntent(context, "intent-created");
    const intent = context.eventStore.getFeedIntent(
        verified.feedIntent.feedIntentId
    );
    const outbox = context.eventStore.getOutboxEntry(intent.feedIntentId);

    assert.equal(intent.contributionId, verified.contribution.contributionId);
    assert.equal(intent.status, "PENDING");
    assert.equal(intent.barnId, DEFAULT_RESOURCE_IDS.barnId);
    assert.equal(intent.feederId, DEFAULT_RESOURCE_IDS.feederId);
    assert.equal(intent.queueId, DEFAULT_RESOURCE_IDS.queueId);
    assert.equal(outbox.status, "PENDING");
    assert.equal(outbox.feedIntentId, intent.feedIntentId);
    assert.deepEqual(
        context.eventStore.getFeedIntentHistory(intent.feedIntentId)
            .map(entry => entry.action),
        ["FEED_INTENT_CREATED", "OUTBOX_QUEUED"]
    );
    assert.equal(context.eventEngine.getQueueSummary().length, 0);
    assert.equal(
        typeof context.feedRequestService.createFromContribution,
        "undefined"
    );

    closeContext(context);
});

test("Outbox processing atomically creates one Feed Request and queue entry", () => {
    const context = createContext();
    const verified = createPendingFeedIntent(context, "outbox-processing");
    const result = context.outboxWorker.processFeedIntent(
        verified.feedIntent.feedIntentId
    );
    const intent = context.eventStore.getFeedIntent(verified.feedIntent.feedIntentId);
    const outbox = context.eventStore.getOutboxEntry(intent.feedIntentId);

    assert.equal(result.created, true);
    assert.equal(result.feedRequest.feedIntentId, intent.feedIntentId);
    assert.equal(result.feedRequest.contributionId, intent.contributionId);
    assert.equal(intent.status, "COMPLETED");
    assert.ok(intent.processingStartedAt);
    assert.ok(intent.feedRequestCreatedAt);
    assert.ok(intent.queueInsertionCompletedAt);
    assert.ok(intent.processingCompletedAt);
    assert.equal(outbox.status, "COMPLETED");
    assert.equal(context.eventStore.getQueueEntries(intent.queueId).length, 1);
    assert.deepEqual(
        context.eventStore.getFeedIntentHistory(intent.feedIntentId)
            .map(entry => entry.action),
        [
            "FEED_INTENT_CREATED",
            "OUTBOX_QUEUED",
            "PROCESSING_STARTED",
            "FEED_REQUEST_CREATED",
            "QUEUE_INSERTION_COMPLETED",
            "PROCESSING_COMPLETED"
        ]
    );

    closeContext(context);
});

test("the database rejects Feed Request creation outside a claimed Outbox job", () => {
    const context = createContext();
    const verified = createPendingFeedIntent(context, "outbox-required");

    assert.throws(
        () => context.feedRequestService.createFromFeedIntent(
            verified.feedIntent.feedIntentId
        ),
        error => error.code === "EVENT_STORE_WRITE_FAILED"
    );
    assert.equal(context.eventEngine.getQueueSummary().length, 0);
    assert.equal(
        context.eventStore.getFeedIntent(verified.feedIntent.feedIntentId).status,
        "PENDING"
    );

    const processed = context.outboxWorker.processFeedIntent(
        verified.feedIntent.feedIntentId
    );
    assert.equal(processed.created, true);
    assert.equal(context.eventEngine.getQueueSummary().length, 1);

    closeContext(context);
});

test("repeated Outbox processing attempts return the same Feed Request", () => {
    const context = createContext();
    const verified = createPendingFeedIntent(context, "duplicate-processing");
    const first = context.outboxWorker.processFeedIntent(
        verified.feedIntent.feedIntentId
    );
    const repeated = context.outboxWorker.processFeedIntent(
        verified.feedIntent.feedIntentId
    );

    assert.equal(repeated.created, false);
    assert.equal(repeated.feedRequest.eventId, first.feedRequest.eventId);
    assert.equal(
        context.eventStore.database.prepare(`
            SELECT COUNT(*) AS count FROM Events WHERE feedIntentId = ?
        `).get(verified.feedIntent.feedIntentId).count,
        1
    );
    assert.equal(context.eventEngine.getQueueSummary().length, 1);

    closeContext(context);
});

test("processes multiple pending FeedIntents once and preserves queue order", () => {
    const context = createContext();
    const verified = [1, 2, 3, 4].map(index => createPendingFeedIntent(
        context,
        `simultaneous-${index}`,
        { supporterDisplayName: `Supporter ${index}` }
    ));
    const results = context.outboxWorker.processPending();

    assert.equal(results.length, 4);
    assert.deepEqual(
        context.eventEngine.getQueueSummary().map(event => event.supporterName),
        ["Supporter 1", "Supporter 2", "Supporter 3", "Supporter 4"]
    );
    verified.forEach(item => {
        assert.equal(
            context.eventStore.getFeedIntent(item.feedIntent.feedIntentId).status,
            "COMPLETED"
        );
    });

    closeContext(context);
});

test("records a failed attempt and safely retries the same FeedIntent", () => {
    const context = createContext();
    const verified = createPendingFeedIntent(context, "failed-then-retried");
    const originalCreate = context.feedRequestService.createFromFeedIntent
        .bind(context.feedRequestService);
    context.feedRequestService.createFromFeedIntent = () => {
        throw new Error("simulated interruption before Event creation");
    };

    assert.throws(
        () => context.outboxWorker.processFeedIntent(
            verified.feedIntent.feedIntentId
        ),
        /simulated interruption/
    );
    assert.equal(
        context.eventStore.getFeedIntent(verified.feedIntent.feedIntentId).status,
        "FAILED"
    );
    assert.equal(context.eventEngine.getQueueSummary().length, 0);

    context.feedRequestService.createFromFeedIntent = originalCreate;
    const recovered = context.outboxWorker.processFeedIntent(
        verified.feedIntent.feedIntentId
    );
    assert.equal(recovered.created, true);
    assert.equal(context.eventEngine.getQueueSummary().length, 1);
    assert.equal(
        context.eventStore.getFeedIntentHistory(verified.feedIntent.feedIntentId)
            .filter(entry => entry.action === "PROCESSING_FAILED").length,
        1
    );

    closeContext(context);
});

test("a failed FeedIntent cannot be overtaken inside its feeder queue", () => {
    const context = createContext();
    const first = createPendingFeedIntent(context, "fifo-failure-first", {
        supporterDisplayName: "First durable supporter"
    });
    createPendingFeedIntent(context, "fifo-failure-second", {
        supporterDisplayName: "Second durable supporter"
    });
    const originalCreate = context.feedRequestService.createFromFeedIntent
        .bind(context.feedRequestService);
    context.feedRequestService.createFromFeedIntent = () => {
        throw new Error("simulated first intent failure");
    };

    context.outboxWorker.processPending();
    assert.equal(context.eventEngine.getQueueSummary().length, 0);
    assert.equal(
        context.eventStore.getFeedIntent(first.feedIntent.feedIntentId).status,
        "FAILED"
    );

    context.feedRequestService.createFromFeedIntent = originalCreate;
    context.outboxWorker.processPending();
    assert.deepEqual(
        context.eventEngine.getQueueSummary().map(event => event.supporterName),
        ["First durable supporter", "Second durable supporter"]
    );

    closeContext(context);
});

test("recovers an interrupted claimed Outbox entry after restart", t => {
    const databasePath = temporaryDatabase(t);
    const interrupted = createContext({ databasePath });
    const verified = createPendingFeedIntent(interrupted, "claimed-before-crash");
    interrupted.eventStore.claimFeedIntent(
        verified.feedIntent.feedIntentId,
        TEST_TIME
    );
    interrupted.eventEngine.close();

    const recovered = createContext({ databasePath, startOutboxWorker: true });
    const eventId = recovered.eventStore.getEventIdByFeedIntent(
        verified.feedIntent.feedIntentId
    );
    assert.ok(eventId);
    assert.equal(recovered.eventEngine.getQueueSummary().length, 1);
    assert.equal(
        recovered.eventStore.getOutboxEntry(verified.feedIntent.feedIntentId)
            .attemptCount,
        2
    );
    assert.ok(
        recovered.eventStore.getFeedIntentHistory(verified.feedIntent.feedIntentId)
            .some(entry => entry.action === "PROCESSING_RECOVERED")
    );

    closeContext(recovered);
});

test("real restart resumes after FeedIntent creation without duplicates", t => {
    const databasePath = temporaryDatabase(t);
    const stoppedServer = createContext({ databasePath });
    const verified = createPendingFeedIntent(stoppedServer, "real-restart");
    const feedIntentId = verified.feedIntent.feedIntentId;
    assert.equal(stoppedServer.eventStore.getEventIdByFeedIntent(feedIntentId), null);
    stoppedServer.eventEngine.close();

    const restartedServer = createContext({
        databasePath,
        startOutboxWorker: true
    });
    const eventId = restartedServer.eventStore.getEventIdByFeedIntent(feedIntentId);
    assert.ok(eventId);
    assert.equal(restartedServer.eventEngine.getQueueSummary().length, 1);
    assert.equal(
        restartedServer.eventStore.database.prepare(`
            SELECT COUNT(*) AS count FROM Events WHERE feedIntentId = ?
        `).get(feedIntentId).count,
        1
    );
    closeContext(restartedServer);

    const secondRestart = createContext({
        databasePath,
        startOutboxWorker: true
    });
    assert.equal(secondRestart.eventStore.getEventIdByFeedIntent(feedIntentId), eventId);
    assert.equal(
        secondRestart.eventStore.database.prepare(`
            SELECT COUNT(*) AS count FROM Events WHERE feedIntentId = ?
        `).get(feedIntentId).count,
        1
    );
    closeContext(secondRestart);
});

test("worker stop is graceful and worker restart processes retained work", () => {
    const context = createContext({ startOutboxWorker: true });
    context.outboxWorker.stop();
    const verified = createPendingFeedIntent(context, "worker-restart");

    assert.equal(context.outboxWorker.started, false);
    assert.equal(
        context.eventStore.getEventIdByFeedIntent(verified.feedIntent.feedIntentId),
        null
    );
    context.outboxWorker.start();
    assert.ok(
        context.eventStore.getEventIdByFeedIntent(verified.feedIntent.feedIntentId)
    );
    context.outboxWorker.stop();
    assert.equal(context.outboxWorker.timer, null);

    context.eventEngine.close();
});

test("migration upgrades a stranded Phase 6C Contribution into durable work", t => {
    const databasePath = temporaryDatabase(t);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("PRAGMA foreign_keys = ON;");
    migration001InitialSchema.up(legacy);
    migration002ResourceModel.up(legacy);
    migration003ContributionLedger.up(legacy);
    legacy.exec("PRAGMA user_version = 3;");
    legacy.prepare(`
        INSERT INTO ProviderEvents (
            providerEventId, provider, externalEventId, receivedAt,
            verificationStatus, rawMetadataJson, rejectionReason, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "provider_event_stranded",
        "WEBSITE",
        "stranded-phase-6c",
        TEST_TIME,
        "VERIFIED",
        '{"message":"Recovered migration message"}',
        null,
        TEST_TIME,
        TEST_TIME
    );
    legacy.prepare(`
        INSERT INTO Contributions (
            contributionId, providerEventId, verifiedAt, amountMinor, currency,
            supporterDisplayName, eligibilityStatus, feedQuantity,
            metadataJson, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "contribution_stranded",
        "provider_event_stranded",
        TEST_TIME,
        500,
        "GBP",
        "Migrated Supporter",
        "ELIGIBLE",
        1,
        "null",
        TEST_TIME,
        TEST_TIME
    );
    legacy.close();

    const migrated = createContext({ databasePath, startOutboxWorker: true });
    const intent = migrated.eventStore.getFeedIntentByContribution(
        "contribution_stranded"
    );
    const eventId = migrated.eventStore.getEventIdByFeedIntent(intent.feedIntentId);

    assert.equal(migrated.eventStore.getSchemaVersion(), 14);
    assert.equal(intent.barnId, DEFAULT_RESOURCE_IDS.barnId);
    assert.ok(eventId);
    assert.equal(migrated.eventEngine.getFeedRequest(eventId).message, "Recovered migration message");
    assert.deepEqual(
        migrated.eventStore.database.prepare("PRAGMA foreign_key_check;").all(),
        []
    );

    closeContext(migrated);
});
