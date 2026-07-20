import { randomUUID } from "node:crypto";
import { connect as mqttConnect } from "mqtt";

import {
    DeviceCommandOutcomeUnknownError
} from "../device-commands/device-adapter.js";
import { SimulatedDeviceController } from "../device-controllers/simulated-device-controller.js";
import {
    createAcknowledgementEnvelope,
    createHeartbeatEnvelope,
    createStatusEnvelope,
    validateCommandEnvelope,
    validateServerStateEnvelope
} from "./protocol-envelopes.js";
import { MqttTopicNamespace } from "./topic-namespace.js";

const ACKNOWLEDGEMENT_STATUS = Object.freeze({
    ACCEPTED: "ACCEPTED",
    STARTED: "STARTED",
    SUCCEEDED: "COMPLETED",
    REJECTED: "REJECTED",
    FAILED: "FAILED"
});
const ACKNOWLEDGEMENT_ORDINAL = Object.freeze({
    RECEIVED: 1,
    ACCEPTED: 2,
    STARTED: 3,
    COMPLETED: 4,
    REJECTED: 5,
    FAILED: 6,
    OUTCOME_UNKNOWN: 7
});

function parsePayload(buffer) {
    try {
        return JSON.parse(buffer.toString("utf8"));
    } catch {
        const error = new Error("MQTT payload is not valid JSON.");
        error.code = "MQTT_PAYLOAD_INVALID_JSON";
        throw error;
    }
}

export class SimulatedMqttController {
    constructor({
        controllerId,
        store,
        deviceCommandStore,
        config,
        security,
        logger,
        clock = () => new Date(),
        sleep,
        connect = mqttConnect,
        idGenerator = randomUUID
    }) {
        if (!security.controllerSigner) {
            throw new Error("The simulated MQTT controller requires a signing key.");
        }
        this.controllerId = controllerId;
        this.store = store;
        this.deviceCommandStore = deviceCommandStore;
        this.config = config;
        this.security = security;
        this.logger = logger;
        this.clock = clock;
        this.sleep = sleep;
        this.connect = connect;
        this.idGenerator = idGenerator;
        this.topics = new MqttTopicNamespace(security.environment);
        this.client = null;
        this.started = false;
        this.connected = false;
        this.bootId = null;
        this.bootCounter = 0;
        this.sequence = 0;
        this.assignmentState = null;
        this.safetyStates = new Map();
        this.heartbeatTimer = null;
        this.runtime = null;
        this.metrics = Object.create(null);
    }

    start() {
        if (this.started) {
            return;
        }
        const controller = this.store.requireController(this.controllerId);
        this.bootId = `controller_boot_${this.idGenerator()}`;
        const booted = this.store.startControllerBoot(
            this.controllerId,
            this.bootId,
            this.clock().toISOString()
        );
        this.bootCounter = booted.bootCounter;
        this.runtime = new SimulatedDeviceController({
            controllerId: this.controllerId,
            store: this.store,
            deviceCommandStore: this.deviceCommandStore,
            clock: this.clock,
            ...(this.sleep ? { sleep: this.sleep } : {}),
            safetyService: {
                assertCommandMayProgress: command => this.assertSafetyState(command)
            }
        });
        const offlineAt = this.clock();
        const will = createStatusEnvelope({
            controllerId: this.controllerId,
            barnId: controller.barnId,
            controllerBootId: this.bootId,
            bootCounter: this.bootCounter,
            sequence: 1,
            status: "OFFLINE",
            occurredAt: offlineAt.toISOString(),
            expiresAt: new Date(
                offlineAt.getTime() + this.config.mqttOfflineThresholdMs * 2
            ).toISOString(),
            signer: this.security.controllerSigner
        });
        this.sequence = 1;
        this.started = true;
        this.client = this.connect(this.config.mqttBrokerUrl, {
            protocolVersion: this.config.mqttProtocolVersion || 5,
            clientId: `${this.config.mqttClientId || "alpacaly"}-${this.controllerId}`,
            clean: false,
            reconnectPeriod: this.config.mqttReconnectPeriodMs ?? 1000,
            connectTimeout: this.config.mqttConnectTimeoutMs ?? 5000,
            will: {
                topic: this.topics.status(this.controllerId),
                payload: JSON.stringify(will),
                qos: 1,
                retain: true
            }
        });
        this.client.on("connect", () => void this.handleConnected());
        this.client.on("close", () => {
            this.connected = false;
            this.assignmentState = null;
            this.safetyStates.clear();
            this.stopHeartbeat();
        });
        this.client.on("offline", () => {
            this.connected = false;
            this.assignmentState = null;
            this.safetyStates.clear();
            this.stopHeartbeat();
        });
        this.client.on("message", (topic, payload) => {
            void this.receiveMessage(topic, payload);
        });
        this.client.on("error", error => this.reportError(error));
    }

