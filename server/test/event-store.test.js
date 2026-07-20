import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { EventEngine } from "../src/event-engine/event-engine.js";
import {
    createTestLogger,
    getTestDeviceCommandServices,
    submitTestFeedRequest,
    testConfig
} from "./helpers.js";

function temporaryDatabase(t) {
    const directory = mkdtempSync(join(tmpdir(), "alpacaly-event-store-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return join(directory, "events.sqlite");
}

function createPersistentEngine(databasePath, overrides = {}) {
    const config = {
        ...testConfig,
        databasePath,
        ...overrides.config
    };

    const engine = new EventEngine({
        config,
        logger: createTestLogger(),
        clock: overrides.clock || (() => new Date(2026, 6, 19, 12, 0, 0)),
        idGenerator: overrides.idGenerator || (() => "persistent-test-id"),
        sleep: overrides.sleep || (async () => {}),
        autoProcess: overrides.autoProcess ?? false
    });
    getTestDeviceCommandServices(engine);
    return engine;
}

test("creates the required persistent Event Store tables", t => {
    const engine = createPersistentEngine(temporaryDatabase(t));

    assert.deepEqual(engine.eventStore.getTableNames(), [
        "Administrators",
        "ApprovalDecisions",
        "ApprovalRequestHistory",
        "ApprovalRequests",
        "AuditRecords",
        "BarnScopes",
        "Barns",
        "Cameras",
        "Contributions",
        "ControllerAssignmentHistory",
        "DeviceAcknowledgements",
        "DeviceCommandAuditRecords",
        "DeviceCommandHistory",
        "DeviceCommandOutbox",
        "DeviceCommands",
        "Devices",
        "EdgeControllerStatus",
        "EdgeControllerStatusHistory",
        "EmergencyStops",
        "Events",
        "FeedIntentHistory",
        "FeedIntents",
        "FeederDeviceAssignments",
        "Feeders",
        "HardwareAcknowledgements",
        "LifecycleHistory",
        "MqttInboundMessages",
        "MqttOutboundDeliveries",
        "MqttProtocolEvents",
        "MqttSafetyStates",
        "OperatorAuditRecords",
        "OperatorResolutionCases",
        "Outbox",
        "ProviderEvents",
        "Queue",
        "Queues",
        "RoleAssignments",
        "SimulatedControllerCommandJournal",
        "SimulatedControllerFeederAssignments",
        "SimulatedControllerJournalHistory",
        "SimulatedControllers",
        "SimulatedDeviceExecutions",
        "SimulatedDeviceFences",
        "WelfareNotes",
        "WelfareSafetyLedger"
    ]);
    assert.equal(engine.eventStore.getSchemaVersion(), 10);

    engine.close();
});

test("restores Event IDs, histories, queue order, acknowledgements and duplicate protection", t => {
    const databasePath = temporaryDatabase(t);
    let nextId = 0;
    const firstEngine = createPersistentEngine(databasePath, {
        idGenerator: () => String(++nextId)
    });
    const first = submitTestFeedRequest(firstEngine, {
        supporterName: "First supporter",
        clientRequestId: "persistent-client-1"
    });
    const second = submitTestFeedRequest(firstEngine, {
        supporterName: "Second supporter",
        clientRequestId: "persistent-client-2"
    });
    firstEngine.recordHardwareAcknowledgement(first.feedRequest.eventId, "BELL", {
        status: "ACKNOWLEDGED",
        details: { deviceId: "future-device" }
    });
    const originalTimeline = firstEngine.getFeedRequest(first.feedRequest.eventId).timeline;
    firstEngine.close();

    const restoredEngine = createPersistentEngine(databasePath);
    assert.deepEqual(
        restoredEngine.getQueueSummary().map(event => event.eventId),
        [first.feedRequest.eventId, second.feedRequest.eventId]
    );

    const restoredFirst = restoredEngine.getFeedRequest(first.feedRequest.eventId);
    assert.deepEqual(restoredFirst.timeline, originalTimeline);
    assert.equal(restoredFirst.barnId, first.feedRequest.barnId);
    assert.equal(restoredFirst.feederId, first.feedRequest.feederId);
    assert.equal(restoredFirst.queueId, first.feedRequest.queueId);
    assert.equal(
        restoredFirst.hardwareAcknowledgements.BELL.details.deviceId,
        "future-device"
    );
    assert.equal(restoredEngine.getSnapshot().acceptedToday, 2);

    const duplicate = submitTestFeedRequest(restoredEngine, {
        supporterName: "Duplicate retry",
        clientRequestId: "persistent-client-1"
    });
    assert.equal(duplicate.feedRequest.eventId, first.feedRequest.eventId);
    assert.equal(duplicate.duplicate, true);

    restoredEngine.close();
});

test("restores archived events and their complete lifecycle timelines", async t => {
    const databasePath = temporaryDatabase(t);
    const firstEngine = createPersistentEngine(databasePath, { autoProcess: true });
    const submitted = submitTestFeedRequest(firstEngine, {
        supporterName: "Archived supporter"
    });
    await firstEngine.waitForIdle();
    const original = firstEngine.getFeedRequest(submitted.feedRequest.eventId);
    firstEngine.close();

    const restoredEngine = createPersistentEngine(databasePath);
    const restored = restoredEngine.getFeedRequest(submitted.feedRequest.eventId);
    assert.equal(restored.state, "ARCHIVED");
    assert.deepEqual(restored.timeline, original.timeline);
    assert.equal(restoredEngine.getQueueSummary().length, 0);
    assert.equal(restoredEngine.getArchivedSummary().length, 1);
    assert.equal(restoredEngine.getSnapshot().completedFeeds, 1);

    restoredEngine.close();
});

test("resumes an interrupted lifecycle from the persisted state and remaining delay", async t => {
    const databasePath = temporaryDatabase(t);
    const startedAt = new Date(2026, 6, 19, 12, 0, 0, 0);
    const interruptedEngine = createPersistentEngine(databasePath, {
        config: { lifecycleCountdownMs: 1000 },
        clock: () => new Date(startedAt),
        sleep: async () => {
            throw new Error("simulated process interruption");
        }
    });
    const submitted = submitTestFeedRequest(interruptedEngine, {
        supporterName: "Restarted supporter",
        clientRequestId: "restart-client"
    });
    await interruptedEngine.processQueue();

    const interrupted = interruptedEngine.getFeedRequest(submitted.feedRequest.eventId);
    assert.equal(interrupted.state, "COUNTDOWN");
    assert.deepEqual(
        interrupted.timeline.map(entry => entry.state),
        ["RECEIVED", "VALIDATED", "QUEUED", "APPROVED", "COUNTDOWN"]
    );
    interruptedEngine.close();

    const observedDelays = [];
    const resumedEngine = createPersistentEngine(databasePath, {
        autoProcess: true,
        config: { lifecycleCountdownMs: 1000 },
        clock: () => new Date(startedAt.getTime() + 600),
        sleep: async milliseconds => {
            observedDelays.push(milliseconds);
        }
    });
    await resumedEngine.waitForIdle();

    const resumed = resumedEngine.getFeedRequest(submitted.feedRequest.eventId);
    assert.equal(observedDelays[0], 400);
    assert.equal(resumed.state, "ARCHIVED");
    assert.deepEqual(
        resumed.timeline.map(entry => entry.state),
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
    assert.equal(new Set(resumed.timeline.map(entry => entry.state)).size, 9);

    resumedEngine.close();
});

test("graceful shutdown cancels an active delay without losing its restart state", async t => {
    const databasePath = temporaryDatabase(t);
    const engine = createPersistentEngine(databasePath, {
        autoProcess: true,
        config: { lifecycleCountdownMs: 60000 },
        sleep: async (milliseconds, signal) => new Promise(resolve => {
            signal.addEventListener("abort", resolve, { once: true });
        })
    });
    const submitted = submitTestFeedRequest(engine, {
        supporterName: "Shutdown supporter"
    });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(engine.getFeedRequest(submitted.feedRequest.eventId).state, "COUNTDOWN");
    await engine.shutdown();

    const restoredEngine = createPersistentEngine(databasePath);
    assert.equal(
        restoredEngine.getFeedRequest(submitted.feedRequest.eventId).state,
        "COUNTDOWN"
    );
    assert.equal(restoredEngine.getQueueSummary().length, 1);
    restoredEngine.close();
});
