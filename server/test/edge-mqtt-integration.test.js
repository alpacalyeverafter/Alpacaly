import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import aedes from "aedes";
import request from "supertest";

import { createApp } from "../src/app.js";
import {
    DEFAULT_EDGE_WELFARE_CONFIGURATION,
    SecureMqttEdgeProcess,
    SimulatedHardwareAdapter,
    SqliteEdgeStore
} from "../src/edge-controller/index.js";
import { DEFAULT_SIMULATED_CONTROLLER_ID } from
    "../src/domain/device-controllers.js";
import { DEFAULT_RESOURCE_IDS } from "../src/domain/resources.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import { createTestLogger, testConfig } from "./helpers.js";

function waitFor(predicate, timeoutMs = 4000, label = "edge MQTT state") {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const check = () => {
            try {
                const value = predicate();
                if (value) return resolve(value);
            } catch (error) {
                reject(error);
                return;
            }
            if (Date.now() - startedAt >= timeoutMs) {
                reject(new Error(`Timed out waiting for ${label}.`));
                return;
            }
            setTimeout(check, 10);
        };
        check();
    });
}

async function embeddedBroker() {
    const broker = await aedes();
    const sockets = new Set();
    const server = createServer(broker.handle);
    server.on("connection", socket => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    return {
        url: `mqtt://127.0.0.1:${server.address().port}`,
        async close() {
            sockets.forEach(socket => socket.destroy());
            if (server.listening) await new Promise(resolve => server.close(resolve));
            await new Promise(resolve => broker.close(resolve));
        }
    };
}

async function createHarness(t) {
    const broker = await embeddedBroker();
    const logger = createTestLogger();
    const config = {
        ...testConfig,
        deviceTransport: "mqtt",
        enableSimulatedControllerConfiguration: false,
        mqttEnvironment: "test",
        mqttProtocolVersion: 4,
        mqttBrokerUrl: broker.url,
        mqttClientId: `alpacaly-edge-server-${Date.now()}`,
        mqttConnectTimeoutMs: 500,
        mqttReconnectPeriodMs: 25,
        mqttCommandQos: 1,
        mqttCommandExpiryMs: 1500,
        mqttAuthorityLeaseMs: 2500,
        mqttHeartbeatIntervalMs: 25,
        mqttStaleThresholdMs: 250,
        mqttOfflineThresholdMs: 500,
        mqttClockDriftToleranceMs: 1000,
        mqttDevelopmentKeys: true,
        edgeCalibrationVersion: "simulated-calibration-v1",
        edgeWelfareConfigurationVersion: "edge-welfare-v1",
        deviceCommandPollIntervalMs: 10,
        deviceAcknowledgementTimeoutMs: 1000
    };
    const eventEngine = new EventEngine({
        config,
        logger,
        autoProcess: false,
        sleep: async () => {}
    });
    const app = createApp({ config, logger, eventEngine });
    const edgeConfig = {
        mode: "test",
        controllerId: DEFAULT_SIMULATED_CONTROLLER_ID,
        barnId: DEFAULT_RESOURCE_IDS.barnId,
        feederIds: [DEFAULT_RESOURCE_IDS.feederId],
        databasePath: ":memory:",
        simulatedHardware: true,
        developmentIdentity: true,
        mqttDevelopmentKeys: true,
        mqttEnvironment: "test",
        mqttProtocolVersion: 4,
        mqttBrokerUrl: broker.url,
        mqttClientId: `alpacaly-independent-edge-${Date.now()}`,
        mqttConnectTimeoutMs: 500,
        mqttReconnectPeriodMs: 25,
        mqttHeartbeatIntervalMs: 25,
        mqttStaleThresholdMs: 250,
        mqttOfflineThresholdMs: 500,
        mqttClockDriftToleranceMs: 1000,
        mqttTlsCaPath: null,
        mqttTlsCertificatePath: null,
        mqttTlsPrivateKeyPath: null,
        mqttServerSigningPublicKeys: {},
        mqttControllerSigningKeyId: null,
        mqttControllerSigningPrivateKey: null,
        bellDurationMs: 0,
        countdownDurationMs: 0,
        watchdogPulseMs: 10,
        maintenanceMaximumJogMs: 50,
        bellFailurePolicy: "CANCEL"
    };
    const edgeStore = new SqliteEdgeStore({
        databasePath: ":memory:",
        controllerId: edgeConfig.controllerId
    });
    const now = new Date();
    edgeStore.installWelfareConfiguration(DEFAULT_EDGE_WELFARE_CONFIGURATION, {
        createdAt: new Date(now.getTime() - 1000).toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString()
    });
    edgeStore.installCalibration({
        calibrationId: "mqtt-edge-simulated-calibration",
        feederId: DEFAULT_RESOURCE_IDS.feederId,
        version: "simulated-calibration-v1",
        feedType: "mqtt-test-fixture",
        testCount: 3,
        commandedDurationMs: 10,
        measuredOutputValues: [1, 1, 1],
        average: 1,
        variance: 0,
        tolerance: 0.25,
        hopperFillConditions: "SIMULATED_FULL",
        createdAt: new Date(now.getTime() - 1000).toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        approved: true,
        approvingOperatorIdentity: "mqtt-test-operator",
        notes: "Simulator fixture only.",
        simulated: true
    });
    const hardware = new SimulatedHardwareAdapter();
    const edgeProcess = new SecureMqttEdgeProcess({
        config: edgeConfig,
        store: edgeStore,
        hardware,
        sleep: async () => {},
        logger
    });
    edgeProcess.start();
    t.after(async () => {
        await edgeProcess.shutdown();
        edgeStore.close();
        app.locals.contributionLedgerServices.outboxWorker.stop();
        await app.locals.deviceCommandServices.worker.stop();
        if (!eventEngine.eventStore.closed) await eventEngine.shutdown();
        await broker.close();
    });
    await waitFor(() => (
        edgeProcess.connected
        && edgeProcess.assignmentEnvelope
        && edgeStore.getSafetyStates().length === 3
        && app.locals.deviceCommandServices.controllerStore
            .getEdgeStatus(DEFAULT_SIMULATED_CONTROLLER_ID)
    ));
    return { app, config, edgeProcess, edgeStore, hardware, eventEngine };
}

function createFeedRequest(harness) {
    return harness.app.locals.contributionLedgerServices
        .developmentWebsiteContributionService.simulate({
            supporterName: "Independent edge MQTT test",
            clientRequestId: `edge-mqtt-${Date.now()}`
        }).feedRequest;
}

test("separate edge process completes the signed MQTT bell-to-dispense lifecycle", async t => {
    const harness = await createHarness(t);
    const services = harness.app.locals.deviceCommandServices;
    const feedRequest = createFeedRequest(harness);
    const bell = services.deviceCommandService.ensureCommandForEvent(
        feedRequest,
        "RING_BELL"
    ).command;
    await services.worker.processCommand(bell.commandId);
    await waitFor(() => services.deviceCommandStore.getCommand(bell.commandId).status
        === "ACKNOWLEDGED", 4000, "bell acknowledgement");

    const dispense = services.deviceCommandService.ensureCommandForEvent(
        feedRequest,
        "DISPENSE_FEED"
    ).command;
    await services.worker.processCommand(dispense.commandId);
    await waitFor(() => services.deviceCommandStore.getCommand(dispense.commandId).status
        === "ACKNOWLEDGED", 4000, "dispense acknowledgement");

    const cycle = harness.edgeStore.getCycleByEvent(feedRequest.eventId);
    assert.equal(cycle.state, "COMPLETED");
    assert.equal(cycle.bellCommandId, bell.commandId);
    assert.equal(cycle.dispenseCommandId, dispense.commandId);
    assert.equal(cycle.feedMovementOccurred, true);
    assert.equal(cycle.sensorEvidence.evidenceVersion, "1.0");
    assert.equal(harness.edgeStore.recentCommands().length, 2);
    assert.equal(harness.hardware.evidence.filter(item => (
        item.type === "AUGER_REQUEST_CHANGED" && item.details.active
    )).length, 1);
    assert.equal(harness.hardware.getOutputs().motorAuthorityRequest, false);
});

test("signed edge status is protected, sanitized and available to administrators", async t => {
    const harness = await createHarness(t);
    await harness.edgeProcess.publishStatus("ONLINE");
    await waitFor(() => harness.app.locals.deviceCommandServices.controllerStore
        .getEdgeStatus(DEFAULT_SIMULATED_CONTROLLER_ID)?.history.length >= 2);

    await request(harness.app)
        .get(`/api/admin/device-controllers/${DEFAULT_SIMULATED_CONTROLLER_ID}/edge`)
        .expect(401);
    const response = await request(harness.app)
        .get(`/api/admin/device-controllers/${DEFAULT_SIMULATED_CONTROLLER_ID}/edge`)
        .set("authorization", "Development local-viewer")
        .expect(200);
    assert.equal(response.body.edge.status.controllerId, DEFAULT_SIMULATED_CONTROLLER_ID);
    assert.equal(response.body.edge.status.hardwareAdapter.type, "SIMULATED");
    assert.equal(response.body.edge.status.safetyController.watchdogHealthy, true);
    assert.equal(response.body.edge.status.maintenance.localPresenceEvidence, undefined);
    const serialized = JSON.stringify(response.body).toLowerCase();
    assert.equal(serialized.includes("privatekey"), false);
    assert.equal(serialized.includes("signingprivate"), false);
});
