import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import request from "supertest";

import { createApp } from "../src/app.js";
import { SimulatedDeviceController } from
    "../src/device-controllers/simulated-device-controller.js";
import { DEFAULT_SIMULATED_CONTROLLER_ID } from
    "../src/domain/device-controllers.js";
import { DEFAULT_RESOURCE_IDS } from "../src/domain/resources.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import {
    EVENT_STORE_MIGRATIONS,
    EVENT_STORE_SCHEMA_VERSION
} from "../src/event-store/migrations/index.js";
import { SqliteEventStore } from "../src/event-store/sqlite-event-store.js";
import { createTestLogger, testConfig } from "./helpers.js";

const START_TIME = Date.parse("2026-07-20T12:00:00.000Z");
const AUTH = Object.freeze({
    admin: "Development local-admin",
    hardware: "Development local-hardware",
    viewer: "Development local-viewer"
});

function temporaryDatabase(t) {
    const directory = mkdtempSync(join(tmpdir(), "alpacaly-controller-"));
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

async function createHarness({
    databasePath = ":memory:",
    clockController = mutableClock(),
    config = {}
} = {}) {
    const resolvedConfig = {
        ...testConfig,
        databasePath,
        deviceCommandRetryDelayMs: 0,
        deviceAcknowledgementTimeoutMs: 100,
        simulatedControllerHeartbeatIntervalMs: 1000,
        simulatedControllerHeartbeatTimeoutMs: 3000,
        ...config
    };
    const logger = createTestLogger();
    const eventEngine = new EventEngine({
        config: resolvedConfig,
        logger,
        clock: clockController.clock,
        autoProcess: false,
        sleep: async () => {}
    });
    const app = createApp({ config: resolvedConfig, logger, eventEngine });
    await app.locals.deviceCommandServices.worker.stop();
    app.locals.deviceCommandServices.worker.cancelInFlight();
    app.locals.contributionLedgerServices.outboxWorker.stop();
    return {
        app,
        clockController,
        config: resolvedConfig,
        eventEngine,
        devices: app.locals.deviceCommandServices,
        safety: app.locals.operatorSafetyServices,
        administrators: app.locals.administratorSecurityServices,
        async close() {
            await app.locals.deviceCommandServices.worker.stop();
            app.locals.contributionLedgerServices.outboxWorker.stop();
            if (!eventEngine.eventStore.closed) {
                await eventEngine.shutdown();
            }
        }
    };
}

function submit(harness, suffix) {
    return harness.app.locals.contributionLedgerServices
        .developmentWebsiteContributionService.simulate({
            supporterName: `Controller supporter ${suffix}`,
            clientRequestId: `controller-${suffix}`
        }).feedRequest;
}

function commandFor(harness, suffix, commandType = "DISPENSE_FEED") {
    const feedRequest = submit(harness, suffix);
    return harness.devices.deviceCommandService.ensureCommandForEvent(
        feedRequest,
        commandType
    ).command;
}

function setBehaviour(harness, mode, delays = {}) {
    return harness.devices.controllerStore.setBehaviour(
        DEFAULT_SIMULATED_CONTROLLER_ID,
        { mode, ...delays },
        harness.clockController.clock().toISOString()
    );
}

function administratorContext(harness, administratorId, role, reason) {
    const administrator = harness.administrators.store.getAdministrator(
        administratorId
    );
    return {
        identity: {
            ...administrator,
            authenticationStrength: "DEVELOPMENT",
            assignments: harness.administrators.store.getIdentityAssignments(
                administratorId
            )
        },
        authorization: { effectiveRole: role },
        requestId: `controller-request-${administratorId}`,
        reason
    };
}

async function waitUntil(predicate, timeoutMs = 2000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
        if (predicate()) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for simulated controller recovery.");
}

test("controller identity, resource assignments and configuration persist", async t => {
    const databasePath = temporaryDatabase(t);
    const first = await createHarness({ databasePath });
    const controller = first.devices.controllerStore.getController(
        DEFAULT_SIMULATED_CONTROLLER_ID
    );
    assert.equal(controller.barnId, DEFAULT_RESOURCE_IDS.barnId);
    assert.equal(controller.enabled, true);
    assert.deepEqual(controller.assignments.map(item => item.feederId), [
        DEFAULT_RESOURCE_IDS.feederId
    ]);
    first.devices.controllerStore.setBehaviour(
        controller.controllerId,
        { mode: "ACKNOWLEDGEMENT_LOSS", acknowledgementDelayMs: 5 },
        first.clockController.clock().toISOString()
    );
    await first.close();

    const second = await createHarness({ databasePath });
    const restored = second.devices.controllerStore.getController(
        controller.controllerId
    );
    assert.equal(restored.controllerId, controller.controllerId);
    assert.equal(restored.simulationBehaviour.mode, "ACKNOWLEDGEMENT_LOSS");
    assert.equal(restored.simulationBehaviour.acknowledgementDelayMs, 5);
    await second.close();
});

test("a controller rejects commands outside its Barn and Feeder assignments", async t => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const store = harness.eventEngine.eventStore;
    const createdAt = harness.clockController.clock().toISOString();
    store.saveBarn({
        barnId: "barn_controller_other",
        name: "Other Controller Barn",
        timezone: "Europe/London",
        createdAt
    });
    store.saveFeeder({
        feederId: "feeder_controller_other",
        barnId: "barn_controller_other",
        name: "Other Controller Feeder",
        createdAt
    });
    const other = harness.devices.controllerStore.createController({
        controllerId: "controller_other_barn",
        barnId: "barn_controller_other",
        name: "Other Barn Controller",
        enabled: true,
        connectionState: "ONLINE",
        lastSeenAt: createdAt,
        createdAt
    }, ["feeder_controller_other"]);
    const command = commandFor(harness, "wrong-resource");
    const runtime = new SimulatedDeviceController({
        controllerId: other.controllerId,
        store: harness.devices.controllerStore,
        deviceCommandStore: harness.devices.deviceCommandStore,
        clock: harness.clockController.clock,
        sleep: async () => {},
        safetyService: harness.safety.emergencyStopService
    });
    await assert.rejects(
        runtime.receive(command, { emitAcknowledgement: () => {} }),
        error => error.code === "CONTROLLER_RESOURCE_NOT_AUTHORISED"
    );
    assert.equal(
        harness.devices.deviceCommandStore.getSimulatedExecution(command.commandId),
        null
    );
});

