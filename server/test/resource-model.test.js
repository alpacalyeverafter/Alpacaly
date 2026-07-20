import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
    DEFAULT_RESOURCE_IDS,
    createBarn,
    createCamera,
    createDevice,
    createFeeder,
    createQueue
} from "../src/domain/resources.js";
import { ContributionVerificationService } from "../src/contribution-ledger/contribution-verification-service.js";
import { FeedEligibilityService } from "../src/contribution-ledger/feed-eligibility-service.js";
import { FeedIntentService } from "../src/contribution-ledger/feed-intent-service.js";
import { ProviderEventIngestionService } from "../src/contribution-ledger/provider-event-ingestion-service.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import { migration001InitialSchema } from "../src/event-store/migrations/001-initial-schema.js";
import { SqliteEventStore } from "../src/event-store/sqlite-event-store.js";
import {
    createTestLogger,
    submitTestFeedRequest,
    testConfig
} from "./helpers.js";

const TEST_TIME = "2026-07-19T12:00:00.000Z";

function temporaryDatabase(t) {
    const directory = mkdtempSync(join(tmpdir(), "alpacaly-resource-model-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return join(directory, "events.sqlite");
}

function createStore(databasePath = ":memory:") {
    return new SqliteEventStore({
        databasePath,
        logger: createTestLogger()
    });
}

function queuedEvent({
    eventId,
    sequenceNumber,
    barnId,
    feederId,
    queueId,
    contributionId,
    feedIntentId
}) {
    const timeline = ["RECEIVED", "VALIDATED", "QUEUED"].map(state => ({
        state,
        timestamp: TEST_TIME,
        details: null
    }));

    return {
        id: eventId,
        eventId,
        type: "FEED_REQUEST",
        state: "QUEUED",
        status: "QUEUED",
        sequenceNumber,
        supporterName: `Supporter ${sequenceNumber}`,
        source: "test",
        message: "",
        clientRequestId: `resource-client-${sequenceNumber}`,
        contributionId,
        feedIntentId,
        barnId,
        feederId,
        queueId,
        requestedAt: TEST_TIME,
        updatedAt: TEST_TIME,
        stateTimestamps: {
            RECEIVED: TEST_TIME,
            VALIDATED: TEST_TIME,
            QUEUED: TEST_TIME
        },
        timeline,
        hardwareAcknowledgements: { BELL: null, DISPENSING: null },
        acknowledgementHistory: []
    };
}

function createEligibleContribution(
    store,
    externalEventId,
    supporterDisplayName,
    feederId = DEFAULT_RESOURCE_IDS.feederId
) {
    const logger = createTestLogger();
    const clock = () => new Date(TEST_TIME);
    const ingestion = new ProviderEventIngestionService({
        eventStore: store,
        logger,
        clock
    }).ingest({
        provider: "FUTURE_API",
        externalEventId
    });
    const feedEligibilityService = new FeedEligibilityService({ eventStore: store });
    const feedIntentService = new FeedIntentService({
        eventStore: store,
        feedEligibilityService,
        defaultFeederId: feederId,
        clock
    });
    return new ContributionVerificationService({
        eventStore: store,
        feedIntentService,
        logger,
        clock
    }).verify(ingestion.providerEvent.providerEventId, {
        verified: true,
        eligible: true,
        amountMinor: 0,
        currency: "GBP",
        supporterDisplayName,
        feedQuantity: 1,
        feederId
    });
}

test("creates stable resource identities and enforces barn relationships", () => {
    const store = createStore();
    const barn = createBarn({
        barnId: "barn_north",
        name: "North Barn",
        timezone: "Europe/London",
        createdAt: TEST_TIME
    });
    const firstFeeder = createFeeder({
        feederId: "feeder_north_one",
        barnId: barn.barnId,
        name: "North Feeder One",
        createdAt: TEST_TIME
    });
    const secondFeeder = createFeeder({
        feederId: "feeder_north_two",
        barnId: barn.barnId,
        name: "North Feeder Two",
        createdAt: TEST_TIME
    });
    const camera = createCamera({
        cameraId: "camera_north",
        barnId: barn.barnId,
        name: "North Camera",
        createdAt: TEST_TIME
    });
    const device = createDevice({
        deviceId: "device_north",
        barnId: barn.barnId,
        name: "North Controller",
        kind: "controller",
        createdAt: TEST_TIME
    });
    const queue = createQueue({
        queueId: "queue_north_one",
        barnId: barn.barnId,
        feederId: firstFeeder.feederId,
        name: "North Feeder One Queue",
        createdAt: TEST_TIME
    });

    store.saveBarn(barn);
    store.saveFeeder(firstFeeder);
    store.saveFeeder(secondFeeder);
    store.saveCamera(camera);
    store.saveDevice(device);
    store.saveQueue(queue);

    const resources = store.getResources();
    assert.deepEqual(
        resources.feeders
            .filter(resource => resource.barnId === barn.barnId)
            .map(resource => resource.feederId),
        [firstFeeder.feederId, secondFeeder.feederId]
    );
    assert.equal(resources.cameras.at(-1).barnId, barn.barnId);
    assert.equal(resources.devices.at(-1).barnId, barn.barnId);
    assert.equal(resources.queues.at(-1).feederId, firstFeeder.feederId);
    assert.equal(resources.queues.at(-1).resourceId, firstFeeder.feederId);
    assert.equal(device.kind, "CONTROLLER");

    assert.throws(
        () => store.saveFeeder(createFeeder({
            feederId: "feeder_orphan",
            barnId: "barn_missing",
            name: "Orphan Feeder",
            createdAt: TEST_TIME
        })),
        /FOREIGN KEY constraint failed/
    );
    assert.throws(() => store.saveBarn(barn), /UNIQUE constraint failed/);

    store.close();
});

test("assigns every existing API feed request to the stable default resources", () => {
    const engine = new EventEngine({
        config: testConfig,
        logger: createTestLogger(),
        clock: () => new Date(TEST_TIME),
        idGenerator: () => "default-resource-event",
        autoProcess: false
    });

    const submitted = submitTestFeedRequest(engine, {
        supporterName: "Default supporter"
    });
    assert.equal(submitted.feedRequest.barnId, DEFAULT_RESOURCE_IDS.barnId);
    assert.equal(submitted.feedRequest.feederId, DEFAULT_RESOURCE_IDS.feederId);
    assert.equal(submitted.feedRequest.queueId, DEFAULT_RESOURCE_IDS.queueId);
    assert.deepEqual(engine.eventStore.getDefaultResourceAssignment(), DEFAULT_RESOURCE_IDS);

    engine.close();
});

test("keeps queue positions independent for different feeders", () => {
    const store = createStore();
    const barn = createBarn({
        barnId: "barn_queue_test",
        name: "Queue Test Barn",
        createdAt: TEST_TIME
    });
    const firstFeeder = createFeeder({
        feederId: "feeder_queue_one",
        barnId: barn.barnId,
        name: "Queue Feeder One",
        createdAt: TEST_TIME
    });
    const secondFeeder = createFeeder({
        feederId: "feeder_queue_two",
        barnId: barn.barnId,
        name: "Queue Feeder Two",
        createdAt: TEST_TIME
    });
    const firstQueue = createQueue({
        queueId: "queue_feeder_one",
        barnId: barn.barnId,
        feederId: firstFeeder.feederId,
        name: "Queue One",
        createdAt: TEST_TIME
    });
    const secondQueue = createQueue({
        queueId: "queue_feeder_two",
        barnId: barn.barnId,
        feederId: secondFeeder.feederId,
        name: "Queue Two",
        createdAt: TEST_TIME
    });

    store.saveBarn(barn);
    store.saveFeeder(firstFeeder);
    store.saveFeeder(secondFeeder);
    store.saveQueue(firstQueue);
    store.saveQueue(secondQueue);

    const firstContribution = createEligibleContribution(
        store,
        "resource-queue-one",
        "Supporter 1",
        firstFeeder.feederId
    );
    const secondContribution = createEligibleContribution(
        store,
        "resource-queue-two",
        "Supporter 2",
        secondFeeder.feederId
    );
    const wrongContribution = createEligibleContribution(
        store,
        "resource-wrong-queue",
        "Supporter 3",
        firstFeeder.feederId
    );
    [firstContribution, secondContribution, wrongContribution].forEach(result => {
        store.claimFeedIntent(result.feedIntent.feedIntentId, TEST_TIME);
    });
    store.createQueuedEvent(queuedEvent({
        eventId: "feed_queue_one",
        sequenceNumber: 1,
        barnId: barn.barnId,
        feederId: firstFeeder.feederId,
        queueId: firstQueue.queueId,
        contributionId: firstContribution.contribution.contributionId,
        feedIntentId: firstContribution.feedIntent.feedIntentId
    }), { queuePosition: 1 });
    store.createQueuedEvent(queuedEvent({
        eventId: "feed_queue_two",
        sequenceNumber: 2,
        barnId: barn.barnId,
        feederId: secondFeeder.feederId,
        queueId: secondQueue.queueId,
        contributionId: secondContribution.contribution.contributionId,
        feedIntentId: secondContribution.feedIntent.feedIntentId
    }), { queuePosition: 1 });

    assert.equal(store.getQueueEntries(firstQueue.queueId)[0].queuePosition, 1);
    assert.equal(store.getQueueEntries(secondQueue.queueId)[0].queuePosition, 1);
    assert.throws(
        () => store.createQueuedEvent(queuedEvent({
            eventId: "feed_wrong_queue",
            sequenceNumber: 3,
            barnId: barn.barnId,
            feederId: firstFeeder.feederId,
            queueId: secondQueue.queueId,
            contributionId: wrongContribution.contribution.contributionId,
            feedIntentId: wrongContribution.feedIntent.feedIntentId
        })),
        /Event (resources do not belong together|does not match its FeedIntent)/
    );

    store.close();
});

test("migrates Phase 5 events in place and recovers them after restart", t => {
    const databasePath = temporaryDatabase(t);
    const legacyDatabase = new DatabaseSync(databasePath);
    legacyDatabase.exec("PRAGMA foreign_keys = ON;");
    migration001InitialSchema.up(legacyDatabase);
    legacyDatabase.exec("PRAGMA user_version = 1;");

    legacyDatabase.prepare(`
        INSERT INTO Events (
            eventId,
            type,
            sequenceNumber,
            supporterName,
            source,
            message,
            clientRequestId,
            requestedAt,
            updatedAt,
            currentState
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        "feed_legacy",
        "FEED_REQUEST",
        41,
        "Legacy supporter",
        "website",
        "Preserve this event",
        "legacy-client-id",
        TEST_TIME,
        TEST_TIME,
        "QUEUED"
    );
    ["RECEIVED", "VALIDATED", "QUEUED"].forEach((state, index) => {
        legacyDatabase.prepare(`
            INSERT INTO LifecycleHistory (
                eventId,
                ordinal,
                state,
                timestamp,
                detailsJson
            ) VALUES (?, ?, ?, ?, ?)
        `).run("feed_legacy", index + 1, state, TEST_TIME, "null");
    });
    legacyDatabase.prepare(`
        INSERT INTO Queue (eventId, queuePosition, enqueuedAt)
        VALUES (?, ?, ?)
    `).run("feed_legacy", 9, TEST_TIME);
    legacyDatabase.close();

    const firstRestart = new EventEngine({
        config: { ...testConfig, databasePath },
        logger: createTestLogger(),
        clock: () => new Date(TEST_TIME),
        idGenerator: () => "unused",
        autoProcess: false
    });
    const migrated = firstRestart.getFeedRequest("feed_legacy");
    assert.equal(firstRestart.eventStore.getSchemaVersion(), 12);
    assert.equal(migrated.eventId, "feed_legacy");
    assert.equal(migrated.sequenceNumber, 41);
    assert.deepEqual(
        migrated.timeline.map(entry => entry.state),
        ["RECEIVED", "VALIDATED", "QUEUED"]
    );
    assert.equal(migrated.barnId, DEFAULT_RESOURCE_IDS.barnId);
    assert.equal(migrated.feederId, DEFAULT_RESOURCE_IDS.feederId);
    assert.equal(migrated.queueId, DEFAULT_RESOURCE_IDS.queueId);
    const migratedContribution = firstRestart.eventStore.getContribution(
        migrated.contributionId
    );
    const migratedProviderEvent = firstRestart.eventStore.getProviderEvent(
        migratedContribution.providerEventId
    );
    assert.equal(migratedContribution.amountMinor, 0);
    assert.equal(migratedContribution.eligibilityStatus, "ELIGIBLE");
    assert.equal(migratedProviderEvent.provider, "WEBSITE");
    assert.equal(migratedProviderEvent.externalEventId, "legacy:feed_legacy");
    assert.equal(migratedProviderEvent.verificationStatus, "VERIFIED");
    assert.equal(
        firstRestart.eventStore.getQueueEntries(DEFAULT_RESOURCE_IDS.queueId)[0].queuePosition,
        9
    );
    assert.deepEqual(
        firstRestart.eventStore.database.prepare("PRAGMA foreign_key_check;").all(),
        []
    );
    firstRestart.close();

    const secondRestart = new EventEngine({
        config: { ...testConfig, databasePath },
        logger: createTestLogger(),
        clock: () => new Date(TEST_TIME),
        autoProcess: false
    });
    assert.equal(secondRestart.getQueueSummary()[0].eventId, "feed_legacy");
    assert.equal(secondRestart.getFeedRequest("feed_legacy").queuePosition, 1);
    secondRestart.close();
});
