import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    BarnEdgeController,
    DEFAULT_EDGE_WELFARE_CONFIGURATION,
    SimulatedHardwareAdapter,
    SqliteEdgeStore,
    loadEdgeConfig
} from "../src/edge-controller/index.js";

const BASE_TIME = Date.parse("2026-07-20T12:00:00.000Z");

function createHarness(t, {
    databasePath = ":memory:",
    scenario = {},
    welfare = {},
    calibration = {},
    config = {},
    installWelfare = true,
    installCalibration = true,
    clockState = { value: BASE_TIME }
} = {}) {
    const clock = () => new Date(clockState.value);
    const edgeConfig = {
        mode: "test",
        controllerId: "edge-controller-test",
        barnId: "barn-test",
        feederIds: ["feeder-test"],
        bellDurationMs: 0,
        countdownDurationMs: 0,
        watchdogPulseMs: 10,
        maintenanceMaximumJogMs: 50,
        bellFailurePolicy: "CANCEL",
        ...config
    };
    const store = new SqliteEdgeStore({
        databasePath,
        controllerId: edgeConfig.controllerId,
        clock
    });
    if (installWelfare) {
        store.installWelfareConfiguration({
            ...DEFAULT_EDGE_WELFARE_CONFIGURATION,
            ...welfare,
            version: welfare.version || "edge-welfare-v1"
        }, {
            createdAt: new Date(BASE_TIME - 1000).toISOString(),
            expiresAt: new Date(BASE_TIME + 86_400_000).toISOString()
        });
    }
    if (installCalibration) {
        store.installCalibration({
            calibrationId: "calibration-test-v1",
            feederId: "feeder-test",
            version: "simulated-calibration-v1",
            feedType: "simulated-test-batch",
            testCount: 3,
            commandedDurationMs: 20,
            measuredOutputValues: [1, 1, 1],
            average: 1,
            variance: 0,
            tolerance: 0.25,
            hopperFillConditions: "SIMULATED_FULL",
            createdAt: new Date(BASE_TIME - 1000).toISOString(),
            expiresAt: new Date(BASE_TIME + 86_400_000).toISOString(),
            approved: true,
            approvingOperatorIdentity: "test-local-operator",
            notes: "Explicit simulator fixture; not a physical calibration.",
            simulated: true,
            ...calibration
        });
    }
    const hardware = new SimulatedHardwareAdapter({ clock, scenario });
    const edge = new BarnEdgeController({
        config: edgeConfig,
        store,
        hardware,
        clock,
        sleep: async milliseconds => { clockState.value += milliseconds; }
    });
    edge.setNetworkConnected(true);
    installAuthority(store, edgeConfig, clock());
    t?.after?.(() => {
        try { edge.shutdown(); } catch {}
        try { store.close(); } catch {}
    });
    return { edge, store, hardware, config: edgeConfig, clock, clockState };
}

function installAuthority(store, config, now) {
    const expiry = new Date(now.getTime() + 60_000).toISOString();
    store.saveAssignment({
        feederId: "feeder-test",
        controllerId: config.controllerId,
        barnId: config.barnId,
        assignmentGeneration: 3,
        authorityLeaseExpiresAt: expiry,
        enabled: true
    });
    for (const state of [
        { scopeKey: "PLATFORM", level: "PLATFORM" },
        { scopeKey: `BARN:${config.barnId}`, level: "BARN", barnId: config.barnId },
        { scopeKey: "FEEDER:feeder-test", level: "FEEDER", feederId: "feeder-test" }
    ]) {
        store.saveSafetyState({
            ...state,
            generation: 1,
            active: false,
            expiresAt: expiry
        });
    }
}