test("normal delivery records the complete acknowledgement lifecycle once", async t => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const command = commandFor(harness, "normal");
    const resolved = await harness.devices.worker.processCommand(command.commandId);
    assert.equal(resolved.status, "ACKNOWLEDGED");
    assert.deepEqual(
        harness.devices.deviceCommandStore
            .getAcknowledgementsForCommand(command.commandId)
            .map(item => item.result),
        ["ACCEPTED", "STARTED", "SUCCEEDED"]
    );
    const journal = harness.devices.controllerStore.getJournalForCommand(
        command.commandId
    );
    assert.equal(journal.executionState, "COMPLETED");
    assert.equal(journal.dispensePerformed, true);
    assert.deepEqual(
        harness.devices.controllerStore.getJournalHistory(journal.journalId)
            .map(item => item.toState),
        ["RECEIVED", "ACCEPTED", "STARTED", "COMPLETED"]
    );
    assert.equal(
        harness.devices.deviceCommandStore
            .getSimulatedExecution(command.commandId).actionCount,
        1
    );
});

test("duplicate command delivery and duplicate acknowledgements remain idempotent", async t => {
    const harness = await createHarness();
    t.after(() => harness.close());
    setBehaviour(harness, "DUPLICATE_ACKNOWLEDGEMENT");
    const command = commandFor(harness, "duplicates");
    await harness.devices.worker.processCommand(command.commandId);
    await harness.devices.deviceTransport.deliver(command);
    assert.equal(
        harness.devices.deviceCommandStore
            .getAcknowledgementsForCommand(command.commandId).length,
        3
    );
    assert.equal(
        harness.devices.deviceCommandStore
            .getSimulatedExecution(command.commandId).actionCount,
        1
    );
    const duplicateAudits = harness.devices.deviceCommandStore
        .getAuditRecords(command.commandId)
        .filter(item => item.action === "DUPLICATE_ACKNOWLEDGEMENT");
    assert.ok(duplicateAudits.length >= 4);
});

