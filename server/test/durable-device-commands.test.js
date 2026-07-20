import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createContributionLedgerServices } from "../src/contribution-ledger/index.js";
import { createDeviceCommandServices } from "../src/device-commands/index.js";
import {
    createBarn,
    createFeeder,
    createQueue
} from "../src/domain/resources.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import { SqliteEventStore } from "../src/event-store/sqlite-event-store.js";
import { createTestLogger, testConfig } from "./helpers.js";

const START_TIME = Date.parse("2026-07-19T12:00:00.000Z");

function temporaryDatabase(t) {
    const directory = mkdtempSync(join(tmpdir(), "alpacaly-device-commands-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return join(directory, "events.sqlite");
}

function mutableClock(initial = START_TIME) {
    let current = initial;
    return {
        clock: () => new Date(current),
        advance(milliseconds) {
            current += milliseconds;
        }
    };
}

function createContext({
    databasePath = ":memory:",
    eventStore = null,
    autoProcess = false,
    clockController = mutableClock(),
    config = {},
    adapterSleep = async () => {},
    workerSleep = async () => {},
    startWorker = false,
    idPrefix = "device-test"
} = {}) {
    const logger = createTestLogger();
    let nextId = 0;
    const idGenerator = () => `${idPrefix}-${++nextId}`;
    const resolvedConfig = {
        ...testConfig,
        deviceCommandRetryDelayMs: 0,
        deviceAcknowledgementTimeoutMs: 100,
        ...config,
        databasePath
    };
    const eventEngine = new EventEngine({
        config: resolvedConfig,
        logger,
        clock: clockController.clock,
        idGenerator,
        sleep: async () => {},
        autoProcess,
        eventStore
    });
    const deviceCommands = createDeviceCommandServices({
        eventEngine,
        config: resolvedConfig,
        logger,
        clock: clockController.clock,
        idGenerator,
        adapterSleep,
        workerSleep,
        startWorker
    });
    const ledger = createContributionLedgerServices({
        eventEngine,
        logger,
        clock: clockController.clock,
        idGenerator
    });
    return {
        clockController,
        config: resolvedConfig,
        deviceCommands,
        eventEngine,
        ledger
    };
}

function submit(context, supporterName, options = {}) {
    return context.ledger.developmentWebsiteContributionService.simulate({
        supporterName,
        clientRequestId: options.clientRequestId || `${supporterName}-request`
    }, options.feederId ? { feederId: options.feederId } : undefined).feedRequest;
}

function acknowledgement(command, result, acknowledgementId, overrides = {}) {
    return {
        acknowledgementId,
        commandId: command.commandId,
        deviceId: command.deviceId,
        acknowledgementType: `${command.commandType}_RESULT`,
        receivedAt: overrides.receivedAt || "2026-07-19T12:00:01.000Z",
        deviceTimestamp: overrides.deviceTimestamp || "2026-07-19T12:00:01.000Z",
        result,
        measuredQuantity: overrides.measuredQuantity ?? null,
        errorCode: overrides.errorCode || null,
        errorMessage: overrides.errorMessage || null,
        metadata: { simulated: true }
    };
}

async function waitUntil(predicate, { timeoutMs = 2000 } = {}) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        if (predicate()) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    if (predicate()) {
        return;
    }
    throw new Error(
        `Timed out after ${timeoutMs}ms waiting for durable device command state.`
    );
}

test("lifecycle waits for durable bell and dispensing acknowledgements", async () => {
    let releaseBell;
    let adapterCall = 0;
    const context = createContext({
        adapterSleep: async () => {
            adapterCall += 1;
            if (adapterCall === 1) {
                await new Promise(resolve => {
                    releaseBell = resolve;
                });
            }
        }
    });
    const feedRequest = submit(context, "Lifecycle supporter");
    const processing = context.eventEngine.processQueue();

    await waitUntil(() => context.deviceCommands.deviceCommandStore
        .getCommandForEventAction(feedRequest.eventId, "RING_BELL")?.status === "SENT");
    assert.equal(context.eventEngine.getFeedRequest(feedRequest.eventId).state, "BELL");
    assert.equal(
        context.deviceCommands.deviceCommandStore
            .getCommandForEventAction(feedRequest.eventId, "DISPENSE_FEED"),
        null
    );

    releaseBell();
    await processing;

    const commands = context.deviceCommands.deviceCommandStore
        .getCommandsForEvent(feedRequest.eventId);
    assert.deepEqual(commands.map(command => command.commandType), [
        "RING_BELL",
        "DISPENSE_FEED"
    ]);
    assert.deepEqual(commands.map(command => command.status), [
        "ACKNOWLEDGED",
        "ACKNOWLEDGED"
    ]);
    assert.deepEqual(
        context.eventEngine.getFeedRequest(feedRequest.eventId).timeline
            .map(entry => entry.state),
        [
            "RECEIVED", "VALIDATED", "QUEUED", "APPROVED", "COUNTDOWN",
            "BELL", "DISPENSING", "COMPLETE", "ARCHIVED"
        ]
    );
    commands.forEach(command => {
        assert.equal(
            context.deviceCommands.deviceCommandStore
                .getSimulatedExecution(command.commandId).actionCount,
            1
        );
        assert.ok(command.acknowledgedAt);
        assert.ok(command.completedAt);
    });
    context.eventEngine.close();
});

test("unavailable devices retry to the configured maximum and block lifecycle", async () => {
    const context = createContext({
        config: { deviceCommandMaximumAttempts: 2 }
    });
    const feedRequest = submit(context, "Unavailable device supporter");
    const command = context.deviceCommands.deviceCommandService
        .ensureCommandForEvent(feedRequest, "RING_BELL").command;
    context.deviceCommands.deviceAdapter.setDeviceAvailable(command.deviceId, false);

    await context.deviceCommands.worker.processCommand(command.commandId);
    assert.equal(
        context.deviceCommands.deviceCommandStore.getCommand(command.commandId).status,
        "RETRY_SCHEDULED"
    );
    await context.deviceCommands.worker.processCommand(command.commandId);
    const failed = context.deviceCommands.deviceCommandStore.getCommand(command.commandId);
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.attemptCount, 2);
    assert.match(failed.lastError, /unavailable/i);
    assert.equal(
        context.deviceCommands.deviceCommandStore.getSimulatedExecution(command.commandId),
        null
    );
    assert.deepEqual(
        context.deviceCommands.deviceCommandStore.getHistory(command.commandId)
            .map(entry => entry.toStatus),
        ["PENDING", "READY", "SENT", "RETRY_SCHEDULED", "SENT", "FAILED"]
    );
    context.eventEngine.close();
});

