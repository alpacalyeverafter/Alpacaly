import assert from "node:assert/strict";
import test from "node:test";

import { ApplicationError } from "../src/errors/application-error.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import { createTestLogger, testConfig } from "./helpers.js";

function createEngine(overrides = {}) {
    const config = { ...testConfig, ...overrides.config };
    return new EventEngine({
        config,
        logger: createTestLogger(),
        clock: overrides.clock || (() => new Date(2026, 6, 19, 12, 0, 0)),
        idGenerator: overrides.idGenerator || (() => "test-id")
    });
}

test("queues a valid feed request", () => {
    const engine = createEngine();
    const result = engine.submitFeedRequest({
        supporterName: "  Ada  ",
        source: "website",
        message: "  For the herd  ",
        clientRequestId: "client-1"
    });

    assert.equal(result.feedRequest.id, "feed_test-id");
    assert.equal(result.feedRequest.supporterName, "Ada");
    assert.equal(result.feedRequest.message, "For the herd");
    assert.equal(result.feedRequest.status, "QUEUED");
    assert.equal(result.queuePosition, 1);
    assert.equal(engine.getSnapshot().acceptedToday, 1);
});

test("rejects a feed request without a supporter name", () => {
    const engine = createEngine();

    assert.throws(
        () => engine.submitFeedRequest({ supporterName: " " }),
        error => error instanceof ApplicationError
            && error.code === "VALIDATION_ERROR"
            && error.statusCode === 400
    );
});

test("rejects a duplicate client request ID", () => {
    const engine = createEngine();
    const payload = { supporterName: "Ada", clientRequestId: "duplicate-1" };
    engine.submitFeedRequest(payload);

    assert.throws(
        () => engine.submitFeedRequest(payload),
        error => error.code === "DUPLICATE_FEED_REQUEST" && error.statusCode === 409
    );
});

test("enforces the configured daily feed limit", () => {
    let id = 0;
    const engine = createEngine({
        config: { maxDailyFeeds: 1 },
        idGenerator: () => String(++id)
    });
    engine.submitFeedRequest({ supporterName: "First" });

    assert.throws(
        () => engine.submitFeedRequest({ supporterName: "Second" }),
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
        () => engine.submitFeedRequest({ supporterName: "Early supporter" }),
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

    assert.equal(engine.submitFeedRequest({ supporterName: "Night supporter" }).queuePosition, 1);
});