test("out-of-order acknowledgements are retained without regressing command state", async t => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const command = commandFor(harness, "out-of-order");
    await harness.devices.worker.processCommand(command.commandId);
    const lateAccepted = harness.devices.acknowledgementService.record({
        acknowledgementId: `late-accepted-${command.commandId}`,
        commandId: command.commandId,
        deviceId: command.deviceId,
        acknowledgementType: "DISPENSE_FEED_ACCEPTED",
        receivedAt: harness.clockController.clock().toISOString(),
        deviceTimestamp: harness.clockController.clock().toISOString(),
        result: "ACCEPTED",
        metadata: { simulated: true }
    });
    assert.equal(lateAccepted.outOfOrder, true);
    assert.equal(lateAccepted.command.status, "ACKNOWLEDGED");
});

test("rejection and pre-action failure never create a simulated dispense", async t => {
    for (const [mode, suffix] of [
        ["COMMAND_REJECTION", "reject"],
        ["FAIL_BEFORE_DISPENSE", "fail-before"]
    ]) {
        await t.test(mode, async () => {
            const harness = await createHarness();
            setBehaviour(harness, mode);
            const command = commandFor(harness, suffix);
            const resolved = await harness.devices.worker.processCommand(
                command.commandId
            );
            assert.equal(resolved.status, "FAILED");
            assert.equal(
                harness.devices.deviceCommandStore
                    .getSimulatedExecution(command.commandId),
                null
            );
            await harness.close();
        });
    }
});

test("disconnect and controller restart before dispense recover safely", async t => {
    const harness = await createHarness();
    t.after(() => harness.close());
    setBehaviour(harness, "DISCONNECT_DURING_EXECUTION");
    const command = commandFor(harness, "disconnect-restart");
    let result = await harness.devices.worker.processCommand(command.commandId);
    assert.equal(result.status, "RETRY_SCHEDULED");
    assert.equal(
        harness.devices.deviceCommandStore.getSimulatedExecution(command.commandId),
        null
    );
    harness.devices.controllerStore.setBehaviour(
        DEFAULT_SIMULATED_CONTROLLER_ID,
        { mode: "NORMAL" },
        harness.clockController.clock().toISOString()
    );
    harness.devices.deviceTransport.setConnectionState(
        DEFAULT_SIMULATED_CONTROLLER_ID,
        "ONLINE"
    );
    harness.devices.deviceTransport.restartController(
        DEFAULT_SIMULATED_CONTROLLER_ID
    );
    result = await harness.devices.worker.processCommand(command.commandId);
    assert.equal(result.status, "ACKNOWLEDGED");
    assert.equal(
        harness.devices.deviceCommandStore
            .getSimulatedExecution(command.commandId).actionCount,
        1
    );
});

test("disconnection before receipt leaves no execution and remains safely retryable", async t => {
    const harness = await createHarness();
    t.after(() => harness.close());
    setBehaviour(harness, "DISCONNECT_BEFORE_RECEIPT");
    const command = commandFor(harness, "disconnect-before-receipt");
    const result = await harness.devices.worker.processCommand(command.commandId);
    assert.equal(result.status, "RETRY_SCHEDULED");
    assert.equal(
        harness.devices.controllerStore.getJournalForCommand(command.commandId),
        null
    );
    assert.equal(
        harness.devices.deviceCommandStore.getSimulatedExecution(command.commandId),
        null
    );
});

test("post-dispense failures and controller restart escalate OUTCOME_UNKNOWN", async t => {
    for (const [mode, suffix] of [
        ["FAIL_AFTER_DISPENSE", "failure-after"],
        ["RESTART_DURING_EXECUTION", "restart-after"]
    ]) {
        await t.test(mode, async () => {
            const harness = await createHarness();
            setBehaviour(harness, mode);
            const command = commandFor(harness, suffix);
            const resolved = await harness.devices.worker.processCommand(
                command.commandId
            );
            assert.equal(resolved.status, "OUTCOME_UNKNOWN");
            assert.equal(
                harness.devices.deviceCommandStore
                    .getSimulatedExecution(command.commandId).actionCount,
                1
            );
            assert.equal(
                harness.devices.controllerStore
                    .getJournalForCommand(command.commandId).executionState,
                "OUTCOME_UNKNOWN"
            );
            assert.equal(
                harness.safety.store.getResolutionCaseByCommand(command.commandId)
                    .status,
                "OPEN"
            );
            await harness.close();
        });
    }
});