test("timeouts distinguish safe retries from unknown physical outcomes", async () => {
    const safeClock = mutableClock();
    const safe = createContext({ clockController: safeClock });
    const safeFeed = submit(safe, "Timeout retry supporter");
    const safeCommand = safe.deviceCommands.deviceCommandService
        .ensureCommandForEvent(safeFeed, "RING_BELL").command;
    safe.deviceCommands.deviceAdapter.setCommandBehavior(safeCommand.commandId, {
        performAction: false
    });
    await safe.deviceCommands.worker.processCommand(safeCommand.commandId);
    safeClock.advance(101);
    await safe.deviceCommands.worker.processCommand(safeCommand.commandId, {
        forceReconcile: true
    });
    assert.equal(
        safe.deviceCommands.deviceCommandStore.getCommand(safeCommand.commandId).status,
        "RETRY_SCHEDULED"
    );
    assert.ok(safe.deviceCommands.deviceCommandStore.getHistory(safeCommand.commandId)
        .some(entry => entry.toStatus === "TIMED_OUT"));
    safe.eventEngine.close();

    const unknownClock = mutableClock();
    const unknown = createContext({ clockController: unknownClock });
    const unknownFeed = submit(unknown, "Unknown outcome supporter");
    const unknownCommand = unknown.deviceCommands.deviceCommandService
        .ensureCommandForEvent(unknownFeed, "DISPENSE_FEED").command;
    unknown.deviceCommands.deviceAdapter.setCommandBehavior(unknownCommand.commandId, {
        performAction: false,
        reconciliationOutcome: "UNKNOWN"
    });
    await unknown.deviceCommands.worker.processCommand(unknownCommand.commandId);
    unknownClock.advance(101);
    await unknown.deviceCommands.worker.processCommand(unknownCommand.commandId, {
        forceReconcile: true
    });
    const unresolved = unknown.deviceCommands.deviceCommandStore
        .getCommand(unknownCommand.commandId);
    assert.equal(unresolved.status, "OUTCOME_UNKNOWN");
    assert.equal(unresolved.attemptCount, 1);
    assert.equal(
        unknown.deviceCommands.deviceCommandStore
            .getSimulatedExecution(unknownCommand.commandId),
        null
    );
    unknown.eventEngine.close();
});

