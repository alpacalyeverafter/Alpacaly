import assert from "node:assert/strict";
import test from "node:test";

import request from "supertest";

import { createApp } from "../src/app.js";
import {
    DEFAULT_RESOURCE_IDS,
    createBarn,
    createFeeder,
    createQueue
} from "../src/domain/resources.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import { SqliteEventStore } from "../src/event-store/sqlite-event-store.js";
import { lifecyclePayloadTargetsFeeder } from "../src/routes/event-engine.js";
import { createTestLogger, testConfig } from "./helpers.js";

const RESOURCE_IDS = Object.freeze({
    barnId: "barn_api_resources",
    feederId: "feeder_api_resource",
    queueId: "queue_api_resource"
});

function createResourceAwareApp(t) {
    const logger = createTestLogger();
    const eventStore = new SqliteEventStore({
        databasePath: ":memory:",
        logger
    });
    eventStore.saveBarn(createBarn({
        barnId: RESOURCE_IDS.barnId,
        name: "API Resource Barn",
        createdAt: "2026-07-19T12:00:00.000Z"
    }));
    eventStore.saveFeeder(createFeeder({
        feederId: RESOURCE_IDS.feederId,
        barnId: RESOURCE_IDS.barnId,
        name: "API Resource Feeder",
        createdAt: "2026-07-19T12:00:00.000Z"
    }));
    eventStore.saveQueue(createQueue({
        queueId: RESOURCE_IDS.queueId,
        barnId: RESOURCE_IDS.barnId,
        feederId: RESOURCE_IDS.feederId,
        name: "API Resource Queue",
        createdAt: "2026-07-19T12:00:00.000Z"
    }));

    let nextId = 0;
    const eventEngine = new EventEngine({
        config: testConfig,
        logger,
        eventStore,
        clock: () => new Date(2026, 6, 19, 12, 0, 0),
        idGenerator: () => `resource-api-${++nextId}`,
        sleep: async () => {},
        autoProcess: false
    });
    t.after(() => eventEngine.close());
    return createApp({ config: testConfig, logger, eventEngine });
}

test("keeps the existing live stream scoped to the default feeder", () => {
    assert.equal(lifecyclePayloadTargetsFeeder({
        type: "EVENT_ENGINE_SNAPSHOT"
    }, DEFAULT_RESOURCE_IDS.feederId), true);
    assert.equal(lifecyclePayloadTargetsFeeder({
        feedRequest: { feederId: DEFAULT_RESOURCE_IDS.feederId }
    }, DEFAULT_RESOURCE_IDS.feederId), true);
    assert.equal(lifecyclePayloadTargetsFeeder({
        queueStatistics: { feederId: RESOURCE_IDS.feederId }
    }, DEFAULT_RESOURCE_IDS.feederId), false);
});

test("keeps existing feed-request endpoints scoped to the default feeder", async t => {
    const app = createResourceAwareApp(t);
    const defaultResponse = await request(app)
        .post("/api/feed-requests")
        .send({
            supporterName: "Default API supporter",
            feederId: RESOURCE_IDS.feederId
        })
        .expect(202);
    const resourceResponse = await request(app)
        .post(`/api/feeders/${RESOURCE_IDS.feederId}/feed-requests`)
        .send({ supporterName: "Resource API supporter" })
        .expect(202);

    assert.equal(defaultResponse.body.feedRequest.feederId, DEFAULT_RESOURCE_IDS.feederId);
    assert.equal(resourceResponse.body.feedRequest.feederId, RESOURCE_IDS.feederId);
    assert.equal(
        resourceResponse.headers.location,
        `/api/feeders/${RESOURCE_IDS.feederId}/feed-requests/${resourceResponse.body.feedRequest.eventId}`
    );

    const existingList = await request(app).get("/api/feed-requests").expect(200);
    assert.deepEqual(
        existingList.body.feedRequests.map(event => event.eventId),
        [defaultResponse.body.feedRequest.eventId]
    );
    assert.equal(existingList.body.eventEngine.queueSize, 1);

    const existingStatus = await request(app)
        .get("/api/event-engine/status")
        .expect(200);
    assert.equal(existingStatus.body.eventEngine.queueSize, 1);
    assert.equal(
        existingStatus.body.eventEngine.activeEvent,
        null
    );

    const legacyDetail = await request(app)
        .get(`/api/feed-requests/${resourceResponse.body.feedRequest.eventId}`)
        .expect(404);
    assert.equal(legacyDetail.body.error.code, "FEED_REQUEST_NOT_FOUND");
});