test("identity and malformed completion acknowledgements become uncertain", async t => {
    for (const mode of [
        "MALFORMED_ACKNOWLEDGEMENT",
        "WRONG_CONTROLLER_IDENTITY",
        "WRONG_FEEDER_IDENTITY"
    ]) {
        await t.test(mode, async () => {
            const harness = await createHarness();
            setBehaviour(harness, mode);
            const command = commandFor(harness, mode.toLowerCase());
            const result = await harness.devices.worker.processCommand(
                command.commandId
            );
            assert.equal(result.status, "OUTCOME_UNKNOWN");
            assert.equal(
                harness.devices.deviceCommandStore
                    .getSimulatedExecution(command.commandId).actionCount,
                1
            );
            await harness.close();
        });
    }
});

test("heartbeats derive ONLINE, STALE, OFFLINE and DISABLED without sleeping", async t => {
    const clockController = mutableClock();
    const harness = await createHarness({ clockController });
    t.after(() => harness.close());
    harness.devices.worker.startTransport();
    assert.equal(
        harness.devices.controllerStore.getController(
            DEFAULT_SIMULATED_CONTROLLER_ID
        ).status,
        "ONLINE"
    );
    setBehaviour(harness, "HEARTBEAT_LOSS");
    clockController.advance(3001);
    harness.devices.deviceTransport.heartbeatNow();
    assert.equal(
        harness.devices.controllerStore.getController(
            DEFAULT_SIMULATED_CONTROLLER_ID
        ).status,
        "STALE"
    );
    const staleCommand = commandFor(harness, "stale-heartbeat");
    assert.equal(
        (await harness.devices.worker.processCommand(staleCommand.commandId)).status,
        "RETRY_SCHEDULED"
    );
    assert.equal(
        harness.devices.deviceCommandStore
            .getSimulatedExecution(staleCommand.commandId),
        null
    );
    harness.devices.controllerStore.setConnectionState(
        DEFAULT_SIMULATED_CONTROLLER_ID,
        "OFFLINE",
        clockController.clock().toISOString()
    );
    assert.equal(
        harness.devices.controllerStore.getController(
            DEFAULT_SIMULATED_CONTROLLER_ID
        ).status,
        "OFFLINE"
    );
    harness.devices.controllerStore.setEnabled(
        DEFAULT_SIMULATED_CONTROLLER_ID,
        false,
        clockController.clock().toISOString()
    );
    assert.equal(
        harness.devices.controllerStore.getController(
            DEFAULT_SIMULATED_CONTROLLER_ID
        ).status,
        "DISABLED"
    );
    const disabledCommand = commandFor(harness, "disabled-controller");
    assert.equal(
        (await harness.devices.worker.processCommand(disabledCommand.commandId)).status,
        "RETRY_SCHEDULED"
    );
    assert.equal(
        harness.devices.deviceCommandStore
            .getSimulatedExecution(disabledCommand.commandId),
        null
    );
});

test("emergency stops prevent controller execution and retain safety authority", async t => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const command = commandFor(harness, "emergency-stop");
    const welfareId = "administrator_development_welfare_operator";
    harness.safety.emergencyStopService.activate({
        level: "FEEDER",
        barnId: command.barnId,
        feederId: command.feederId,
        reason: "Controller safety test"
    }, administratorContext(
        harness,
        welfareId,
        "WELFARE_OPERATOR",
        "Controller safety test"
    ));
    harness.devices.worker.startTransport();
    await assert.rejects(
        harness.devices.deviceTransport.deliver(command),
        error => error.code === "FEEDER_SAFETY_BLOCKED"
    );
    assert.equal(
        harness.devices.deviceCommandStore.getSimulatedExecution(command.commandId),
        null
    );
});