test("acknowledgements are durable, duplicate-safe, late-aware and order-aware", () => {
    const context = createContext();
    const feedRequest = submit(context, "Acknowledgement supporter");
    const command = context.deviceCommands.deviceCommandService
        .ensureCommandForEvent(feedRequest, "RING_BELL").command;
    context.deviceCommands.deviceCommandStore.transitionCommand(command.commandId, "SENT", {
        timestamp: "2026-07-19T12:00:00.000Z",
        acknowledgementDeadline: "2026-07-19T12:00:00.500Z",
        incrementAttempt: true
    });

    context.deviceCommands.acknowledgementService.record(
        acknowledgement(command, "STARTED", "ack-started", {
            receivedAt: "2026-07-19T12:00:00.100Z"
        })
    );
    const success = context.deviceCommands.acknowledgementService.record(
        acknowledgement(command, "SUCCEEDED", "ack-succeeded", {
            receivedAt: "2026-07-19T12:00:00.200Z"
        })
    );
    assert.equal(success.command.status, "ACKNOWLEDGED");

    const lateOutOfOrder = context.deviceCommands.acknowledgementService.record(
        acknowledgement(command, "ACCEPTED", "ack-late-accepted", {
            receivedAt: "2026-07-19T12:00:01.000Z"
        })
    );
    assert.equal(lateOutOfOrder.late, true);
    assert.equal(lateOutOfOrder.outOfOrder, true);
    const duplicate = context.deviceCommands.acknowledgementService.record(
        acknowledgement(command, "SUCCEEDED", "ack-succeeded", {
            receivedAt: "2026-07-19T12:00:02.000Z"
        })
    );
    assert.equal(duplicate.duplicate, true);
    assert.equal(
        context.deviceCommands.deviceCommandStore
            .getAcknowledgementsForCommand(command.commandId).length,
        3
    );
    assert.deepEqual(
        new Set(context.deviceCommands.deviceCommandStore
            .getAuditRecords(command.commandId).map(record => record.action)),
        new Set([
            "COMMAND_STATE_CHANGED",
            "ACKNOWLEDGEMENT_RECEIVED",
            "LATE_ACKNOWLEDGEMENT",
            "OUT_OF_ORDER_ACKNOWLEDGEMENT",
            "DUPLICATE_ACKNOWLEDGEMENT"
        ])
    );
    context.eventEngine.close();
});

test("late success preserves OUTCOME_UNKNOWN for operator resolution and cannot revive FAILED commands", () => {
    const context = createContext();
    const firstFeed = submit(context, "Late unknown supporter");
    const unknown = context.deviceCommands.deviceCommandService
        .ensureCommandForEvent(firstFeed, "DISPENSE_FEED").command;
    context.deviceCommands.deviceCommandStore.transitionCommand(
        unknown.commandId,
        "OUTCOME_UNKNOWN",
        {
            timestamp: "2026-07-19T12:00:01.000Z",
            lastError: "Uncertain result"
        }
    );
    const recovered = context.deviceCommands.acknowledgementService.record(
        acknowledgement(unknown, "SUCCEEDED", "ack-late-success")
    );
    assert.equal(recovered.command.status, "OUTCOME_UNKNOWN");
    assert.equal(recovered.late, true);

    const secondFeed = submit(context, "Late failed supporter");
    const failed = context.deviceCommands.deviceCommandService
        .ensureCommandForEvent(secondFeed, "DISPENSE_FEED").command;
    context.deviceCommands.deviceCommandStore.transitionCommand(
        failed.commandId,
        "FAILED",
        {
            timestamp: "2026-07-19T12:00:01.000Z",
            lastError: "Confirmed failure"
        }
    );
    const ignored = context.deviceCommands.acknowledgementService.record(
        acknowledgement(failed, "SUCCEEDED", "ack-after-failure")
    );
    assert.equal(ignored.command.status, "FAILED");
    assert.equal(ignored.late, true);
    context.eventEngine.close();
});

