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
        idGenerator: overrides.idGenerator || (() => "api-test-id")
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
        acceptedToday: 0,
        feedsRemaining: 100,
        feedingWindowEnforced: false
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
    assert.equal(response.body.feedRequest.status, "QUEUED");
    assert.equal(response.body.queuePosition, 1);
    assert.equal(response.headers.location, "/api/feed-requests/feed_api-test-id");
});

test("GET /api/feed-requests/:id returns an accepted request", async () => {
    const app = createTestApp();
    await request(app).post("/api/feed-requests").send({ supporterName: "Grace" }).expect(202);

    const response = await request(app).get("/api/feed-requests/feed_api-test-id").expect(200);
    assert.equal(response.body.feedRequest.supporterName, "Grace");
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
