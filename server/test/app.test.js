import assert from "node:assert/strict";
import test from "node:test";

import request from "supertest";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config/index.js";
import { DEFAULT_RESOURCE_IDS } from "../src/domain/resources.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import { createTestLogger, testConfig } from "./helpers.js";

const ADMIN_AUTHORIZATION = "Development local-admin";
const VIEWER_AUTHORIZATION = "Development local-viewer";

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

test("production configuration disables development contribution simulation by default", () => {
    const config = loadConfig({
        NODE_ENV: "production",
        CENTRAL_DATABASE_TYPE: "postgres",
        DATABASE_URL: "postgresql://app_user:secret@db.example.com/alpacaly",
        DATABASE_PATH: ":memory:",
        ENABLE_DEVELOPMENT_CONTRIBUTION_SIMULATION: "true"
    }, { loadEnvFile: false });
    assert.equal(config.enableDevelopmentContributionSimulation, false);
    assert.equal(config.paymentSandboxEnabled, false);
});

test("configuration rejects live Stripe keys", () => {
    assert.throws(
        () => loadConfig({
            NODE_ENV: "development",
            DATABASE_PATH: ":memory:",
            STRIPE_TEST_SECRET_KEY: "sk_live_not_allowed"
        }, { loadEnvFile: false }),
        /must be a Stripe test-mode key/
    );
});

test("configuration rejects non-local payment sandbox URLs", () => {
    assert.throws(
        () => loadConfig({
            NODE_ENV: "development",
            DATABASE_PATH: ":memory:",
            ENABLE_PAYMENT_SANDBOX: "true",
            PAYMENT_PUBLIC_BASE_URL: "https://payments.example.com"
        }, { loadEnvFile: false }),
        /must use a loopback host/
    );
});

test("GET /health reports service health", async () => {
    const response = await request(createTestApp()).get("/health").expect(200);

    assert.equal(response.body.status, "ok");
    assert.equal(response.body.service, "alpacaly-server");
    assert.equal(response.body.environment, "test");
    assert.ok(response.headers["x-request-id"]);
});

test("GET /health/ready reports sanitized persistence readiness", async () => {
    const response = await request(createTestApp()).get("/health/ready").expect(200);

    assert.equal(response.body.status, "ready");
    assert.deepEqual(response.body.persistence, {
        databaseType: "sqlite",
        schemaVersion: 13,
        reachable: true
    });
    assert.equal(response.body.workerCoordination.reachable, true);
    assert.equal(JSON.stringify(response.body).includes("DATABASE_URL"), false);
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
        lastUpdatedAt: null,
        availability: {
            available: true,
            status: "AVAILABLE",
            message: "Feeding is available."
        }
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
    assert.equal(response.body.simulated, true);
    assert.equal(response.body.providerEvent, undefined);
    assert.equal(response.body.contribution, undefined);
    assert.equal(response.body.feedRequest.id, "feed_api-test-id");
    assert.equal(response.body.feedRequest.eventId, "feed_api-test-id");
    assert.equal(response.body.feedRequest.status, "QUEUED");
    assert.equal(response.body.feedRequest.barnId, DEFAULT_RESOURCE_IDS.barnId);
    assert.equal(response.body.feedRequest.feederId, DEFAULT_RESOURCE_IDS.feederId);
    assert.equal(response.body.feedRequest.queueId, DEFAULT_RESOURCE_IDS.queueId);
    assert.equal(response.body.feedRequest.timeline, undefined);
    const persisted = app.locals.eventEngine.getFeedRequest("feed_api-test-id");
    const contribution = app.locals.eventEngine.eventStore.getContribution(
        persisted.contributionId
    );
    const providerEvent = app.locals.eventEngine.eventStore.getProviderEvent(
        contribution.providerEventId
    );
    assert.equal(providerEvent.provider, "WEBSITE");
    assert.equal(providerEvent.verificationStatus, "VERIFIED");
    assert.equal(contribution.eligibilityStatus, "ELIGIBLE");
    assert.deepEqual(
        persisted.timeline.map(entry => entry.state),
        ["RECEIVED", "VALIDATED", "QUEUED"]
    );
    assert.equal(response.body.queuePosition, 1);
    assert.equal(response.body.estimatedWaitMs, 0);
    assert.equal(response.body.feedRequest.queuePosition, 1);
    assert.equal(response.body.feedRequest.estimatedWaitMs, 0);
    assert.equal(response.body.eventEngine.queueSize, 1);
    assert.equal(response.headers.location, "/api/feed-requests/feed_api-test-id");
});

test("POST /api/development/website-contributions uses server verification", async () => {
    const app = createTestApp();
    const response = await request(app)
        .post("/api/development/website-contributions")
        .send({
            supporterName: "Development supporter",
            clientRequestId: "development-ledger-1",
            amountMinor: 750,
            currency: "GBP"
        })
        .expect(202);

    assert.equal(response.body.simulated, true);
    assert.equal(response.body.providerEvent, undefined);
    assert.equal(response.body.contribution, undefined);
    const persisted = app.locals.eventEngine.getFeedRequest(
        response.body.feedRequest.eventId
    );
    const contribution = app.locals.eventEngine.eventStore.getContribution(
        persisted.contributionId
    );
    assert.equal(contribution.amountMinor, 750);
    assert.equal(
        app.locals.eventEngine.eventStore
            .getProviderEvent(contribution.providerEventId).provider,
        "WEBSITE"
    );
});