    async handleConnected() {
        this.connected = true;
        const controller = this.store.requireController(this.controllerId);
        const subscriptions = [
            this.topics.commands(this.controllerId),
            this.topics.assignments(this.controllerId),
            this.topics.platformSafety(),
            this.topics.barnSafety(controller.barnId),
            ...controller.assignments.map(item => this.topics.feederSafety(item.feederId))
        ];
        try {
            await new Promise((resolve, reject) => {
                this.client.subscribe(
                    subscriptions,
                    { qos: 1 },
                    error => error ? reject(error) : resolve()
                );
            });
            await this.publishStatus("ONLINE", true);
            await this.publishHeartbeat();
            this.scheduleHeartbeat();
            await this.reconcileJournal();
        } catch (error) {
            this.reportError(error);
        }
    }

    async receiveMessage(topic, payload) {
        try {
            const parsedTopic = this.topics.parse(topic);
            const envelope = parsePayload(payload);
            if (parsedTopic.kind === "CONTROLLER") {
                if (parsedTopic.controllerId !== this.controllerId) {
                    throw Object.assign(new Error("Controller topic identity mismatch."), {
                        code: "MQTT_TOPIC_IDENTITY_MISMATCH"
                    });
                }
                if (parsedTopic.channel === "assignments") {
                    this.receiveAssignment(envelope);
                    return;
                }
                if (parsedTopic.channel === "commands") {
                    await this.receiveCommand(envelope);
                    return;
                }
            }
            if (parsedTopic.kind === "SAFETY") {
                this.receiveSafety(parsedTopic, envelope);
                return;
            }
            throw Object.assign(new Error("Controller received an unauthorised topic."), {
                code: "MQTT_TOPIC_NOT_AUTHORISED"
            });
        } catch (error) {
            this.increment("protocolError");
            this.reportError(error);
        }
    }

    receiveAssignment(envelope) {
        const controller = this.store.requireController(this.controllerId);
        validateServerStateEnvelope(envelope, {
            verifier: this.security.serverVerifier,
            messageType: "CONTROLLER_ASSIGNMENT",
            expectedControllerId: this.controllerId,
            expectedBarnId: controller.barnId,
            now: this.clock()
        });
        const currentMaximum = Math.max(
            0,
            ...(this.assignmentState?.assignments || [])
                .map(item => item.assignmentGeneration)
        );
        const incomingMaximum = Math.max(
            0,
            ...envelope.assignments.map(item => item.assignmentGeneration)
        );
        if (incomingMaximum < currentMaximum) {
            this.increment("staleAssignment");
            return;
        }
        this.assignmentState = envelope;
    }

    receiveSafety(parsedTopic, envelope) {
        const controller = this.store.requireController(this.controllerId);
        validateServerStateEnvelope(envelope, {
            verifier: this.security.serverVerifier,
            messageType: "SAFETY_STATE",
            expectedBarnId: parsedTopic.barnId || controller.barnId,
            expectedFeederId: parsedTopic.feederId,
            now: this.clock()
        });
        const scopeKey = envelope.level === "PLATFORM"
            ? "PLATFORM"
            : envelope.level === "BARN"
                ? `BARN:${envelope.barnId}`
                : `FEEDER:${envelope.feederId}`;
        const current = this.safetyStates.get(scopeKey);
        if (current && envelope.generation < current.generation) {
            this.increment("staleSafetyState");
            return;
        }
        this.safetyStates.set(scopeKey, envelope);
    }