test("per-feeder command delivery is ordered and resource-isolated", async () => {
    const logger = createTestLogger();
    const eventStore = new SqliteEventStore({ databasePath: ":memory:", logger });
    const barn = createBarn({
        barnId: "barn_device_isolation",
        name: "Device isolation barn",
        createdAt: new Date(START_TIME).toISOString()
    });
    eventStore.saveBarn(barn);
    for (const suffix of ["alpha", "beta"]) {
        const feeder = createFeeder({
            feederId: `feeder_${suffix}`,
            barnId: barn.barnId,
            name: `${suffix} feeder`,
            createdAt: new Date(START_TIME).toISOString()
        });
        eventStore.saveFeeder(feeder);
        eventStore.saveQueue(createQueue({
            queueId: `queue_${suffix}`,
            barnId: barn.barnId,
            feederId: feeder.feederId,
            name: `${suffix} queue`,
            createdAt: new Date(START_TIME).toISOString()
        }));
    }
    const context = createContext({ eventStore });
    const alphaOne = submit(context, "Alpha one", { feederId: "feeder_alpha" });
    const alphaTwo = submit(context, "Alpha two", { feederId: "feeder_alpha" });
    const betaOne = submit(context, "Beta one", { feederId: "feeder_beta" });
    const commands = [alphaOne, alphaTwo, betaOne].map(feedRequest => (
        context.deviceCommands.deviceCommandService
            .ensureCommandForEvent(feedRequest, "RING_BELL").command
    ));

    const deliverable = context.deviceCommands.deviceCommandStore
        .getDeliverableCommands(new Date(START_TIME).toISOString());
    assert.deepEqual(
        new Set(deliverable.map(command => command.commandId)),
        new Set([commands[0].commandId, commands[2].commandId])
    );
    assert.notEqual(commands[0].deviceId, commands[2].deviceId);
    assert.equal(commands[0].fencingToken, 1);
    assert.equal(commands[1].fencingToken, 2);
    assert.equal(commands[2].fencingToken, 1);

    await Promise.all(deliverable.map(command => (
        context.deviceCommands.worker.processCommand(command.commandId)
    )));
    assert.deepEqual(
        context.deviceCommands.deviceCommandStore
            .getDeliverableCommands(new Date(START_TIME).toISOString())
            .map(command => command.commandId),
        [commands[1].commandId]
    );
    context.eventEngine.close();
});

test("device reconnection resumes the same command without duplicating its action", async () => {
    const context = createContext();
    const feedRequest = submit(context, "Reconnect supporter");
    const command = context.deviceCommands.deviceCommandService
        .ensureCommandForEvent(feedRequest, "RING_BELL").command;
    context.deviceCommands.deviceAdapter.setDeviceAvailable(command.deviceId, false);
    await context.deviceCommands.worker.processCommand(command.commandId);
    assert.equal(
        context.deviceCommands.deviceCommandStore.getCommand(command.commandId).status,
        "RETRY_SCHEDULED"
    );

    context.deviceCommands.deviceAdapter.setDeviceAvailable(command.deviceId, true);
    await context.deviceCommands.worker.processCommand(command.commandId);
    const resolved = context.deviceCommands.deviceCommandStore
        .getCommand(command.commandId);
    assert.equal(resolved.status, "ACKNOWLEDGED");
    assert.equal(resolved.attemptCount, 2);
    assert.equal(
        context.deviceCommands.deviceCommandStore
            .getSimulatedExecution(command.commandId).actionCount,
        1
    );
    context.eventEngine.close();
});

test("durable fencing rejects stale commands after a newer token executes", async () => {
    const context = createContext();
    const olderFeed = submit(context, "Older fence supporter");
    const newerFeed = submit(context, "Newer fence supporter");
    const older = context.deviceCommands.deviceCommandService
        .ensureCommandForEvent(olderFeed, "DISPENSE_FEED").command;
    const newer = context.deviceCommands.deviceCommandService
        .ensureCommandForEvent(newerFeed, "DISPENSE_FEED").command;
    assert.ok(newer.fencingToken > older.fencingToken);

    await context.deviceCommands.worker.processCommand(newer.commandId);
    await context.deviceCommands.worker.processCommand(older.commandId);

    assert.equal(
        context.deviceCommands.deviceCommandStore.getCommand(newer.commandId).status,
        "ACKNOWLEDGED"
    );
    assert.equal(
        context.deviceCommands.deviceCommandStore.getCommand(older.commandId).status,
        "FAILED"
    );
    assert.equal(
        context.deviceCommands.deviceCommandStore.getSimulatedExecution(older.commandId),
        null
    );
    assert.equal(
        context.deviceCommands.deviceCommandStore.getSimulatedFence(newer.deviceId)
            .highestFencingToken,
        newer.fencingToken
    );
    context.eventEngine.close();
});