test("exposes feeder queue contents, statistics, and event detail", async t => {
    const app = createResourceAwareApp(t);
    const created = await request(app)
        .post(`/api/feeders/${RESOURCE_IDS.feederId}/feed-requests`)
        .send({
            supporterName: "Feeder-specific supporter",
            clientRequestId: "resource-api-client"
        })
        .expect(202);

    const queue = await request(app)
        .get(`/api/feeders/${RESOURCE_IDS.feederId}/queue`)
        .expect(200);
    assert.equal(queue.body.feedRequests.length, 1);
    assert.equal(queue.body.feedRequests[0].eventId, created.body.feedRequest.eventId);
    assert.deepEqual(queue.body.archivedFeedRequests, []);
    assert.equal(queue.body.queueStatistics.waitingCount, 1);
    assert.equal(queue.body.queueStatistics.activeCount, 0);
    assert.equal(queue.body.queueStatistics.archivedCount, 0);
    assert.equal(queue.body.queueStatistics.feederStatus, "QUEUED");

    const alias = await request(app)
        .get(`/api/feeders/${RESOURCE_IDS.feederId}/feed-requests`)
        .expect(200);
    assert.equal(alias.body.feedRequests[0].eventId, created.body.feedRequest.eventId);

    const detail = await request(app)
        .get(
            `/api/feeders/${RESOURCE_IDS.feederId}/feed-requests/${created.body.feedRequest.eventId}`
        )
        .expect(200);
    assert.equal(detail.body.feedRequest.queueId, RESOURCE_IDS.queueId);
    assert.equal(detail.body.feedRequest.queuePosition, 1);
});

test("provides central statistics without combining feeder queues", async t => {
    const app = createResourceAwareApp(t);
    await request(app)
        .post("/api/feed-requests")
        .send({ supporterName: "Default central supporter" })
        .expect(202);
    await request(app)
        .post(`/api/feeders/${RESOURCE_IDS.feederId}/feed-requests`)
        .send({ supporterName: "Resource central supporter" })
        .expect(202);

    const eventEngineQueues = await request(app)
        .get("/api/event-engine/queues")
        .expect(200);
    const statisticsByFeeder = new Map(
        eventEngineQueues.body.queues.map(queue => [queue.feederId, queue])
    );
    assert.equal(statisticsByFeeder.get(DEFAULT_RESOURCE_IDS.feederId).waitingCount, 1);
    assert.equal(statisticsByFeeder.get(RESOURCE_IDS.feederId).waitingCount, 1);

    const feeders = await request(app).get("/api/feeders").expect(200);
    assert.deepEqual(feeders.body.feeders, eventEngineQueues.body.queues);
});

test("returns resource-aware not-found errors without leaking another feeder event", async t => {
    const app = createResourceAwareApp(t);
    const created = await request(app)
        .post("/api/feed-requests")
        .send({ supporterName: "Default private resource" })
        .expect(202);

    const unknownFeeder = await request(app)
        .get("/api/feeders/feeder_missing/queue")
        .expect(404);
    assert.equal(unknownFeeder.body.error.code, "FEEDER_NOT_FOUND");

    const wrongFeeder = await request(app)
        .get(
            `/api/feeders/${RESOURCE_IDS.feederId}/feed-requests/${created.body.feedRequest.eventId}`
        )
        .expect(404);
    assert.equal(wrongFeeder.body.error.code, "FEED_REQUEST_NOT_FOUND");
});
