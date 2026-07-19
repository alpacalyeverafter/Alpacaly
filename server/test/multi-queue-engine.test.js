import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    createBarn,
    createFeeder,
    createQueue
} from "../src/domain/resources.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import { SqliteEventStore } from "../src/event-store/sqlite-event-store.js";
import {
    createTestLogger,
    getTestDeviceCommandServices,
    submitTestFeedRequest,
    testConfig
} from "./helpers.js";

const TEST_TIME = "2026-07-19T12:00:00.000Z";
const RESOURCES = Object.freeze({
    barnId: "barn_multi_queue",
    alphaFeederId: "feeder_alpha",
    alphaQueueId: "queue_alpha",
    betaFeederId: "feeder_beta",
    betaQueueId: "queue_beta"
});

function installMultiQueueResources(eventStore) {
    eventStore.saveBarn(createBarn({
        barnId: RESOURCES.barnId,
        name: "Multi Queue Barn",
        createdAt: TEST_TIME
    }));
    eventStore.saveFeeder(createFeeder({
        feederId: RESOURCES.alphaFeederId,
        barnId: RESOURCES.barnId,
        name: "Alpha Feeder",
        createdAt: TEST_TIME
    }));
    eventStore.saveFeeder(createFeeder({
        feederId: RESOURCES.betaFeederId,
        barnId: RESOURCES.barnId,
        name: "Beta Feeder",
        createdAt: TEST_TIME
    }));
    eventStore.saveQueue(createQueue({
        queueId: RESOURCES.alphaQueueId,
        barnId: RESOURCES.barnId,
        feederId: RESOURCES.alphaFeederId,
        name: "Alpha Queue",
        createdAt: TEST_TIME
    }));
    eventStore.saveQueue(createQueue({
        queueId: RESOURCES.betaQueueId,
        barnId: RESOURCES.barnId,
        feederId: RESOURCES.betaFeederId,
        name: "Beta Queue",
        createdAt: TEST_TIME
    }));
}

function createMultiQueueEngine(overrides = {}) {
    const eventStore = overrides.eventStore || new SqliteEventStore({
        databasePath: overrides.databasePath || ":memory:",
        logger: createTestLogger()
    });
    if (overrides.installResources !== false) {
        installMultiQueueResources(eventStore);
    }

    let nextId = 0;
    const engine = new EventEngine({
        config: { ...testConfig, ...overrides.config },
        logger: createTestLogger(),
        eventStore,
        clock: overrides.clock || (() => new Date(TEST_TIME)),
        idGenerator: overrides.idGenerator || (() => `multi-${++nextId}`),
        sleep: overrides.sleep || (async () => {}),
        autoProcess: overrides.autoProcess ?? false
    });
    getTestDeviceCommandServices(engine);
    return engine;
}

function temporaryDatabase(t) {
    const directory = mkdtempSync(join(tmpdir(), "alpacaly-multi-queue-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return join(directory, "events.sqlite");
}

async function waitUntil(predicate) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        if (predicate()) {
            return;
        }
        await new Promise(resolve => setImmediate(resolve));
    }
    throw new Error("Timed out waiting for the expected queue state.");
}

