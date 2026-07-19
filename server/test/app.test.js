import assert from "node:assert/strict";
import test from "node:test";

import request from "supertest";

import { createApp } from "../src/app.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import { createTestLogger, testConfig } from "./helpers.js";

function createTestApp(overrides = {}) {
    const logger = createTestLogger();
    const config = { ...testConfig, ...overrides.config };
    const eventEngine = new EventEngine({
        config,
        logger,
        clock: overrides.clock || (() => new Date(2026, 6, 19, 12, 0, 0)),
        idGenerator: overrides.idGenerator || (() => "api-test-id"),
        sleep: overrides.sleep || (async () => {}),
        autoProcess: overrides.autoProcess ?? false
    });

    return createApp({ config, logger, eventEngine });
}

test("GET /health reports service health", async () => {
    const response = await request(createTestApp()).get("/health").expect(200);

    assert.equal(response.body.status, "ok");
    assert.equal(response.body.service, "alpacaly-server");
    assert.equal(response.body.environment, "test");
    assert.ok(response.headers["x-request-id"]);
});

test("GET /api/event-engine/status reports safe queue totals", async () => {
    const response = await request(createTestApp()).get("/api/event-engine/status").expect(200);

    assert.deepEqual(response.body.eventEngine, {
        status: "READY",
        date: "2026-07-19",
        queueSize: 0,
        waitingQueueSize: 0,
        acceptedToday: 0,
        completedFeeds: 0,
        archivedCount: 0,
        feedsRemaining: 100,
        feedingWindowEnforced: false,
        activeEvent: null,
        lastUpdatedAt: null
    });
});

test("POST /api/feed-requests accepts and queues a valid request", async () => {
    const app = createTestApp();
    const response = await request(app)
        .post("/api/feed-requests")
        .send({
            supporterName: "Grace",
            source: "website-demo",
            message: "Hello alpacas",
            clientRequestId: "web-123"
        })
        .expect(202);

    assert.equal(response.body.accepted, true);
    assert.equal(response.body.feedRequest.id, "feed_api-test-id");
    assert.equal(response.body.feedRequest.eventId, "feed_api-test-id");
    assert.equal(response.body.feedRequest.status, "QUEUED");
    assert.deepEqual(
        response.body.feedRequest.timeline.map(entry => entry.state),
        ["RECEIVED", "VALIDATED", "QUEUED"]
    );
    assert.equal(response.body.queuePosition, 1);
    assert.equal(response.body.estimatedWaitMs, 0);
    assert.equal(response.body.feedRequest.queuePosition, 1);
    assert.equal(response.body.feedRequest.estimatedWaitMs, 0);
    assert.equal(response.body.eventEngine.queueSize, 1);
    assert.equal(response.headers.location, "/api/feed-requests/feed_api-test-id");
});

test("GET /api/feed-requests returns the server queue", async () => {
    const app = createTestApp();
    await request(app).post("/api/feed-requests").send({
        supporterName: "Grace",
        message: "Private supporter message",
        clientRequestId: "queue-test-1"
    }).expect(202);

    const response = await request(app).get("/api/feed-requests").expect(200);
    assert.equal(response.body.feedRequests.length, 1);
    assert.equal(response.body.feedRequests[0].id, "feed_api-test-id");
    assert.equal(response.body.feedRequests[0].eventId, "feed_api-test-id");
    assert.equal(response.body.feedRequests[0].supporterName, "Grace");
    assert.equal(response.body.feedRequests[0].source, "website");
    assert.equal(response.body.feedRequests[0].status, "QUEUED");
    assert.equal(response.body.feedRequests[0].queuePosition, 1);
    assert.equal(response.body.feedRequests[0].estimatedWaitMs, 0);
    assert.equal(response.body.feedRequests[0].timeline.length, 3);
    assert.deepEqual(response.body.archivedFeedRequests, []);
    assert.equal(response.body.eventEngine.queueSize, 1);
});