test("malformed acknowledgements are rejected and cancellation is durable", () => {
    const context = createContext();
    const feedRequest = submit(context, "Cancellation supporter");
    const command = context.deviceCommands.deviceCommandService
        .ensureCommandForEvent(feedRequest, "RING_BELL").command;

    assert.throws(() => context.deviceCommands.acknowledgementService.record({
        deviceId: command.deviceId,
        acknowledgementType: "RING_BELL_RESULT",
        result: "SUCCEEDED"
    }), /commandId is required/);
    const wrongDeviceAcknowledgement = {
        ...acknowledgement(command, "SUCCEEDED", "wrong-device-ack"),
        deviceId: "device_wrong"
    };
    assert.throws(() => context.deviceCommands.acknowledgementService.record(
        wrongDeviceAcknowledgement
    ), /does not match/);

    const cancelled = context.deviceCommands.deviceCommandService.cancel(
        command.commandId,
        "ADMINISTRATIVE_CANCELLATION"
    );
    assert.equal(cancelled.status, "CANCELLED");
    assert.ok(cancelled.completedAt);
    assert.equal(
        context.eventEngine.eventStore.database.prepare(`
            SELECT status FROM DeviceCommandOutbox WHERE commandId = ?
        `).get(command.commandId).status,
        "CANCELLED"
    );
    assert.equal(
        context.deviceCommands.deviceCommandStore
            .getAcknowledgementsForCommand(command.commandId).length,
        0
    );
    context.eventEngine.close();
});

test("restart recovers a ready command and creates exactly one physical action", async t => {
    const databasePath = temporaryDatabase(t);
    const first = createContext({ databasePath, idPrefix: "ready-before-restart" });
    const feedRequest = submit(first, "Ready restart supporter");
    const command = first.deviceCommands.deviceCommandService
        .ensureCommandForEvent(feedRequest, "RING_BELL").command;
    assert.equal(command.status, "READY");
    first.eventEngine.close();

    const second = createContext({ databasePath, idPrefix: "ready-after-restart" });
    const resolved = await second.deviceCommands.worker
        .driveCommandToResolution(command.commandId);
    assert.equal(resolved.status, "ACKNOWLEDGED");
    assert.equal(resolved.attemptCount, 1);
    assert.equal(
        second.deviceCommands.deviceCommandStore
            .getSimulatedExecution(command.commandId).actionCount,
        1
    );
    assert.equal(
        second.deviceCommands.deviceCommandStore
            .getAcknowledgementsForCommand(command.commandId).length,
        1
    );
    second.eventEngine.close();
});

test("real restart reconciles action-before-ack without duplicate feeding", async t => {
    const databasePath = temporaryDatabase(t);
    const first = createContext({ databasePath, idPrefix: "dispatch-crash-one" });
    const feedRequest = submit(first, "Dispatch crash supporter");
    const command = first.deviceCommands.deviceCommandService
        .ensureCommandForEvent(feedRequest, "DISPENSE_FEED").command;
    first.deviceCommands.deviceAdapter.setCommandBehavior(command.commandId, {
        dropAcknowledgement: true
    });
    await first.deviceCommands.worker.processCommand(command.commandId);
    assert.equal(
        first.deviceCommands.deviceCommandStore.getCommand(command.commandId).status,
        "SENT"
    );
    assert.equal(
        first.deviceCommands.deviceCommandStore
            .getSimulatedExecution(command.commandId).actionCount,
        1
    );
    first.eventEngine.close();

    const second = createContext({ databasePath, idPrefix: "dispatch-crash-two" });
    await second.deviceCommands.worker.processCommand(command.commandId, {
        forceReconcile: true
    });
    const recovered = second.deviceCommands.deviceCommandStore
        .getCommand(command.commandId);
    assert.equal(recovered.status, "ACKNOWLEDGED");
    assert.equal(recovered.attemptCount, 1);
    assert.equal(
        second.deviceCommands.deviceCommandStore
            .getSimulatedExecution(command.commandId).actionCount,
        1
    );
    assert.equal(
        second.deviceCommands.deviceCommandStore
            .getAcknowledgementsForCommand(command.commandId).length,
        1
    );
    second.eventEngine.close();
});