test("isolates feeder queues and applies duplicate protection across feeders", () => {
    const engine = createMultiQueueEngine({
        config: {
            lifecycleCountdownMs: 10,
            lifecycleBellMs: 5,
            lifecycleDispensingMs: 3,
            lifecycleArchiveDelayMs: 2
        }
    });

    const alphaFirst = submitTestFeedRequest(engine, {
        supporterName: "Alpha One",
        clientRequestId: "global-duplicate-id"
    }, { feederId: RESOURCES.alphaFeederId });
    const betaFirst = submitTestFeedRequest(engine, {
        supporterName: "Beta One",
        clientRequestId: "beta-one"
    }, { feederId: RESOURCES.betaFeederId });
    const alphaSecond = submitTestFeedRequest(engine, {
        supporterName: "Alpha Two",
        clientRequestId: "alpha-two"
    }, { feederId: RESOURCES.alphaFeederId });

    assert.deepEqual(
        engine.getQueueSummary(RESOURCES.alphaFeederId).map(event => event.eventId),
        [alphaFirst.feedRequest.eventId, alphaSecond.feedRequest.eventId]
    );
    assert.deepEqual(
        engine.getQueueSummary(RESOURCES.betaFeederId).map(event => event.eventId),
        [betaFirst.feedRequest.eventId]
    );
    assert.equal(alphaSecond.queuePosition, 2);
    assert.equal(betaFirst.queuePosition, 1);
    assert.deepEqual(engine.getQueueSummary(), []);

    const duplicate = submitTestFeedRequest(engine, {
        supporterName: "Cross-feeder duplicate",
        clientRequestId: "global-duplicate-id"
    }, { feederId: RESOURCES.betaFeederId });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.feedRequest.eventId, alphaFirst.feedRequest.eventId);
    assert.equal(duplicate.feedRequest.feederId, RESOURCES.alphaFeederId);

    const alphaStatistics = engine.getQueueStatistics(RESOURCES.alphaFeederId);
    assert.equal(alphaStatistics.waitingCount, 2);
    assert.equal(alphaStatistics.activeCount, 0);
    assert.equal(alphaStatistics.archivedCount, 0);
    assert.equal(alphaStatistics.estimatedWaitMs, 40);
    assert.equal(alphaStatistics.feederStatus, "QUEUED");
    assert.equal(engine.getSnapshot().queueSize, 0);
    assert.equal(engine.getSnapshot().acceptedToday, 0);

    engine.close();
});

test("keeps per-feeder daily safety limits isolated", () => {
    const engine = createMultiQueueEngine({ config: { maxDailyFeeds: 1 } });
    submitTestFeedRequest(engine, { supporterName: "Alpha daily limit" }, {
        feederId: RESOURCES.alphaFeederId
    });
    const beta = submitTestFeedRequest(engine, { supporterName: "Beta daily limit" }, {
        feederId: RESOURCES.betaFeederId
    });

    assert.equal(beta.queuePosition, 1);
    assert.throws(
        () => submitTestFeedRequest(engine, { supporterName: "Alpha over limit" }, {
            feederId: RESOURCES.alphaFeederId
        }),
        error => error.code === "DAILY_FEED_LIMIT_REACHED"
    );

    engine.close();
});

test("processes one active event simultaneously on each feeder", async () => {
    let releaseLifecycle;
    const lifecycleGate = new Promise(resolve => {
        releaseLifecycle = resolve;
    });
    const engine = createMultiQueueEngine({
        autoProcess: true,
        config: { lifecycleCountdownMs: 1000 },
        sleep: async () => lifecycleGate
    });

    submitTestFeedRequest(engine, { supporterName: "Alpha simultaneous" }, {
        feederId: RESOURCES.alphaFeederId
    });
    submitTestFeedRequest(engine, { supporterName: "Beta simultaneous" }, {
        feederId: RESOURCES.betaFeederId
    });

    await waitUntil(() => (
        engine.getQueueStatistics(RESOURCES.alphaFeederId).activeCount === 1
        && engine.getQueueStatistics(RESOURCES.betaFeederId).activeCount === 1
    ));

    assert.equal(
        engine.getQueueStatistics(RESOURCES.alphaFeederId).feederStatus,
        "COUNTDOWN"
    );
    assert.equal(
        engine.getQueueStatistics(RESOURCES.betaFeederId).feederStatus,
        "COUNTDOWN"
    );

    releaseLifecycle();
    await engine.waitForIdle();

    assert.equal(engine.getQueueStatistics(RESOURCES.alphaFeederId).archivedCount, 1);
    assert.equal(engine.getQueueStatistics(RESOURCES.betaFeederId).archivedCount, 1);
    assert.equal(engine.getQueueStatistics(RESOURCES.alphaFeederId).feederStatus, "READY");
    assert.equal(engine.getQueueStatistics(RESOURCES.betaFeederId).feederStatus, "READY");

    engine.close();
});

