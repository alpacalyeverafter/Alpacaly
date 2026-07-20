import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import aedes from "aedes";
import request from "supertest";

import { createApp } from "../src/app.js";
import { BrokerAclPolicy } from "../src/mqtt/broker-acl-policy.js";
import { canonicalJson } from "../src/mqtt/canonical-json.js";
import { DEVELOPMENT_MQTT_KEYS } from "../src/mqtt/development-keys.js";
import {
    Ed25519MessageSigner,
    Ed25519MessageVerifier
} from "../src/mqtt/message-signing.js";
import {
    createAssignmentEnvelope,
    createCommandEnvelope,
    validateCommandEnvelope
} from "../src/mqtt/protocol-envelopes.js";
import { createMqttSecurityContext } from "../src/mqtt/security-context.js";
import { SimulatedMqttController } from
    "../src/mqtt/simulated-mqtt-controller.js";
import { MqttTopicNamespace } from "../src/mqtt/topic-namespace.js";
import { DEFAULT_SIMULATED_CONTROLLER_ID } from
    "../src/domain/device-controllers.js";
import { DEFAULT_RESOURCE_IDS } from "../src/domain/resources.js";
import { EventEngine } from "../src/event-engine/event-engine.js";
import { loadConfig } from "../src/config/index.js";
import { createTestLogger, testConfig } from "./helpers.js";

