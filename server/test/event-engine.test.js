import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationError } from "../src/errors/application-error.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import {
    createTestLogger,
    submitTestFeedRequest,
    testConfig
} from "./helpers.js";

function createEngine(overrides = {}) {
    const config = { ...testConfig, ...overrides.config };
    return new EventEngine({
        config,
        logger: createTestLogger(),
        clock: overrides.clock || (() => new Date(2026, 6, 19, 12, 0, 0)),
        idGenerator: overrides.idGenerator || (() => "test-id"),
        sleep: overrides.sleep || (async () => {}),
        autoProcess: overrides.autoProcess ?? false
    });
}

test("queues a valid feed request", () => {
    const engine = createEngine();
    const result = submitTestFeedRequest(engine, {
        supporterName: "  Ada  ",
        source: "website",
        message: "  For the herd  ",
        clientRequestId: "client-1"
    });

    assert.equal(result.feedRequest.id, "feed_test-id");
    assert.equal(result.feedRequest.eventId, "feed_test-id");
    assert.equal(result.feedRequest.supporterName, "Ada");
    assert.equal(result.feedRequest.message, "For the herd");
    assert.equal(result.feedRequest.status, "QUEUED");
    assert.deepEqual(
        result.feedRequest.timeline.map(entry => entry.state),
        ["RECEIVED", "VALIDATED", "QUEUED"]
    );
    assert.equal(Object.keys(result.feedRequest.stateTimestamps).length, 3);
    assert.equal(result.queuePosition, 1);
    assert.equal(engine.getSnapshot().acceptedToday, 1);
});

test("rejects a feed request without a supporter name", () => {
    const engine = createEngine();

    assert.throws(
        () => submitTestFeedRequest(engine, { supporterName: " " }),
        error => error instanceof ApplicationError
            && error.code === "VALIDATION_ERROR"
            && error.statusCode === 400
    );
});

test("returns the existing feed for a duplicate website event", () => {
    const engine = createEngine();
    const payload = { supporterName: "Ada", clientRequestId: "duplicate-1" };
    const first = submitTestFeedRequest(engine, payload);
    const duplicate = submitTestFeedRequest(engine, payload);

    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.feedRequest.eventId, first.feedRequest.eventId);
    assert.equal(engine.getQueueSummary().length, 1);
});

test("enforces the configured daily feed limit", () => {
    let id = 0;
    const engine = createEngine({
        config: { maxDailyFeeds: 1 },
        idGenerator: () => String(++id)
    });
    submitTestFeedRequest(engine, { supporterName: "First" });

    assert.throws(
        () => submitTestFeedRequest(engine, { supporterName: "Second" }),
        error => error.code === "DAILY_FEED_LIMIT_REACHED" && error.statusCode === 409
    );
});

test("rejects requests outside an enforced feeding window", () => {
    const engine = createEngine({
        config: {
            enforceFeedingWindow: true,
            feedingWindowStart: "08:00",
            feedingWindowEnd: "18:00"
        },
        clock: () => new Date(2026, 6, 19, 7, 59, 0)
    });

    assert.throws(
        () => submitTestFeedRequest(engine, { supporterName: "Early supporter" }),
        error => error.code === "OUTSIDE_FEEDING_WINDOW" && error.statusCode === 409
    );
});

test("supports feeding windows that cross midnight", () => {
    const engine = createEngine({
        config: {
            enforceFeedingWindow: true,
            feedingWindowStart: "22:00",
            feedingWindowEnd: "02:00"
        },
        clock: () => new Date(2026, 6, 19, 23, 0, 0)
    });

    assert.equal(
        submitTestFeedRequest(engine, { supporterName: "Night supporter" }).queuePosition,
        1
    );
});

test("returns a supporter-safe queue summary", () => {
    const engine = createEngine();
    submitTestFeedRequest(engine, {
        supporterName: "Ada",
        message: "Not included in the queue summary",
        clientRequestId: "not-in-summary"
    });

    const [summary] = engine.getQueueSummary();
    assert.equal(summary.id, "feed_test-id");
    assert.equal(summary.eventId, "feed_test-id");
    assert.equal(summary.supporterName, "Ada");
    assert.equal(summary.status, "QUEUED");
    assert.equal(summary.queuePosition, 1);
    assert.equal(summary.timeline.length, 3);
    assert.equal("message" in summary, false);
    assert.equal("clientRequestId" in summary, false);
});