test("preserves FIFO ordering independently inside each feeder", async () => {
    const archivedByFeeder = new Map([
        [RESOURCES.alphaFeederId, []],
        [RESOURCES.betaFeederId, []]
    ]);
    const engine = createMultiQueueEngine({ autoProcess: true });
    engine.subscribe(payload => {
        if (payload.type === "FEED_REQUEST_STATE_CHANGED" && payload.state === "ARCHIVED") {
            archivedByFeeder.get(payload.feedRequest.feederId)?.push(payload.eventId);
        }
    });

    const alphaFirst = submitTestFeedRequest(engine, { supporterName: "Alpha FIFO One" }, {
        feederId: RESOURCES.alphaFeederId
    });
    const betaFirst = submitTestFeedRequest(engine, { supporterName: "Beta FIFO One" }, {
        feederId: RESOURCES.betaFeederId
    });
    const alphaSecond = submitTestFeedRequest(engine, { supporterName: "Alpha FIFO Two" }, {
        feederId: RESOURCES.alphaFeederId
    });
    const betaSecond = submitTestFeedRequest(engine, { supporterName: "Beta FIFO Two" }, {
        feederId: RESOURCES.betaFeederId
    });

    await engine.waitForIdle();

    assert.deepEqual(archivedByFeeder.get(RESOURCES.alphaFeederId), [
        alphaFirst.feedRequest.eventId,
        alphaSecond.feedRequest.eventId
    ]);
    assert.deepEqual(archivedByFeeder.get(RESOURCES.betaFeederId), [
        betaFirst.feedRequest.eventId,
        betaSecond.feedRequest.eventId
    ]);

    engine.close();
});

test("restores multiple isolated queues and resumes each after restart", async t => {
    const databasePath = temporaryDatabase(t);
    const firstEngine = createMultiQueueEngine({
        databasePath,
        sleep: async () => {
            throw new Error("simulated interruption");
        }
    });
    const alphaFirst = submitTestFeedRequest(firstEngine, {
        supporterName: "Restart Alpha One",
        clientRequestId: "restart-cross-feeder"
    }, { feederId: RESOURCES.alphaFeederId });
    const alphaSecond = submitTestFeedRequest(firstEngine, {
        supporterName: "Restart Alpha Two"
    }, { feederId: RESOURCES.alphaFeederId });
    const betaFirst = submitTestFeedRequest(firstEngine, {
        supporterName: "Restart Beta One"
    }, { feederId: RESOURCES.betaFeederId });

    await firstEngine.processQueue(RESOURCES.alphaFeederId);
    const interruptedTimeline = firstEngine
        .getFeedRequest(alphaFirst.feedRequest.eventId)
        .timeline;
    assert.equal(interruptedTimeline.at(-1).state, "COUNTDOWN");
    firstEngine.close();

    const secondEngine = createMultiQueueEngine({
        databasePath,
        installResources: false
    });
    assert.deepEqual(
        secondEngine.getQueueSummary(RESOURCES.alphaFeederId).map(event => event.eventId),
        [alphaFirst.feedRequest.eventId, alphaSecond.feedRequest.eventId]
    );
    assert.deepEqual(
        secondEngine.getQueueSummary(RESOURCES.betaFeederId).map(event => event.eventId),
        [betaFirst.feedRequest.eventId]
    );
    assert.deepEqual(
        secondEngine.getFeedRequest(alphaFirst.feedRequest.eventId).timeline,
        interruptedTimeline
    );
    const duplicate = submitTestFeedRequest(secondEngine, {
        supporterName: "Restart duplicate",
        clientRequestId: "restart-cross-feeder"
    }, { feederId: RESOURCES.betaFeederId });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.feedRequest.eventId, alphaFirst.feedRequest.eventId);
    secondEngine.close();

    const resumedEngine = createMultiQueueEngine({
        databasePath,
        installResources: false,
        autoProcess: true
    });
    await resumedEngine.waitForIdle();

    assert.deepEqual(
        resumedEngine.getArchivedSummary(RESOURCES.alphaFeederId).map(event => event.eventId),
        [alphaFirst.feedRequest.eventId, alphaSecond.feedRequest.eventId]
    );
    assert.deepEqual(
        resumedEngine.getArchivedSummary(RESOURCES.betaFeederId).map(event => event.eventId),
        [betaFirst.feedRequest.eventId]
    );
    assert.equal(resumedEngine.eventStore.getSchemaVersion(), 5);

    resumedEngine.close();
});