    async receiveCommand(envelope) {
        const controller = this.store.requireController(this.controllerId);
        const assignment = this.assignmentState?.assignments?.find(item => (
            item.feederId === envelope.feederId
        ));
        validateCommandEnvelope(envelope, {
            verifier: this.security.serverVerifier,
            expectedControllerId: this.controllerId,
            expectedBarnId: controller.barnId,
            expectedFeederId: envelope.feederId,
            currentAssignmentGeneration: assignment?.assignmentGeneration,
            now: this.clock(),
            clockDriftToleranceMs: this.config.mqttClockDriftToleranceMs
        });
        if (!assignment || assignment.enabled !== true) {
            throw Object.assign(new Error("Controller assignment is absent or disabled."), {
                code: "MQTT_CONTROLLER_ASSIGNMENT_INVALID"
            });
        }
        if (Date.parse(assignment.authorityLeaseExpiresAt) <= this.clock().getTime()) {
            throw Object.assign(new Error("Controller authority lease has expired."), {
                code: "MQTT_AUTHORITY_LEASE_EXPIRED"
            });
        }
        this.assertSafetyState(envelope);
        const command = {
            commandId: envelope.commandId,
            eventId: envelope.eventId,
            barnId: envelope.barnId,
            feederId: envelope.feederId,
            deviceId: envelope.deviceId,
            commandType: envelope.action,
            commandPayload: envelope.parameters,
            fencingToken: envelope.fencingToken,
            assignmentGeneration: envelope.assignmentGeneration,
            expiresAt: envelope.expiresAt,
            authorityLeaseExpiresAt: envelope.authorityLeaseExpiresAt
        };
        const begun = this.store.beginJournal(
            this.controllerId,
            command,
            this.clock().toISOString()
        );
        await this.publishProtocolAcknowledgement(
            command,
            "RECEIVED",
            null,
            begun.journal
        );
        try {
            await this.runtime.receive(command, {
                emitAcknowledgement: legacyEnvelope => {
                    const status = ACKNOWLEDGEMENT_STATUS[
                        legacyEnvelope.acknowledgement?.result
                    ];
                    void this.publishProtocolAcknowledgement(
                        command,
                        status,
                        legacyEnvelope.acknowledgement,
                        this.store.getJournalForCommand(command.commandId),
                        { controllerId: legacyEnvelope.controllerId }
                    ).catch(error => this.reportError(error));
                }
            });
        } catch (error) {
            const journal = this.store.getJournalForCommand(command.commandId);
            if (
                error instanceof DeviceCommandOutcomeUnknownError
                || journal?.executionState === "OUTCOME_UNKNOWN"
                || journal?.dispensePerformed
            ) {
                await this.publishProtocolAcknowledgement(
                    command,
                    "OUTCOME_UNKNOWN",
                    null,
                    journal,
                    { error }
                );
                return;
            }
            const status = journal?.executionState === "STARTED"
                ? "FAILED" : "REJECTED";
            await this.publishProtocolAcknowledgement(
                command,
                status,
                null,
                journal,
                { error }
            );
        }
    }

    assertSafetyState(command) {
        const required = [
            "PLATFORM",
            `BARN:${command.barnId}`,
            `FEEDER:${command.feederId}`
        ];
        for (const scope of required) {
            const state = this.safetyStates.get(scope);
            if (!state || Date.parse(state.expiresAt) <= this.clock().getTime()) {
                const error = new Error("Controller cannot confirm current safety state.");
                error.code = "MQTT_SAFETY_STATE_UNCONFIRMED";
                throw error;
            }
            if (state.active) {
                const error = new Error("An MQTT emergency stop is active.");
                error.code = "MQTT_EMERGENCY_STOP_ACTIVE";
                throw error;
            }
        }
    }

    async publishProtocolAcknowledgement(
        command,
        status,
        acknowledgement,
        journal,
        { error = null, controllerId = this.controllerId } = {}
    ) {
        const occurredAt = acknowledgement?.receivedAt || this.clock().toISOString();
        const envelope = createAcknowledgementEnvelope({
            acknowledgement,
            status,
            command,
            controllerId,
            controllerBootId: this.bootId,
            controllerJournalSequence: Math.max(
                1,
                Number(journal?.journalSequence || 0) * 10
                    + Number(ACKNOWLEDGEMENT_ORDINAL[status] || 9)
            ),
            assignmentGeneration: command.assignmentGeneration,
            outcomeDetails: {
                measuredQuantity: acknowledgement?.measuredQuantity ?? null,
                errorCode: acknowledgement?.errorCode || error?.code || null,
                errorMessage: acknowledgement?.errorMessage
                    || (error ? String(error.message || error) : null),
                dispensePerformed: journal?.dispensePerformed === true
            },
            occurredAt,
            signer: this.security.controllerSigner
        });
        try {
            await this.publish(
                this.topics.acknowledgements(this.controllerId),
                envelope,
                { qos: 1, retain: false }
            );
            if (["COMPLETED", "REJECTED", "FAILED", "OUTCOME_UNKNOWN"].includes(status)) {
                this.store.recordAcknowledgementDelivery(command.commandId, true, {
                    timestamp: this.clock().toISOString(),
                    reconciliationState: status === "COMPLETED"
                        ? "DELIVERED"
                        : status === "OUTCOME_UNKNOWN"
                            ? "OUTCOME_UNKNOWN" : "DELIVERED"
                });
            }
        } catch (publishError) {
            if (["COMPLETED", "REJECTED", "FAILED", "OUTCOME_UNKNOWN"].includes(status)) {
                this.store.recordAcknowledgementDelivery(command.commandId, false, {
                    timestamp: this.clock().toISOString(),
                    reconciliationState: journal?.dispensePerformed
                        ? "OUTCOME_UNKNOWN" : "PENDING"
                });
            }
            this.reportError(publishError);
        }
    }