let commandSequence = 0;
function command(harness, {
    action = "DISPENSE_FEED",
    eventId = null,
    commandId = null,
    fencingToken = null,
    parameters = {},
    expiresAt = null,
    authorityLeaseExpiresAt = null,
    assignmentGeneration = 3,
    controllerId = null,
    feederId = "feeder-test"
} = {}) {
    commandSequence += 1;
    const id = commandId || `edge-command-${commandSequence}`;
    return {
        protocolVersion: "1.0",
        messageType: "DEVICE_COMMAND",
        commandId: id,
        deliveryId: `delivery-${id}`,
        eventId: eventId || `event-${commandSequence}`,
        controllerId: controllerId || harness.config.controllerId,
        barnId: harness.config.barnId,
        feederId,
        deviceId: "device-test",
        assignmentGeneration,
        fencingToken: fencingToken || commandSequence,
        authorityLeaseExpiresAt: authorityLeaseExpiresAt
            || new Date(harness.clock().getTime() + 60_000).toISOString(),
        expiresAt: expiresAt || new Date(harness.clock().getTime() + 60_000).toISOString(),
        action,
        parameters: action === "RING_BELL" ? {
            pattern: "STANDARD_FEED_BELL",
            welfareConfigurationVersion: "edge-welfare-v1",
            ...parameters
        } : {
            quantity: 1,
            unit: "FEED_PORTION",
            calibrationVersion: "simulated-calibration-v1",
            welfareConfigurationVersion: "edge-welfare-v1",
            ...parameters
        }
    };
}