function waitFor(predicate, timeoutMs = 3000, label = "MQTT test state") {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const check = () => {
            let result;
            try {
                result = predicate();
            } catch (error) {
                reject(error);
                return;
            }
            if (result) {
                resolve(result);
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

async function createEmbeddedBroker(t) {
    const broker = await aedes();
    const sockets = new Set();
    let server = createServer(broker.handle);
    const trackConnections = candidate => {
        candidate.on("connection", socket => {
            sockets.add(socket);
            socket.on("close", () => sockets.delete(socket));
        });
    };
    trackConnections(server);
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    return {
        url: `mqtt://127.0.0.1:${port}`,
        async stop() {
            sockets.forEach(socket => socket.destroy());
            if (server?.listening) {
                await new Promise(resolve => server.close(resolve));
            }
        },
        async restart() {
            server = createServer(broker.handle);
            trackConnections(server);
            await new Promise((resolve, reject) => {
                server.once("error", reject);
                server.listen(port, "127.0.0.1", resolve);
            });
        },
        async close() {
            sockets.forEach(socket => socket.destroy());
            if (server?.listening) {
                await new Promise(resolve => server.close(resolve));
            }
            await new Promise(resolve => broker.close(resolve));
        }
    };
}

async function createMqttHarness(t, overrides = {}) {
    const broker = await createEmbeddedBroker(t);
    const config = {
        ...testConfig,
        deviceTransport: "mqtt",
        mqttEnvironment: "test",
        // Aedes is deliberately used only as the embedded MQTT 3.1.1 broker.
        // Production loadConfig requires protocol version 5.
        mqttProtocolVersion: 4,
        mqttBrokerUrl: broker.url,
        mqttClientId: `alpacaly-test-${Date.now()}`,
        mqttConnectTimeoutMs: 500,
        mqttReconnectPeriodMs: 25,
        mqttCommandExpiryMs: 1000,
        mqttAuthorityLeaseMs: 1500,
        mqttHeartbeatIntervalMs: 25,
        mqttStaleThresholdMs: 100,
        mqttOfflineThresholdMs: 250,
        mqttClockDriftToleranceMs: 1000,
        mqttDevelopmentKeys: true,
        deviceCommandPollIntervalMs: 10,
        deviceAcknowledgementTimeoutMs: 500,
        ...overrides
    };
    const logger = createTestLogger();
    const eventEngine = new EventEngine({
        config,
        logger,
        autoProcess: false,
        sleep: async () => {}
    });
    const app = createApp({ config, logger, eventEngine });
    const devices = app.locals.deviceCommandServices;
    t.after(async () => {
        await devices.worker.stop();
        app.locals.contributionLedgerServices.outboxWorker.stop();
        if (!eventEngine.eventStore.closed) {
            await eventEngine.shutdown();
        }
        await broker.close();
    });
    await waitFor(() => (
        devices.deviceTransport.getConnectionStatus().connected
        && devices.controllerStore.getController(DEFAULT_SIMULATED_CONTROLLER_ID)
            ?.status === "ONLINE"
        && devices.deviceTransport.simulatedControllers
            .get(DEFAULT_SIMULATED_CONTROLLER_ID)?.assignmentState
    ));
    return { app, broker, config, devices, eventEngine };
}

function createCommand(harness, suffix = "normal") {
    const feedRequest = harness.app.locals.contributionLedgerServices
        .developmentWebsiteContributionService.simulate({
            supporterName: `MQTT supporter ${suffix}`,
            clientRequestId: `mqtt-${suffix}-${Date.now()}`
        }).feedRequest;
    return harness.devices.deviceCommandService.ensureCommandForEvent(
        feedRequest,
        "DISPENSE_FEED"
    ).command;
}

function administratorContext(harness, administratorId, role, reason) {
    const administrator = harness.app.locals.administratorSecurityServices.store
        .getAdministrator(administratorId);
    return {
        identity: {
            ...administrator,
            status: "ACTIVE",
            authenticationStrength: "MFA",
            authenticationTime: new Date().toISOString(),
            assignments: harness.app.locals.administratorSecurityServices.store
                .getIdentityAssignments(administratorId)
        },
        authorization: { effectiveRole: role },
        requestId: `request-${Date.now()}`,
        reason
    };
}

test("canonical JSON, Ed25519 signatures, rotation and revocation are deterministic", () => {
    assert.equal(
        canonicalJson({ z: 1, a: { y: 2, x: 3 } }),
        '{"a":{"x":3,"y":2},"z":1}'
    );
    const signer = new Ed25519MessageSigner({
        keyId: DEVELOPMENT_MQTT_KEYS.server.keyId,
        privateKey: DEVELOPMENT_MQTT_KEYS.server.privateKey,
        environment: "test",
        development: true
    });
    const verifier = new Ed25519MessageVerifier({
        keys: {
            [DEVELOPMENT_MQTT_KEYS.server.keyId]: {
                publicKey: DEVELOPMENT_MQTT_KEYS.server.publicKey,
                environment: "test",
                development: true
            }
        },
        environment: "test"
    });
    const signed = signer.sign({ protocolVersion: "1.0", value: "safe" });
    assert.equal(verifier.verify(signed), true);
    assert.throws(() => verifier.verify({ ...signed, value: "tampered" }), {
        code: "MQTT_SIGNATURE_INVALID"
    });
    verifier.revoke(DEVELOPMENT_MQTT_KEYS.server.keyId);
    assert.throws(() => verifier.verify(signed), {
        code: "MQTT_SIGNING_KEY_REVOKED"
    });
    verifier.rotate("rotated", {
        publicKey: DEVELOPMENT_MQTT_KEYS.server.publicKey,
        environment: "test"
    });
    assert.equal(verifier.keys.has("rotated"), true);
    const productionVerifier = new Ed25519MessageVerifier({
        keys: {
            [DEVELOPMENT_MQTT_KEYS.server.keyId]: {
                publicKey: DEVELOPMENT_MQTT_KEYS.server.publicKey,
                environment: "production",
                development: true
            }
        },
        environment: "production",
        production: true
    });
    const productionLabelledDevelopment = new Ed25519MessageSigner({
        keyId: DEVELOPMENT_MQTT_KEYS.server.keyId,
        privateKey: DEVELOPMENT_MQTT_KEYS.server.privateKey,
        environment: "production",
        development: true
    }).sign({ protocolVersion: "1.0" });
    assert.throws(() => productionVerifier.verify(productionLabelledDevelopment), {
        code: "MQTT_DEVELOPMENT_KEY_FORBIDDEN"
    });
});

test("topic namespace and ACL isolate controller and resource access", () => {
    const topics = new MqttTopicNamespace("test");
    const store = {
        getController(id) {
            return id === "controller-one" ? {
                controllerId: id,
                barnId: "barn-one",
                assignments: [{ feederId: "feeder-one" }]
            } : null;
        }
    };
    const acl = new BrokerAclPolicy({ environment: "test", controllerStore: store });
    assert.deepEqual(topics.parse(topics.commands("controller-one")), {
        kind: "CONTROLLER",
        controllerId: "controller-one",
        channel: "commands"
    });
    assert.equal(acl.canSubscribe(
        { type: "CONTROLLER", controllerId: "controller-one" },
        topics.commands("controller-one")
    ), true);
    assert.equal(acl.canSubscribe(
        { type: "CONTROLLER", controllerId: "controller-one" },
        topics.commands("controller-two")
    ), false);
    assert.equal(acl.canPublish(
        { type: "CONTROLLER", controllerId: "controller-one" },
        topics.commands("controller-one")
    ), false);
    assert.equal(acl.canSubscribe(
        { type: "CONTROLLER", controllerId: "controller-one" },
        topics.feederSafety("feeder-one")
    ), true);
    assert.equal(acl.canSubscribe(
        { type: "CONTROLLER", controllerId: "controller-one" },
        topics.feederSafety("feeder-two")
    ), false);
    assert.throws(() => topics.commands("bad/controller"), {
        code: "MQTT_TOPIC_INVALID"
    });
});

test("command envelopes reject expiry, lease expiry, wrong identity and stale generation", () => {
    const config = { ...testConfig, mqttEnvironment: "test", mqttDevelopmentKeys: true };
    const security = createMqttSecurityContext(config);
    const now = new Date("2026-07-20T12:00:00.000Z");
    const command = {
        commandId: "command-one",
        eventId: "event-one",
        barnId: "barn-one",
        feederId: "feeder-one",
        deviceId: "device-one",
        commandType: "DISPENSE_FEED",
        commandPayload: { quantity: 1 },
        fencingToken: 7
    };
    const valid = createCommandEnvelope(command, {
        controllerId: "controller-one",
        assignmentGeneration: 3,
        authorityLeaseExpiresAt: "2026-07-20T12:01:00.000Z",
        expiresAt: "2026-07-20T12:00:30.000Z",
        issuedAt: now.toISOString(),
        deliveryId: "delivery-one",
        signer: security.serverSigner
    });
    assert.equal(validateCommandEnvelope(valid, {
        verifier: security.serverVerifier,
        expectedControllerId: "controller-one",
        expectedBarnId: "barn-one",
        expectedFeederId: "feeder-one",
        currentAssignmentGeneration: 3,
        now
    }).commandId, "command-one");
    assert.throws(() => validateCommandEnvelope(valid, {
        verifier: security.serverVerifier,
        expectedControllerId: "controller-two",
        currentAssignmentGeneration: 3,
        now
    }), { code: "MQTT_MESSAGE_IDENTITY_MISMATCH" });
    assert.throws(() => validateCommandEnvelope(valid, {
        verifier: security.serverVerifier,
        expectedControllerId: "controller-one",
        currentAssignmentGeneration: 4,
        now
    }), { code: "MQTT_FENCING_GENERATION_STALE" });
    assert.throws(() => validateCommandEnvelope(valid, {
        verifier: security.serverVerifier,
        expectedControllerId: "controller-one",
        currentAssignmentGeneration: 3,
        now: new Date("2026-07-20T12:02:00.000Z")
    }), { code: "MQTT_COMMAND_EXPIRED" });
    const leaseLimited = createCommandEnvelope(command, {
        controllerId: "controller-one",
        assignmentGeneration: 3,
        authorityLeaseExpiresAt: "2026-07-20T12:00:10.000Z",
        expiresAt: "2026-07-20T12:05:00.000Z",
        issuedAt: now.toISOString(),
        deliveryId: "delivery-lease",
        signer: security.serverSigner
    });
    assert.throws(() => validateCommandEnvelope(leaseLimited, {
        verifier: security.serverVerifier,
        expectedControllerId: "controller-one",
        currentAssignmentGeneration: 3,
        now: new Date("2026-07-20T12:00:11.000Z")
    }), { code: "MQTT_AUTHORITY_LEASE_EXPIRED" });
});

test("stale retained assignment state cannot replace a newer generation", () => {
    const now = new Date("2026-07-20T12:00:00.000Z");
    const config = {
        ...testConfig,
        mqttEnvironment: "test",
        mqttDevelopmentKeys: true
    };
    const security = createMqttSecurityContext(config);
    const edge = new SimulatedMqttController({
        controllerId: "controller-one",
        store: {
            requireController() {
                return { controllerId: "controller-one", barnId: "barn-one" };
            }
        },
        deviceCommandStore: {},
        config,
        security,
        logger: createTestLogger(),
        clock: () => now
    });
    const assignment = generation => createAssignmentEnvelope({
        controllerId: "controller-one",
        barnId: "barn-one",
        assignments: [{
            feederId: "feeder-one",
            assignmentGeneration: generation,
            authorityLeaseExpiresAt: "2026-07-20T12:05:00.000Z",
            enabled: true
        }],
        occurredAt: now.toISOString(),
        expiresAt: "2026-07-20T12:05:00.000Z",
        signer: security.serverSigner
    });
    edge.receiveAssignment(assignment(4));
    edge.receiveAssignment(assignment(3));
    assert.equal(edge.assignmentState.assignments[0].assignmentGeneration, 4);
    assert.equal(edge.metrics.staleAssignment, 1);
});

test("production MQTT configuration fails closed without MQTT 5 mTLS and signing", () => {
    assert.throws(() => loadConfig({
        NODE_ENV: "production",
        DEVICE_TRANSPORT: "mqtt",
        MQTT_BROKER_URL: "mqtt://localhost:1883",
        MQTT_DEVELOPMENT_KEYS: "false"
    }, { loadEnvFile: false }), /mqtts:\/\//);
    assert.throws(() => loadConfig({
        NODE_ENV: "production",
        DEVICE_TRANSPORT: "mqtt",
        MQTT_BROKER_URL: "mqtts://localhost:8883",
        MQTT_PROTOCOL_VERSION: "4",
        MQTT_DEVELOPMENT_KEYS: "false"
    }, { loadEnvFile: false }), /MQTT 5/);
    const inProcess = loadConfig({ NODE_ENV: "production" }, { loadEnvFile: false });
    assert.equal(inProcess.deviceTransport, "in_process");
});

test("embedded broker carries a signed command through the simulator and signed acknowledgements", async t => {
    const harness = await createMqttHarness(t);
    const command = createCommand(harness, "complete");
    await harness.devices.worker.processCommand(command.commandId);
    const completed = await waitFor(() => {
        const current = harness.devices.deviceCommandStore.getCommand(command.commandId);
        return current.status === "ACKNOWLEDGED" ? current : null;
    });
    assert.equal(completed.attemptCount, 1);
    assert.equal(
        harness.devices.deviceCommandStore.getSimulatedExecution(command.commandId)
            .actionCount,
        1
    );
    const acknowledgements = harness.devices.deviceCommandStore
        .getAcknowledgementsForCommand(command.commandId);
    assert.deepEqual(
        acknowledgements.map(item => item.result),
        ["ACCEPTED", "STARTED", "SUCCEEDED"]
    );
    assert.equal(acknowledgements.every(item => item.metadata.mqtt === true), true);
    const journal = harness.devices.controllerStore.getJournalForCommand(
        command.commandId
    );
    assert.equal(journal.executionState, "COMPLETED");
    assert.equal(journal.dispensePerformed, true);
    assert.equal(journal.acknowledgementDeliverySucceeded, true);
    assert.equal(harness.devices.deviceTransport.getConnectionStatus().transportType, "mqtt");
});

test("duplicate MQTT command delivery is journal-idempotent", async t => {
    const harness = await createMqttHarness(t);
    const command = createCommand(harness, "duplicate");
    await harness.devices.worker.processCommand(command.commandId);
    await waitFor(() => (
        harness.devices.deviceCommandStore.getCommand(command.commandId).status
            === "ACKNOWLEDGED"
    ));
    const delivery = harness.devices.controllerStore
        .getOutboundDeliveries(command.commandId)[0];
    const edge = harness.devices.deviceTransport.simulatedControllers
        .get(DEFAULT_SIMULATED_CONTROLLER_ID);
    const assignment = harness.devices.controllerStore.getAssignmentForFeeder(
        DEFAULT_RESOURCE_IDS.feederId
    );
    const now = new Date();
    const envelope = createCommandEnvelope(command, {
        controllerId: DEFAULT_SIMULATED_CONTROLLER_ID,
        assignmentGeneration: assignment.assignmentGeneration,
        authorityLeaseExpiresAt: new Date(now.getTime() + 1000).toISOString(),
        expiresAt: new Date(now.getTime() + 1000).toISOString(),
        issuedAt: now.toISOString(),
        deliveryId: delivery.deliveryId,
        signer: createMqttSecurityContext(harness.config).serverSigner
    });
    await edge.receiveCommand(envelope);
    assert.equal(
        harness.devices.deviceCommandStore.getSimulatedExecution(command.commandId)
            .actionCount,
        1
    );
    assert.equal(
        harness.devices.controllerStore.getJournalForCommand(command.commandId)
            .executionState,
        "COMPLETED"
    );
});

test("duplicate and wrong-identity MQTT acknowledgements stay idempotent and fail safe", async t => {
    const duplicateHarness = await createMqttHarness(t);
    duplicateHarness.devices.controllerStore.setBehaviour(
        DEFAULT_SIMULATED_CONTROLLER_ID,
        { mode: "DUPLICATE_ACKNOWLEDGEMENT" },
        new Date().toISOString()
    );
    const duplicateCommand = createCommand(duplicateHarness, "duplicate-ack");
    await duplicateHarness.devices.worker.processCommand(duplicateCommand.commandId);
    await waitFor(() => (
        duplicateHarness.devices.deviceCommandStore.getCommand(
            duplicateCommand.commandId
        ).status === "ACKNOWLEDGED"
    ));
    assert.ok(duplicateHarness.devices.controllerStore.getProtocolEvents({
        controllerId: DEFAULT_SIMULATED_CONTROLLER_ID
    }).some(item => item.eventType === "DUPLICATE_ACKNOWLEDGEMENT"));

    duplicateHarness.devices.controllerStore.setBehaviour(
        DEFAULT_SIMULATED_CONTROLLER_ID,
        { mode: "WRONG_CONTROLLER_IDENTITY" },
        new Date().toISOString()
    );
    const wrongIdentity = createCommand(duplicateHarness, "wrong-identity");
    await duplicateHarness.devices.worker.processCommand(wrongIdentity.commandId);
    await waitFor(() => (
        duplicateHarness.devices.controllerStore.getProtocolEvents({ limit: 200 })
            .some(item => (
                item.commandId === wrongIdentity.commandId
                && item.code === "MQTT_MESSAGE_IDENTITY_MISMATCH"
            ))
    ));
    assert.notEqual(
        duplicateHarness.devices.deviceCommandStore.getCommand(wrongIdentity.commandId)
            .status,
        "ACKNOWLEDGED"
    );
});

test("a post-dispense MQTT failure becomes OUTCOME_UNKNOWN and never repeats", async t => {
    const harness = await createMqttHarness(t);
    harness.devices.controllerStore.setBehaviour(
        DEFAULT_SIMULATED_CONTROLLER_ID,
        { mode: "FAIL_AFTER_DISPENSE" },
        new Date().toISOString()
    );
    const command = createCommand(harness, "uncertain");
    await harness.devices.worker.processCommand(command.commandId);
    await waitFor(() => (
        harness.devices.deviceCommandStore.getCommand(command.commandId).status
            === "OUTCOME_UNKNOWN"
    ));
    assert.equal(
        harness.devices.deviceCommandStore.getSimulatedExecution(command.commandId)
            .actionCount,
        1
    );
    await harness.devices.worker.processCommand(command.commandId);
    assert.equal(
        harness.devices.deviceCommandStore.getSimulatedExecution(command.commandId)
            .actionCount,
        1
    );
});

test("retained emergency-stop state blocks a restarted controller", async t => {
    const harness = await createMqttHarness(t);
    const safety = harness.app.locals.operatorSafetyServices.emergencyStopService;
    safety.activate({
        level: "FEEDER",
        barnId: DEFAULT_RESOURCE_IDS.barnId,
        feederId: DEFAULT_RESOURCE_IDS.feederId,
        reason: "MQTT retained stop test"
    }, administratorContext(
        harness,
        "administrator_development_hardware_operator",
        "HARDWARE_OPERATOR",
        "MQTT retained stop test"
    ));
    const firstEdge = harness.devices.deviceTransport.simulatedControllers
        .get(DEFAULT_SIMULATED_CONTROLLER_ID);
    await waitFor(() => firstEdge.safetyStates
        .get(`FEEDER:${DEFAULT_RESOURCE_IDS.feederId}`)?.active === true);
    await firstEdge.shutdown({ force: true });
    harness.devices.deviceTransport.simulatedControllers.delete(
        DEFAULT_SIMULATED_CONTROLLER_ID
    );
    const restarted = harness.devices.deviceTransport.ensureSimulatedController(
        DEFAULT_SIMULATED_CONTROLLER_ID
    );
    await waitFor(() => restarted.safetyStates
        .get(`FEEDER:${DEFAULT_RESOURCE_IDS.feederId}`)?.active === true);
    assert.throws(() => restarted.assertSafetyState({
        barnId: DEFAULT_RESOURCE_IDS.barnId,
        feederId: DEFAULT_RESOURCE_IDS.feederId
    }), { code: "MQTT_EMERGENCY_STOP_ACTIVE" });
});

test("assignment generations persist and advance across disable, re-enable and reinstall", async t => {
    const harness = await createMqttHarness(t);
    const store = harness.devices.controllerStore;
    const initial = store.getAssignmentForFeeder(DEFAULT_RESOURCE_IDS.feederId);
    store.setEnabled(DEFAULT_SIMULATED_CONTROLLER_ID, false, new Date().toISOString());
    const disabled = store.getAssignmentForFeeder(DEFAULT_RESOURCE_IDS.feederId);
    assert.equal(disabled.assignmentGeneration, initial.assignmentGeneration + 1);
    store.setEnabled(DEFAULT_SIMULATED_CONTROLLER_ID, true, new Date().toISOString());
    const enabled = store.getAssignmentForFeeder(DEFAULT_RESOURCE_IDS.feederId);
    assert.equal(enabled.assignmentGeneration, disabled.assignmentGeneration + 1);
    const reinstalled = store.reassignFeeder(
        DEFAULT_RESOURCE_IDS.feederId,
        DEFAULT_SIMULATED_CONTROLLER_ID,
        { timestamp: new Date().toISOString(), reason: "REINSTALL_TEST" }
    );
    assert.equal(reinstalled.assignmentGeneration, enabled.assignmentGeneration + 1);
    assert.deepEqual(
        store.getAssignmentHistory(DEFAULT_RESOURCE_IDS.feederId)
            .map(item => item.assignmentGeneration),
        [1, 2, 3, 4]
    );
});

test("production controller enablement is immediate-to-disable but requires two current approvers to re-enable", async t => {
    const config = { ...testConfig };
    const logger = createTestLogger();
    const eventEngine = new EventEngine({
        config,
        logger,
        autoProcess: false,
        sleep: async () => {}
    });
    const app = createApp({ config, logger, eventEngine });
    const devices = app.locals.deviceCommandServices;
    const harness = { app };
    t.after(async () => {
        await devices.worker.stop();
        app.locals.contributionLedgerServices.outboxWorker.stop();
        if (!eventEngine.eventStore.closed) {
            await eventEngine.shutdown();
        }
    });
    config.nodeEnv = "production";
    config.enableDevelopmentAuthentication = false;
    config.managedIdentityProviderConfigured = true;
    const controller = devices.controllerService;
    const initialGeneration = devices.controllerStore.getAssignmentForFeeder(
        DEFAULT_RESOURCE_IDS.feederId
    ).assignmentGeneration;
    const disabled = controller.setEnabled(
        DEFAULT_SIMULATED_CONTROLLER_ID,
        false,
        administratorContext(
            harness,
            "administrator_development_hardware_operator",
            "HARDWARE_OPERATOR",
            "Immediate safety disable"
        )
    );
    assert.equal(disabled.enabled, false);
    assert.equal(
        devices.controllerStore.getAssignmentForFeeder(
            DEFAULT_RESOURCE_IDS.feederId
        ).assignmentGeneration,
        initialGeneration + 1
    );
    const approvalRequest = controller.setEnabled(
        DEFAULT_SIMULATED_CONTROLLER_ID,
        true,
        administratorContext(
            harness,
            "administrator_development_hardware_operator",
            "HARDWARE_OPERATOR",
            "Production re-enable"
        )
    );
    assert.equal(approvalRequest.status, "PENDING");
    assert.equal(controller.get(DEFAULT_SIMULATED_CONTROLLER_ID).enabled, false);
    const approvalService = app.locals.operatorSafetyServices.approvalService;
    const partial = approvalService.decide(approvalRequest.approvalRequestId, {
        decision: "APPROVE",
        authorityRepresented: "HARDWARE",
        reason: "Hardware approval"
    }, administratorContext(
        harness,
        "administrator_development_platform_admin_secondary",
        "ADMINISTRATOR",
        "Hardware approval"
    ));
    assert.equal(partial.status, "PARTIALLY_APPROVED");
    const executed = approvalService.decide(approvalRequest.approvalRequestId, {
        decision: "APPROVE",
        authorityRepresented: "PLATFORM_ADMIN",
        reason: "Platform approval"
    }, administratorContext(
        harness,
        "administrator_development_platform_admin_tertiary",
        "ADMINISTRATOR",
        "Platform approval"
    ));
    assert.equal(executed.status, "EXECUTED");
    assert.equal(controller.get(DEFAULT_SIMULATED_CONTROLLER_ID).enabled, true);
    assert.equal(
        devices.controllerStore.getAssignmentForFeeder(
            DEFAULT_RESOURCE_IDS.feederId
        ).assignmentGeneration,
        initialGeneration + 2
    );
});

test("broker outage reconnects and retained authority state is restored", async t => {
    const harness = await createMqttHarness(t);
    harness.devices.worker.started = false;
    if (harness.devices.worker.timer) {
        clearTimeout(harness.devices.worker.timer);
        harness.devices.worker.timer = null;
    }
    await harness.broker.stop();
    await waitFor(() => !harness.devices.deviceTransport.getConnectionStatus().connected);
    const command = createCommand(harness, "offline");
    await harness.devices.worker.processCommand(command.commandId);
    assert.equal(
        harness.devices.deviceCommandStore.getCommand(command.commandId).status,
        "RETRY_SCHEDULED"
    );
    await harness.broker.restart();
    await waitFor(() => {
        const edge = harness.devices.deviceTransport.simulatedControllers
            .get(DEFAULT_SIMULATED_CONTROLLER_ID);
        return harness.devices.deviceTransport.getConnectionStatus().connected
            && edge?.connected
            && edge?.assignmentState
            && edge?.safetyStates.size >= 3;
    }, 3000, "MQTT clients and retained authority after broker restart");
    await harness.devices.worker.processCommand(command.commandId);
    await waitFor(() => (
        harness.devices.deviceCommandStore.getCommand(command.commandId).status
            === "ACKNOWLEDGED"
    ), 3000, "command acknowledgement after broker restart");
    assert.ok(harness.devices.deviceTransport.getConnectionStatus().reconnectCount >= 1);
});

test("administrator MQTT visibility is protected and secret-free", async t => {
    const harness = await createMqttHarness(t);
    await request(harness.app)
        .get("/api/admin/device-transport")
        .expect(401);
    const transport = await request(harness.app)
        .get(`/api/admin/device-transport?barnId=${DEFAULT_RESOURCE_IDS.barnId}`)
        .set("Authorization", "Development local-viewer")
        .expect(200);
    assert.equal(transport.body.transport.transportType, "mqtt");
    assert.equal(transport.body.transport.connected, true);
    const protocol = await request(harness.app)
        .get(`/api/admin/device-controllers/${DEFAULT_SIMULATED_CONTROLLER_ID}/protocol`)
        .set("Authorization", "Development local-viewer")
        .expect(200);
    assert.equal(
        protocol.body.protocol.controller.controllerBootId.startsWith(
            "controller_boot_"
        ),
        true
    );
    assert.equal(
        protocol.body.protocol.controller.assignments[0].assignmentGeneration >= 1,
        true
    );
    assert.equal(/PRIVATE KEY|signature/i.test(JSON.stringify(protocol.body)), false);
});