    async publishHeartbeat() {
        if (!this.connected) {
            return;
        }
        const controller = this.store.requireController(this.controllerId);
        const occurredAt = this.clock();
        const envelope = createHeartbeatEnvelope({
            controllerId: this.controllerId,
            barnId: controller.barnId,
            controllerBootId: this.bootId,
            bootCounter: this.bootCounter,
            sequence: this.nextSequence(),
            occurredAt: occurredAt.toISOString(),
            expiresAt: new Date(
                occurredAt.getTime() + this.config.mqttStaleThresholdMs
            ).toISOString(),
            signer: this.security.controllerSigner
        });
        await this.publish(this.topics.heartbeats(this.controllerId), envelope, {
            qos: 0,
            retain: false
        });
    }

    async publishStatus(status, retain = true) {
        if (!this.connected) {
            return;
        }
        const controller = this.store.requireController(this.controllerId);
        const occurredAt = this.clock();
        const envelope = createStatusEnvelope({
            controllerId: this.controllerId,
            barnId: controller.barnId,
            controllerBootId: this.bootId,
            bootCounter: this.bootCounter,
            sequence: this.nextSequence(),
            status,
            occurredAt: occurredAt.toISOString(),
            expiresAt: new Date(
                occurredAt.getTime() + this.config.mqttOfflineThresholdMs
            ).toISOString(),
            signer: this.security.controllerSigner
        });
        await this.publish(this.topics.status(this.controllerId), envelope, {
            qos: 1,
            retain
        });
    }

    publish(topic, payload, options) {
        if (!this.client?.connected) {
            return Promise.reject(new Error("Simulated controller is disconnected."));
        }
        return new Promise((resolve, reject) => {
            this.client.publish(
                topic,
                JSON.stringify(payload),
                options,
                error => error ? reject(error) : resolve()
            );
        });
    }

    scheduleHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setTimeout(async () => {
            this.heartbeatTimer = null;
            try {
                await this.publishHeartbeat();
            } catch (error) {
                this.reportError(error);
            }
            if (this.connected) {
                this.scheduleHeartbeat();
            }
        }, this.config.mqttHeartbeatIntervalMs);
        this.heartbeatTimer.unref?.();
    }

    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearTimeout(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    async reconcileJournal() {
        const incomplete = this.store.getIncompleteJournals()
            .filter(item => item.controllerId === this.controllerId);
        for (const journal of incomplete) {
            if (journal.dispensePerformed) {
                this.store.transitionJournal(journal.journalId, "OUTCOME_UNKNOWN", {
                    timestamp: this.clock().toISOString(),
                    dispensePerformed: true,
                    failureReason: "Controller restarted after a possible dispense"
                });
            }
        }
    }

    nextSequence() {
        this.sequence += 1;
        return this.sequence;
    }

    increment(name) {
        this.metrics[name] = Number(this.metrics[name] || 0) + 1;
    }

    reportError(error) {
        const code = String(error?.code || "");
        if (code.includes("SIGNATURE") || code.includes("SIGNING_KEY")) {
            this.increment("signatureFailure");
        } else if (code.includes("FENCING") || code.includes("GENERATION")) {
            this.increment("fencingFailure");
        } else if (code.includes("AUTHORITY_LEASE_EXPIRED")) {
            this.increment("authorityLeaseExpiry");
        } else if (code.includes("COMMAND_EXPIRED")) {
            this.increment("commandExpiry");
        } else if (code.includes("EMERGENCY_STOP")) {
            this.increment("emergencyStop");
        }
        this.logger?.warn?.({
            event: "simulated_mqtt_controller_error",
            controllerId: this.controllerId,
            code: error?.code,
            error: String(error?.message || error)
        }, "Simulated MQTT controller reported an error");
    }

    async shutdown({ force = false } = {}) {
        this.started = false;
        this.stopHeartbeat();
        if (!this.client) {
            return;
        }
        if (!force && this.connected) {
            try {
                await this.publishStatus("OFFLINE", true);
            } catch {}
        }
        const client = this.client;
        this.client = null;
        this.connected = false;
        await new Promise(resolve => client.end(force, {}, resolve));
    }
}