test("independent edge schema has no backend Event Store dependency", t => {
    const harness = createHarness(t);
    const tables = harness.store.database.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
    `).all().map(row => row.name);
    assert.equal(tables.includes("Events"), false);
    assert.equal(tables.includes("DeviceCommands"), false);
    assert.equal(tables.includes("EdgeCommands"), true);
    assert.equal(tables.includes("EdgeFeedCycles"), true);
    assert.equal(harness.store.database.prepare("PRAGMA user_version").get().user_version, 1);
});

test("one Event reservation binds one bell and one dispense without replay", async t => {
    const harness = createHarness(t);
    const eventId = "event-one-reserved-cycle";
    const bell = command(harness, { action: "RING_BELL", eventId, fencingToken: 1 });
    const dispense = command(harness, { eventId, fencingToken: 2 });

    assert.equal((await harness.edge.handleCommand(bell)).state, "COMPLETED");
    const first = await harness.edge.handleCommand(dispense);
    assert.equal(first.state, "COMPLETED");
    assert.equal(harness.store.recentCycles().length, 1);
    assert.equal(harness.store.getCycle(first.cycleId).bellCommandId, bell.commandId);
    assert.equal(harness.store.getCycle(first.cycleId).dispenseCommandId, dispense.commandId);
    assert.equal(harness.hardware.evidence.filter(item => item.type === "BELL_ON").length, 1);

    const duplicate = await harness.edge.handleCommand(dispense);
    assert.equal(duplicate.state, "COMPLETED");
    assert.equal(harness.hardware.evidence.filter(item => item.type === "BELL_ON").length, 1);
    assert.equal(harness.hardware.evidence.filter(item => (
        item.type === "AUGER_REQUEST_CHANGED" && item.details.active
    )).length, 1);
    assert.deepEqual(harness.hardware.getOutputs(), {
        bell: false,
        motorAuthorityRequest: false,
        augerRunRequest: false,
        warningIndicator: false,
        maintenanceModeIndicator: false
    });
});

test("signed-command authority conditions fail closed before STARTED", async t => {
    const cases = [
        ["expired command", { expiresAt: new Date(BASE_TIME - 1).toISOString() },
            "MQTT_COMMAND_EXPIRED"],
        ["expired lease", {
            authorityLeaseExpiresAt: new Date(BASE_TIME - 1).toISOString()
        }, "MQTT_AUTHORITY_LEASE_EXPIRED"],
        ["old generation", { assignmentGeneration: 2 }, "EDGE_ASSIGNMENT_INVALID"],
        ["wrong controller", { controllerId: "wrong-controller" },
            "EDGE_COMMAND_IDENTITY_MISMATCH"],
        ["wrong feeder", { feederId: "wrong-feeder" },
            "EDGE_COMMAND_IDENTITY_MISMATCH"]
    ];
    for (const [name, override, code] of cases) {
        await t.test(name, async () => {
            const harness = createHarness(null);
            try {
                const result = await harness.edge.handleCommand(command(harness, override));
                assert.equal(result.state, "REJECTED");
                assert.equal(result.acknowledgement.errorCode, code);
                assert.equal(harness.store.getCommand(result.commandId).startedAt, null);
            } finally {
                harness.edge.shutdown();
                harness.store.close();
            }
        });
    }
});

test("software, electrical and readiness stops prevent all outputs", async t => {
    const cases = [
        ["platform stop", "NORMAL", store => store.saveSafetyState({
            scopeKey: "PLATFORM", level: "PLATFORM", generation: 2, active: true,
            reason: "test", expiresAt: new Date(BASE_TIME + 60_000).toISOString()
        }), "MQTT_EMERGENCY_STOP_ACTIVE"],
        ["electrical stop", "ELECTRICAL_EMERGENCY_STOP_OPEN", () => {},
            "ELECTRICAL_EMERGENCY_STOP_OPEN"],
        ["empty hopper", "EMPTY_HOPPER", () => {}, "HOPPER_EMPTY"],
        ["blocked outlet", "BLOCKED_OUTLET", () => {}, "OUTLET_BLOCKED"],
        ["safety controller unavailable", "SAFETY_CONTROLLER_UNAVAILABLE", () => {},
            "EDGE_SENSOR_NOT_READY"]
    ];
    for (const [name, mode, setup, code] of cases) {
        await t.test(name, async () => {
            const harness = createHarness(null, { scenario: { mode } });
            try {
                setup(harness.store);
                const result = await harness.edge.handleCommand(command(harness));
                assert.equal(result.state, "REJECTED");
                assert.equal(result.acknowledgement.errorCode, code);
                assert.equal(harness.hardware.getOutputs().augerRunRequest, false);
            } finally {
                harness.edge.shutdown();
                harness.store.close();
            }
        });
    }
});

test("deterministic sensor evidence classifies known failure and uncertainty", async t => {
    const cases = [
        ["NORMAL", "COMPLETED", "COMPLETED"],
        ["MOTOR_FAILS_TO_START", "FAILED", "FAILED"],
        ["CURRENT_NO_SHAFT", "OUTCOME_UNKNOWN", "OPERATOR_LOCKOUT"],
        ["SHAFT_NO_FLOW", "OUTCOME_UNKNOWN", "OPERATOR_LOCKOUT"],
        ["FEED_FLOW_WITHOUT_MOTOR", "OUTCOME_UNKNOWN", "OPERATOR_LOCKOUT"],
        ["MISSING_EVIDENCE", "OUTCOME_UNKNOWN", "OUTCOME_UNKNOWN"],
        ["CONTRADICTORY_EVIDENCE", "OUTCOME_UNKNOWN", "OPERATOR_LOCKOUT"],
        ["CONTACTOR_DISAGREEMENT", "OUTCOME_UNKNOWN", "OPERATOR_LOCKOUT"],
        ["STUCK_OUTPUT", "OUTCOME_UNKNOWN", "OPERATOR_LOCKOUT"],
        ["EXCESSIVE_WEIGHT", "OUTCOME_UNKNOWN", "OPERATOR_LOCKOUT"],
        ["INSUFFICIENT_WEIGHT", "OUTCOME_UNKNOWN", "OUTCOME_UNKNOWN"]
    ];
    for (const [mode, commandState, cycleState] of cases) {
        await t.test(mode, async () => {
            const harness = createHarness(null, { scenario: { mode, quantity: 1 } });
            try {
                const result = await harness.edge.handleCommand(command(harness));
                assert.equal(result.state, commandState);
                const cycle = harness.store.getCycle(result.cycleId);
                assert.equal(cycle.state, cycleState);
                assert.equal(cycle.sensorEvidence.evidenceVersion, "1.0");
                assert.equal(cycle.sensorEvidence.calibrationVersion,
                    "simulated-calibration-v1");
                assert.equal(harness.hardware.getOutputs().motorAuthorityRequest, false);
            } finally {
                harness.edge.shutdown();
                harness.store.close();
            }
        });
    }
});

test("safety-controller refusal is known failure while watchdog loss locks out", async t => {
    for (const [behaviour, expected] of [
        ["REFUSE_ENABLE", "FAILED"],
        ["WATCHDOG_EXPIRY", "OUTCOME_UNKNOWN"],
        ["REBOOT_DURING_ACTION", "OUTCOME_UNKNOWN"],
        ["DUPLICATE_TOKEN", "FAILED"]
    ]) {
        await t.test(behaviour, async () => {
            const harness = createHarness(null);
            try {
                harness.edge.safetyController.setBehaviour(behaviour);
                const result = await harness.edge.handleCommand(command(harness));
                assert.equal(result.state, expected);
                assert.equal(harness.hardware.getOutputs().motorAuthorityRequest, false);
                assert.equal(harness.hardware.getOutputs().augerRunRequest, false);
            } finally {
                harness.edge.shutdown();
                harness.store.close();
            }
        });
    }
});

test("calibration and welfare versions are mandatory and production rejects simulation", async t => {
    const absent = createHarness(null, { installCalibration: false });
    try {
        const result = await absent.edge.handleCommand(command(absent));
        assert.equal(result.state, "REJECTED");
        assert.equal(result.acknowledgement.errorCode, "EDGE_CALIBRATION_STALE");
    } finally {
        absent.edge.shutdown();
        absent.store.close();
    }

    const mismatch = createHarness(null);
    try {
        const result = await mismatch.edge.handleCommand(command(mismatch, {
            parameters: { welfareConfigurationVersion: "old-welfare" }
        }));
        assert.equal(result.acknowledgement.errorCode, "EDGE_WELFARE_VERSION_MISMATCH");
    } finally {
        mismatch.edge.shutdown();
        mismatch.store.close();
    }

    const production = createHarness(t, { config: { mode: "production" } });
    const productionResult = await production.edge.handleCommand(command(production));
    assert.equal(productionResult.acknowledgement.errorCode,
        "EDGE_SIMULATED_CALIBRATION_REJECTED");
});

test("local welfare settings cannot be weaker than supplied server limits", t => {
    const harness = createHarness(t);
    assert.throws(() => harness.store.installWelfareConfiguration({
        ...DEFAULT_EDGE_WELFARE_CONFIGURATION,
        version: "weaker-v2",
        maximumMotorDurationMs: 3000
    }, {
        createdAt: new Date(BASE_TIME).toISOString(),
        expiresAt: new Date(BASE_TIME + 60_000).toISOString(),
        serverLimits: { maximumMotorDurationMs: 2000 }
    }), { code: "LOCAL_WELFARE_LIMIT_WEAKER" });
});

test("session, rolling, quantity and minimum-interval welfare limits persist", async t => {
    const temp = mkdtempSync(join(tmpdir(), "alpacaly-edge-welfare-"));
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const databasePath = join(temp, "edge.sqlite");
    const harness = createHarness(t, {
        databasePath,
        welfare: {
            maximumCyclesPerSession: 1,
            maximumCyclesPerRollingPeriod: 1,
            maximumQuantityPerSession: 1,
            minimumIntervalMs: 60_000
        }
    });
    assert.equal((await harness.edge.handleCommand(command(harness))).state, "COMPLETED");
    const second = await harness.edge.handleCommand(command(harness));
    assert.equal(second.state, "REJECTED");
    assert.match(second.acknowledgement.errorCode, /LIMIT|INTERVAL/);
    assert.equal(harness.store.getWelfareHistory("feeder-test",
        new Date(BASE_TIME - 1000).toISOString()).length, 1);
});

test("maintenance requires local presence, blocks remote feed and audits hold-to-run actions", async t => {
    const harness = createHarness(t);
    assert.throws(() => harness.edge.enterMaintenance({}), {
        code: "MAINTENANCE_LOCAL_PRESENCE_REQUIRED"
    });
    const maintenance = harness.edge.enterMaintenance({
        localPresenceEvidence: "simulated-key-switch-and-button",
        operatorIdentity: "onsite-test-operator",
        durationMs: 1000
    });
    assert.equal(maintenance.state, "MAINTENANCE");
    const remote = await harness.edge.handleCommand(command(harness));
    assert.equal(remote.state, "REJECTED");
    assert.equal(remote.acknowledgement.errorCode, "EDGE_MAINTENANCE_MODE_ACTIVE");
    await assert.rejects(harness.edge.runMaintenanceAction({
        action: "SHORT_AUGER_JOG",
        feederId: "feeder-test",
        operatorIdentity: "onsite-test-operator",
        localHoldActive: false
    }), { code: "MAINTENANCE_HOLD_TO_RUN_REQUIRED" });
    const jog = await harness.edge.runMaintenanceAction({
        action: "SHORT_AUGER_JOG",
        feederId: "feeder-test",
        operatorIdentity: "onsite-test-operator",
        localHoldActive: true,
        durationMs: 500
    });
    assert.equal(jog.completed, true);
    assert.equal(harness.hardware.getOutputs().augerRunRequest, false);
    assert.equal(harness.store.getAuditRecords().some(item => (
        item.action === "MAINTENANCE_SHORT_AUGER_JOG"
    )), true);
    assert.equal(harness.edge.exitMaintenance({
        operatorIdentity: "onsite-test-operator",
        localPresenceEvidence: "simulated-key-switch-and-button"
    }).state, "NORMAL");
});

test("bell failure defaults to cancellation before STARTED and duplicate never rerings", async t => {
    const harness = createHarness(t, { scenario: { mode: "BELL_FAILURE" } });
    const bell = command(harness, { action: "RING_BELL" });
    const result = await harness.edge.handleCommand(bell);
    assert.equal(result.state, "FAILED");
    assert.equal(harness.store.getCommand(bell.commandId).startedAt, null);
    await harness.edge.handleCommand(bell);
    assert.equal(harness.hardware.evidence.filter(item => item.type === "BELL_FAILED").length, 1);
});

test("local countdown cancellation is durable and never reaches STARTED", async t => {
    const harness = createHarness(t);
    const input = command(harness);
    const result = await harness.edge.handleCommand(input, {
        onStage: stage => {
            if (stage === "COUNTDOWN") harness.edge.cancelCountdown("onsite cancellation");
        }
    });
    assert.equal(result.state, "CANCELLED");
    assert.equal(harness.store.getCommand(input.commandId).startedAt, null);
    assert.equal(harness.hardware.evidence.some(item => (
        item.type === "AUGER_REQUEST_CHANGED" && item.details.active
    )), false);
});

test("restart recovery cancels pre-STARTED work and marks post-STARTED uncertainty", async t => {
    const stages = [
        ["RECEIVED", "CANCELLED"],
        ["ACCEPTED", "CANCELLED"],
        ["BELL_ACTIVE", "CANCELLED"],
        ["COUNTDOWN", "CANCELLED"],
        ["FINAL_CHECK", "CANCELLED"],
        ["STARTED", "OUTCOME_UNKNOWN"],
        ["DISPENSING", "OUTCOME_UNKNOWN"],
        ["EVIDENCE_COLLECTION", "OUTCOME_UNKNOWN"]
    ];
    for (const [stage, expected] of stages) {
        await t.test(stage, async () => {
            const harness = createHarness(null);
            const input = command(harness);
            try {
                await assert.rejects(harness.edge.handleCommand(input, {
                    onStage: current => {
                        if (current === stage) {
                            throw Object.assign(new Error("simulated restart"), {
                                code: "SIMULATED_PROCESS_RESTART"
                            });
                        }
                    }
                }), { code: "SIMULATED_PROCESS_RESTART" });
                const restartedHardware = new SimulatedHardwareAdapter({ clock: harness.clock });
                const restarted = new BarnEdgeController({
                    config: harness.config,
                    store: harness.store,
                    hardware: restartedHardware,
                    clock: harness.clock,
                    sleep: async () => {}
                });
                assert.equal(harness.store.getCommand(input.commandId).state, expected);
                assert.equal(restartedHardware.getOutputs().augerRunRequest, false);
                assert.equal(restarted.boot.bootCounter, 2);
                restarted.shutdown();
            } finally {
                harness.edge.shutdown();
                harness.store.close();
            }
        });
    }
});

test("durable completed evidence reconciles after restart without another action", async t => {
    const harness = createHarness(t);
    const input = command(harness);
    await assert.rejects(harness.edge.handleCommand(input, {
        onStage: stage => {
            if (stage === "EVIDENCE_PERSISTED") {
                throw Object.assign(new Error("simulated restart after evidence"), {
                    code: "SIMULATED_PROCESS_RESTART"
                });
            }
        }
    }), { code: "SIMULATED_PROCESS_RESTART" });
    const performed = harness.hardware.evidence.filter(item => (
        item.type === "AUGER_REQUEST_CHANGED" && item.details.active
    )).length;
    const restarted = new BarnEdgeController({
        config: harness.config,
        store: harness.store,
        hardware: new SimulatedHardwareAdapter({ clock: harness.clock }),
        clock: harness.clock,
        sleep: async () => {}
    });
    assert.equal(harness.store.getCommand(input.commandId).state, "COMPLETED");
    assert.equal(harness.store.getCommand(input.commandId)
        .finalAcknowledgement.details.recoveredFromDurableEvidence, true);
    assert.equal(performed, 1);
    restarted.shutdown();
});

test("network loss blocks a new STARTED transition but not a bounded action already STARTED", async t => {
    const before = createHarness(null);
    try {
        const blocked = await before.edge.handleCommand(command(before), {
            onStage: stage => {
                if (stage === "COUNTDOWN") before.edge.setNetworkConnected(false);
            }
        });
        assert.equal(blocked.state, "REJECTED");
        assert.equal(blocked.acknowledgement.errorCode, "EDGE_NETWORK_STATE_UNVERIFIED");
    } finally {
        before.edge.shutdown();
        before.store.close();
    }

    const after = createHarness(t);
    const completed = await after.edge.handleCommand(command(after), {
        onStage: stage => {
            if (stage === "STARTED") after.edge.setNetworkConnected(false);
        }
    });
    assert.equal(completed.state, "COMPLETED");
    assert.equal(after.hardware.getOutputs().motorAuthorityRequest, false);
});

test("lost final acknowledgement is durable and reconciles on duplicate delivery", async t => {
    const harness = createHarness(t);
    const input = command(harness);
    let fail = true;
    const publish = async status => {
        if (fail && status === "COMPLETED") throw new Error("network lost");
    };
    const result = await harness.edge.handleCommand(input, {
        emitAcknowledgement: publish
    });
    assert.equal(result.state, "COMPLETED");
    assert.equal(harness.store.getCommand(input.commandId).acknowledgementDeliveryStatus, "LOST");
    const actions = harness.hardware.evidence.filter(item => (
        item.type === "AUGER_REQUEST_CHANGED" && item.details.active
    )).length;
    fail = false;
    await harness.edge.handleCommand(input, { emitAcknowledgement: publish });
    assert.equal(harness.store.getCommand(input.commandId).acknowledgementDeliveryStatus,
        "DELIVERED");
    assert.equal(harness.hardware.evidence.filter(item => (
        item.type === "AUGER_REQUEST_CHANGED" && item.details.active
    )).length, actions);
});

test("production edge configuration rejects every development fallback", () => {
    assert.throws(() => loadEdgeConfig({
        EDGE_MODE: "production",
        MQTT_BROKER_URL: "mqtt://broker.example",
        MQTT_PROTOCOL_VERSION: "4",
        EDGE_SIMULATED_HARDWARE: "true",
        EDGE_DEVELOPMENT_IDENTITY: "true",
        MQTT_DEVELOPMENT_KEYS: "true"
    }), /Production edge/);
    assert.throws(() => loadEdgeConfig({
        EDGE_MODE: "production",
        MQTT_BROKER_URL: "mqtts://broker.example",
        MQTT_PROTOCOL_VERSION: "5",
        EDGE_SIMULATED_HARDWARE: "false",
        EDGE_DEVELOPMENT_IDENTITY: "false",
        MQTT_DEVELOPMENT_KEYS: "false"
    }), /security settings are missing/);
});

test("corrupted local journal is rejected instead of recreated or ignored", t => {
    const temp = mkdtempSync(join(tmpdir(), "alpacaly-edge-corrupt-"));
    t.after(() => rmSync(temp, { recursive: true, force: true }));
    const databasePath = join(temp, "edge.sqlite");
    writeFileSync(databasePath, "this is intentionally not a SQLite journal");
    assert.throws(() => new SqliteEdgeStore({
        databasePath,
        controllerId: "edge-controller-test"
    }), { code: "EDGE_JOURNAL_CORRUPT" });
});