test("worker startup recovers pending, retrying and timed-out commands", async t => {
    const databasePath = temporaryDatabase(t);
    const first = createContext({ databasePath, idPrefix: "mixed-recovery-one" });
    const commands = ["Pending", "Retrying", "Timed out"].map(label => {
        const feedRequest = submit(first, `${label} restart supporter`);
        return first.deviceCommands.deviceCommandService
            .ensureCommandForEvent(feedRequest, "RING_BELL").command;
    });
    first.deviceCommands.deviceCommandStore.transitionCommand(
        commands[0].commandId,
        "PENDING",
        { timestamp: "2026-07-19T12:00:00.000Z" }
    );
    first.deviceCommands.deviceCommandStore.transitionCommand(
        commands[1].commandId,
        "SENT",
        {
            timestamp: "2026-07-19T12:00:00.000Z",
            acknowledgementDeadline: "2026-07-19T12:00:00.100Z",
            incrementAttempt: true
        }
    );
    first.deviceCommands.deviceCommandStore.transitionCommand(
        commands[1].commandId,
        "RETRY_SCHEDULED",
        {
            timestamp: "2026-07-19T12:00:00.000Z",
            nextAttemptAt: "2026-07-19T12:00:00.000Z"
        }
    );
    first.deviceCommands.deviceCommandStore.transitionCommand(
        commands[2].commandId,
        "SENT",
        {
            timestamp: "2026-07-19T12:00:00.000Z",
            acknowledgementDeadline: "2026-07-19T12:00:00.000Z",
            incrementAttempt: true
        }
    );
    first.deviceCommands.deviceCommandStore.transitionCommand(
        commands[2].commandId,
        "TIMED_OUT",
        { timestamp: "2026-07-19T12:00:00.001Z" }
    );
    first.eventEngine.close();

    const second = createContext({
        databasePath,
        startWorker: true,
        idPrefix: "mixed-recovery-two"
    });
    await waitUntil(() => commands.every(command => (
        second.deviceCommands.deviceCommandStore
            .getCommand(command.commandId).status === "ACKNOWLEDGED"
    )));
    await second.deviceCommands.worker.stop();
    commands.forEach(command => {
        assert.equal(
            second.deviceCommands.deviceCommandStore
                .getSimulatedExecution(command.commandId).actionCount,
            1
        );
    });
    second.eventEngine.close();
});

test("restart after acknowledgement resumes lifecycle without replaying the command", async t => {
    const databasePath = temporaryDatabase(t);
    const first = createContext({ databasePath, idPrefix: "ack-crash-one" });
    const feedRequest = submit(first, "Acknowledged restart supporter");
    const persistedFeed = first.eventEngine.feedRequests.get(feedRequest.eventId);
    first.eventEngine.transitionTo(persistedFeed, "APPROVED", { test: true });
    first.eventEngine.transitionTo(persistedFeed, "COUNTDOWN", { test: true });
    first.eventEngine.transitionTo(persistedFeed, "BELL", { test: true });
    const ring = first.deviceCommands.deviceCommandService
        .ensureCommandForEvent(persistedFeed, "RING_BELL").command;
    await first.deviceCommands.worker.driveCommandToResolution(ring.commandId);
    assert.equal(
        first.eventEngine.getFeedRequest(feedRequest.eventId).state,
        "BELL"
    );
    first.eventEngine.close();

    const second = createContext({
        databasePath,
        autoProcess: true,
        idPrefix: "ack-crash-two"
    });
    await second.eventEngine.waitForIdle();
    assert.equal(
        second.eventEngine.getFeedRequest(feedRequest.eventId).state,
        "ARCHIVED"
    );
    assert.equal(
        second.deviceCommands.deviceCommandStore
            .getSimulatedExecution(ring.commandId).actionCount,
        1
    );
    assert.equal(
        second.deviceCommands.deviceCommandStore
            .getCommandsForEvent(feedRequest.eventId).length,
        2
    );
    second.eventEngine.close();
});

test("background worker stops cleanly and resumes pending outbox work", async () => {
    const context = createContext();
    const feedRequest = submit(context, "Worker restart supporter");
    const command = context.deviceCommands.deviceCommandService
        .ensureCommandForEvent(feedRequest, "RING_BELL").command;

    context.deviceCommands.worker.start();
    await context.deviceCommands.worker.stop();
    context.deviceCommands.worker.start();
    await waitUntil(() => context.deviceCommands.deviceCommandStore
        .getCommand(command.commandId).status === "ACKNOWLEDGED");
    await context.deviceCommands.worker.stop();
    assert.equal(
        context.deviceCommands.deviceCommandStore
            .getSimulatedExecution(command.commandId).actionCount,
        1
    );
    context.eventEngine.close();
});