test("GET /api/feed-requests/:id returns an accepted request", async () => {
    const app = createTestApp();
    await request(app).post("/api/feed-requests").send({ supporterName: "Grace" }).expect(202);

    const response = await request(app).get("/api/feed-requests/feed_api-test-id").expect(200);
    assert.equal(response.body.feedRequest.supporterName, "Grace");
    assert.equal(response.body.feedRequest.queuePosition, 1);
    assert.equal(response.body.feedRequest.estimatedWaitMs, 0);
    assert.deepEqual(
        response.body.feedRequest.timeline.map(entry => entry.state),
        ["RECEIVED", "VALIDATED", "QUEUED"]
    );
});

test("feed request API exposes the complete archived lifecycle", async () => {
    const app = createTestApp({ autoProcess: true });
    const created = await request(app)
        .post("/api/feed-requests")
        .send({ supporterName: "Lifecycle API supporter" })
        .expect(202);

    await app.locals.eventEngine.waitForIdle();

    const eventId = created.body.feedRequest.eventId;
    const detail = await request(app).get(`/api/feed-requests/${eventId}`).expect(200);
    assert.equal(detail.body.feedRequest.state, "ARCHIVED");
    assert.deepEqual(
        detail.body.feedRequest.timeline.map(entry => entry.state),
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

    const list = await request(app).get("/api/feed-requests").expect(200);
    assert.deepEqual(list.body.feedRequests, []);
    assert.equal(list.body.archivedFeedRequests.length, 1);
    assert.equal(list.body.archivedFeedRequests[0].eventId, eventId);
});

test("POST /api/feed-requests returns validation details", async () => {
    const response = await request(createTestApp())
        .post("/api/feed-requests")
        .send({ supporterName: "" })
        .expect(400);

    assert.equal(response.body.error.code, "VALIDATION_ERROR");
    assert.deepEqual(response.body.error.details, ["supporterName is required"]);
});

test("POST /api/feed-requests rejects duplicate client request IDs", async () => {
    const app = createTestApp();
    const payload = { supporterName: "Grace", clientRequestId: "duplicate-api-1" };
    await request(app).post("/api/feed-requests").send(payload).expect(202);

    const response = await request(app).post("/api/feed-requests").send(payload).expect(409);
    assert.equal(response.body.error.code, "DUPLICATE_FEED_REQUEST");
});

test("invalid JSON returns a structured 400 response", async () => {
    const response = await request(createTestApp())
        .post("/api/feed-requests")
        .set("content-type", "application/json")
        .send("{\"supporterName\":")
        .expect(400);

    assert.equal(response.body.error.code, "INVALID_JSON");
    assert.ok(response.body.error.requestId);
});

test("unknown routes return a structured 404 response", async () => {
    const response = await request(createTestApp()).get("/unknown").expect(404);

    assert.equal(response.body.error.code, "ROUTE_NOT_FOUND");
});

test("POST /api/event-engine/reset clears development queue state", async () => {
    const app = createTestApp();
    await request(app).post("/api/feed-requests").send({ supporterName: "Grace" }).expect(202);

    const response = await request(app).post("/api/event-engine/reset").send({}).expect(200);
    assert.equal(response.body.reset, true);
    assert.equal(response.body.eventEngine.queueSize, 0);
    assert.equal(response.body.eventEngine.acceptedToday, 0);
});

test("POST /api/event-engine/reset is disabled by production configuration", async () => {
    const app = createTestApp({ config: { enableDemoReset: false } });
    const response = await request(app).post("/api/event-engine/reset").send({}).expect(403);

    assert.equal(response.body.error.code, "DEMO_RESET_DISABLED");
});

test("API responses allow the configured frontend origin", async () => {
    const response = await request(createTestApp())
        .get("/health")
        .set("origin", "http://localhost:8080")
        .expect(200);

    assert.equal(response.headers["access-control-allow-origin"], "*");
});