test("development contribution endpoint rejects client-controlled verification", async () => {
    const response = await request(createTestApp())
        .post("/api/development/website-contributions")
        .send({
            supporterName: "Untrusted supporter",
            verificationStatus: "VERIFIED"
        })
        .expect(400);

    assert.equal(response.body.error.code, "CLIENT_VERIFICATION_FORBIDDEN");
});

test("production configuration disables all development feed writes", async () => {
    const app = createTestApp({
        config: {
            nodeEnv: "production",
            enableDevelopmentContributionSimulation: true
        }
    });
    const payload = { supporterName: "Production write attempt" };

    for (const path of [
        "/api/feed-requests",
        "/api/development/website-contributions",
        `/api/feeders/${DEFAULT_RESOURCE_IDS.feederId}/feed-requests`
    ]) {
        const response = await request(app).post(path).send(payload).expect(403);
        assert.equal(
            response.body.error.code,
            "DEVELOPMENT_CONTRIBUTION_SIMULATION_DISABLED"
        );
    }

    await request(app).get("/api/feed-requests").expect(200);
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
    assert.equal(response.body.feedRequests[0].supporterName, undefined);
    assert.equal(response.body.feedRequests[0].source, undefined);
    assert.equal(response.body.feedRequests[0].status, "QUEUED");
    assert.equal(response.body.feedRequests[0].barnId, DEFAULT_RESOURCE_IDS.barnId);
    assert.equal(response.body.feedRequests[0].feederId, DEFAULT_RESOURCE_IDS.feederId);
    assert.equal(response.body.feedRequests[0].queueId, DEFAULT_RESOURCE_IDS.queueId);
    assert.equal(response.body.feedRequests[0].queuePosition, 1);
    assert.equal(response.body.feedRequests[0].estimatedWaitMs, 0);
    assert.equal(response.body.feedRequests[0].timeline, undefined);
    assert.deepEqual(response.body.archivedFeedRequests, []);
    assert.equal(response.body.eventEngine.queueSize, 1);

    const administratorResponse = await request(app)
        .get(
            `/api/admin/barns/${DEFAULT_RESOURCE_IDS.barnId}`
            + `/feeders/${DEFAULT_RESOURCE_IDS.feederId}/feed-requests`
        )
        .set("authorization", VIEWER_AUTHORIZATION)
        .expect(200);
    assert.equal(administratorResponse.body.feedRequests[0].supporterName, "Grace");
    assert.equal(administratorResponse.body.feedRequests[0].timeline.length, 3);
});

test("GET /api/feed-requests/:id returns an accepted request", async () => {
    const app = createTestApp();
    await request(app).post("/api/feed-requests").send({ supporterName: "Grace" }).expect(202);

    const response = await request(app).get("/api/feed-requests/feed_api-test-id").expect(200);
    assert.equal(response.body.feedRequest.supporterName, undefined);
    assert.equal(response.body.feedRequest.queuePosition, 1);
    assert.equal(response.body.feedRequest.estimatedWaitMs, 0);
    assert.equal(response.body.feedRequest.timeline, undefined);

    const administratorResponse = await request(app)
        .get(
            `/api/admin/barns/${DEFAULT_RESOURCE_IDS.barnId}`
            + `/feeders/${DEFAULT_RESOURCE_IDS.feederId}/feed-requests`
        )
        .set("authorization", VIEWER_AUTHORIZATION)
        .expect(200);
    assert.equal(administratorResponse.body.feedRequests[0].supporterName, "Grace");
    assert.deepEqual(
        administratorResponse.body.feedRequests[0].timeline.map(entry => entry.state),
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
    const publicDetail = await request(app)
        .get(`/api/feed-requests/${eventId}`)
        .expect(200);
    assert.equal(publicDetail.body.feedRequest.timeline, undefined);
    const detail = await request(app)
        .get(
            `/api/admin/barns/${DEFAULT_RESOURCE_IDS.barnId}`
            + `/feeders/${DEFAULT_RESOURCE_IDS.feederId}/feed-requests`
        )
        .set("authorization", VIEWER_AUTHORIZATION)
        .expect(200);
    const archived = detail.body.archivedFeedRequests.find(
        feedRequest => feedRequest.eventId === eventId
    );
    assert.equal(archived.state, "ARCHIVED");
    assert.deepEqual(
        archived.timeline.map(entry => entry.state),
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

test("POST /api/feed-requests idempotently returns duplicate website events", async () => {
    const app = createTestApp();
    const payload = { supporterName: "Grace", clientRequestId: "duplicate-api-1" };
    const first = await request(app).post("/api/feed-requests").send(payload).expect(202);

    const duplicate = await request(app).post("/api/feed-requests").send(payload).expect(202);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.feedRequest.eventId, first.body.feedRequest.eventId);
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

    const response = await request(app)
        .post("/api/event-engine/reset")
        .set("authorization", ADMIN_AUTHORIZATION)
        .send({ reason: "API test reset" })
        .expect(200);
    assert.equal(response.body.reset, true);
    assert.equal(response.body.eventEngine.queueSize, 0);
    assert.equal(response.body.eventEngine.acceptedToday, 0);
});

test("POST /api/event-engine/reset is disabled by production configuration", async () => {
    const app = createTestApp({ config: { enableDemoReset: false } });
    const response = await request(app)
        .post("/api/event-engine/reset")
        .set("authorization", ADMIN_AUTHORIZATION)
        .send({ reason: "Disabled reset test" })
        .expect(403);

    assert.equal(response.body.error.code, "DEMO_RESET_DISABLED");
});

test("API responses allow the configured frontend origin", async () => {
    const response = await request(createTestApp())
        .get("/health")
        .set("origin", "http://localhost:8080")
        .expect(200);

    assert.equal(response.headers["access-control-allow-origin"], "*");
});