test("calculates queue positions and estimated wait times from lifecycle durations", () => {
    let id = 0;
    const engine = createEngine({
        config: {
            lifecycleCountdownMs: 10000,
            lifecycleBellMs: 3000,
            lifecycleDispensingMs: 2000,
            lifecycleArchiveDelayMs: 2000
        },
        idGenerator: () => String(++id)
    });
    const first = submitTestFeedRequest(engine, { supporterName: "First" });
    const second = submitTestFeedRequest(engine, { supporterName: "Second" });

    assert.equal(first.feedRequest.queuePosition, 1);
    assert.equal(first.feedRequest.estimatedWaitMs, 0);
    assert.equal(second.feedRequest.queuePosition, 2);
    assert.equal(second.feedRequest.estimatedWaitMs, 17000);
    assert.deepEqual(
        engine.getQueueSummary().map(event => ({
            position: event.queuePosition,
            estimatedWaitMs: event.estimatedWaitMs
        })),
        [
            { position: 1, estimatedWaitMs: 0 },
            { position: 2, estimatedWaitMs: 17000 }
        ]
    );
});

test("resets all persistent demo state", () => {
    const engine = createEngine();
    submitTestFeedRequest(engine, {
        supporterName: "Ada",
        clientRequestId: "reset-1"
    });

    const snapshot = engine.reset();
    assert.equal(snapshot.queueSize, 0);
    assert.equal(snapshot.acceptedToday, 0);
    assert.equal(snapshot.feedsRemaining, 100);
    assert.deepEqual(engine.getQueueSummary(), []);
});

test("runs every lifecycle state once with a timestamp", async () => {
    const engine = createEngine({ autoProcess: true });
    const submitted = submitTestFeedRequest(engine, {
        supporterName: "Lifecycle supporter"
    });

    await engine.waitForIdle();

    const feedRequest = engine.getFeedRequest(submitted.feedRequest.id);
    assert.equal(feedRequest.eventId, submitted.feedRequest.id);
    assert.equal(feedRequest.state, "ARCHIVED");
    assert.deepEqual(
        feedRequest.timeline.map(entry => entry.state),
        [
            "RECEIVED",
            "VALIDATED",
            "QUEUED",
            "APPROVED",
            "COUNTDOWN",
            "BELL",
            "DISPENSING",
            "COMPLETE",
            "ARCHIVED"
        ]
    );
    assert.equal(feedRequest.timeline.every(entry => Boolean(entry.timestamp)), true);
    assert.equal(Object.keys(feedRequest.stateTimestamps).length, 9);
    assert.equal(engine.getSnapshot().completedFeeds, 1);
    assert.equal(engine.getSnapshot().queueSize, 0);
    assert.equal(engine.getArchivedSummary().length, 1);
});

test("preserves FIFO queue order through archival", async () => {
    let id = 0;
    const archivedOrder = [];
    const engine = createEngine({
        autoProcess: true,
        idGenerator: () => String(++id)
    });
    engine.subscribe(payload => {
        if (payload.type === "FEED_REQUEST_STATE_CHANGED" && payload.state === "ARCHIVED") {
            archivedOrder.push(payload.eventId);
        }
    });

    const first = submitTestFeedRequest(engine, { supporterName: "First" });
    const second = submitTestFeedRequest(engine, { supporterName: "Second" });
    await engine.waitForIdle();

    assert.deepEqual(archivedOrder, [first.feedRequest.id, second.feedRequest.id]);
    assert.deepEqual(
        engine.getArchivedSummary().map(event => event.sequenceNumber),
        [1, 2]
    );
});

test("prevents duplicate lifecycle processing", async () => {
    const engine = createEngine();
    const submitted = submitTestFeedRequest(engine, { supporterName: "Single pass" });

    await Promise.all([
        engine.processQueue(),
        engine.processQueue(),
        engine.processQueue()
    ]);

    const states = engine.getFeedRequest(submitted.feedRequest.id).timeline.map(entry => entry.state);
    assert.equal(states.length, 9);
    assert.equal(new Set(states).size, 9);
    assert.equal(engine.getArchivedSummary().length, 1);
});

test("stores future hardware acknowledgements without controlling hardware", () => {
    const engine = createEngine();
    const submitted = submitTestFeedRequest(engine, { supporterName: "Hardware future" });

    const acknowledgement = engine.recordHardwareAcknowledgement(
        submitted.feedRequest.id,
        "BELL",
        { status: "ACKNOWLEDGED", details: { deviceId: "future-bell" } }
    );

    assert.equal(acknowledgement.stage, "BELL");
    assert.equal(acknowledgement.status, "ACKNOWLEDGED");
    assert.deepEqual(
        engine.getFeedRequest(submitted.feedRequest.id).hardwareAcknowledgements.BELL,
        acknowledgement
    );
});