test("server restart recovers acknowledgement loss without duplicate action", async t => {
    const databasePath = temporaryDatabase(t);
    const first = await createHarness({ databasePath });
    setBehaviour(first, "ACKNOWLEDGEMENT_LOSS");
    const command = commandFor(first, "server-restart");
    await first.devices.worker.processCommand(command.commandId);
    assert.equal(
        first.devices.deviceCommandStore.getCommand(command.commandId).status,
        "SENT"
    );
    await first.close();

    const second = await createHarness({ databasePath });
    second.devices.worker.start();
    await waitUntil(() => second.devices.deviceCommandStore
        .getCommand(command.commandId).status === "ACKNOWLEDGED");
    assert.equal(
        second.devices.deviceCommandStore
            .getSimulatedExecution(command.commandId).actionCount,
        1
    );
    assert.equal(
        second.devices.controllerStore
            .getJournalForCommand(command.commandId).executionState,
        "COMPLETED"
    );
    await second.close();
});

test("administrator controller APIs enforce authentication, scope and auditing", async t => {
    const harness = await createHarness();
    t.after(() => harness.close());
    const path = `/api/admin/device-controllers/${DEFAULT_SIMULATED_CONTROLLER_ID}`;
    assert.equal((await request(harness.app).get(path)).status, 401);
    assert.equal((await request(harness.app)
        .get(`/api/admin/device-controllers?barnId=${DEFAULT_RESOURCE_IDS.barnId}`)
        .set("authorization", AUTH.viewer)).status, 200);
    assert.equal((await request(harness.app)
        .post(`${path}/status`)
        .set("authorization", AUTH.viewer)
        .send({ enabled: false, reason: "Viewer denied" })).status, 403);
    const disabled = await request(harness.app)
        .post(`${path}/status`)
        .set("authorization", AUTH.hardware)
        .send({ enabled: false, reason: "Maintenance simulation" });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.controller.status, "DISABLED");
    const configured = await request(harness.app)
        .post(`${path}/simulation-behaviour`)
        .set("authorization", AUTH.hardware)
        .send({
            reason: "Deterministic validation",
            behaviour: { mode: "COMMAND_REJECTION" }
        });
    assert.equal(configured.status, 200);
    const actions = harness.administrators.store.getAuditRecords({ limit: 100 })
        .map(record => record.action);
    assert.ok(actions.includes("SIMULATED_CONTROLLER_DISABLED"));
    assert.ok(actions.includes("SIMULATED_CONTROLLER_BEHAVIOUR_CONFIGURED"));
});

test("production configuration disables simulation behaviour changes", async t => {
    const harness = await createHarness({
        config: { enableSimulatedControllerConfiguration: false }
    });
    t.after(() => harness.close());
    const response = await request(harness.app)
        .post(
            `/api/admin/device-controllers/${DEFAULT_SIMULATED_CONTROLLER_ID}`
            + "/simulation-behaviour"
        )
        .set("authorization", AUTH.admin)
        .send({ reason: "Must be denied", behaviour: { mode: "NORMAL" } });
    assert.equal(response.status, 403);
    assert.equal(
        response.body.error.code,
        "SIMULATED_CONTROLLER_CONFIGURATION_DISABLED"
    );
});

test("migration 8 upgrades schema 7 and seeds the default controller", t => {
    const databasePath = temporaryDatabase(t);
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("PRAGMA foreign_keys = ON;");
    EVENT_STORE_MIGRATIONS.filter(migration => migration.version < 8)
        .forEach(migration => {
            if (migration.requiresForeignKeysDisabled) {
                legacy.exec("PRAGMA foreign_keys = OFF;");
            }
            legacy.exec("BEGIN IMMEDIATE;");
            migration.up(legacy);
            legacy.exec(`PRAGMA user_version = ${migration.version};`);
            legacy.exec("COMMIT;");
            if (migration.requiresForeignKeysDisabled) {
                legacy.exec("PRAGMA foreign_keys = ON;");
            }
        });
    legacy.close();

    const store = new SqliteEventStore({
        databasePath,
        logger: createTestLogger()
    });
    assert.equal(store.getSchemaVersion(), EVENT_STORE_SCHEMA_VERSION);
    assert.ok(store.getTableNames().includes("SimulatedControllers"));
    assert.equal(
        store.database.prepare(`
            SELECT COUNT(*) AS count
            FROM SimulatedControllers
            WHERE controllerId = ?
        `).get(DEFAULT_SIMULATED_CONTROLLER_ID).count,
        1
    );
    store.close();
});
