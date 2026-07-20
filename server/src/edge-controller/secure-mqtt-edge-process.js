import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect as mqttConnect } from "mqtt";

import {
    createAcknowledgementEnvelope,
    createHeartbeatEnvelope,
    createStatusEnvelope,
    validateCommandEnvelope,
    validateServerStateEnvelope
} from "../mqtt/protocol-envelopes.js";
import { createEdgeMqttSecurityContext } from "../mqtt/security-context.js";
import { MqttTopicNamespace } from "../mqtt/topic-namespace.js";
import { BarnEdgeController } from "./barn-edge-controller.js";
import { SimulatedHardwareAdapter } from "./simulated-hardware-adapter.js";
import { SqliteEdgeStore } from "./sqlite-edge-store.js";

const ACK_ORDINAL = Object.freeze({
    RECEIVED: 1,
    ACCEPTED: 2,
    STARTED: 3,
    COMPLETED: 4,
    REJECTED: 5,
    FAILED: 6,
    CANCELLED: 7,
    OUTCOME_UNKNOWN: 8
});

function parsePayload(buffer) {
    try {
        return JSON.parse(buffer.toString("utf8"));
    } catch {
        throw Object.assign(new Error("MQTT payload is not valid JSON."), {
            code: "MQTT_PAYLOAD_INVALID_JSON"
        });
    }
}

function mqttOptions(config, will) {
    const options = {
        protocolVersion: config.mqttProtocolVersion,
        clientId: config.mqttClientId,
        clean: false,
        reconnectPeriod: config.mqttReconnectPeriodMs,
        connectTimeout: config.mqttConnectTimeoutMs,
        rejectUnauthorized: true,
        will
    };
    if (config.mqttTlsCaPath) {
        options.ca = readFileSync(config.mqttTlsCaPath);
        options.cert = readFileSync(config.mqttTlsCertificatePath);
        options.key = readFileSync(config.mqttTlsPrivateKeyPath);
    }
    return options;
}

export class SecureMqttEdgeProcess {
    constructor({
        config,
        store = null,
        hardware = null,
        controller = null,
        security = null,
        clock = () => new Date(),
        sleep = async milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
        connect = mqttConnect,
        idGenerator = randomUUID,
        logger = null
    }) {
        this.config = config;
        this.clock = clock;
        this.sleep = sleep;
        this.connect = connect;
        this.idGenerator = idGenerator;
        this.logger = logger;
        this.security = security || createEdgeMqttSecurityContext(config);
        this.store = store || new SqliteEdgeStore({
            databasePath: config.databasePath,
            controllerId: config.controllerId,
            clock,
            idGenerator,
            logger
        });
        this.hardware = hardware || new SimulatedHardwareAdapter({ clock });
        this.controller = controller || new BarnEdgeController({
            config,
            store: this.store,
            hardware: this.hardware,
            clock,
            sleep,
            idGenerator,
            logger
        });
        this.topics = new MqttTopicNamespace(this.security.environment);
        this.client = null;
        this.started = false;
        this.connected = false;
        this.sequence = 0;
        this.heartbeatTimer = null;
        this.assignmentEnvelope = null;
        this.lastError = null;
        this.metrics = Object.create(null);
        this.simulateAcknowledgementLoss = false;
    }

    start() {
        if (this.started) return;
        const now = this.clock();
        const willEnvelope = createStatusEnvelope({
            controllerId: this.config.controllerId,
            barnId: this.config.barnId,
            controllerBootId: this.controller.boot.bootId,
            bootCounter: this.controller.boot.bootCounter,
            sequence: 1,
            status: "OFFLINE",
            occurredAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + this.config.mqttOfflineThresholdMs * 2)
                .toISOString(),
            signer: this.security.controllerSigner
        });
        this.sequence = 1;
        this.started = true;
        this.client = this.connect(this.config.mqttBrokerUrl, mqttOptions(this.config, {
            topic: this.topics.status(this.config.controllerId),
            payload: JSON.stringify(willEnvelope),
            qos: 1,
            retain: true
        }));
        this.client.on("connect", () => void this.handleConnected());
        this.client.on("close", () => this.handleDisconnected());
        this.client.on("offline", () => this.handleDisconnected());
        this.client.on("message", (topic, payload) => void this.receiveMessage(topic, payload));
        this.client.on("error", error => this.reportError(error));
    }

    async handleConnected() {
        this.connected = true;
        this.controller.setNetworkConnected(true);
        try {
            await this.subscribe([
                this.topics.commands(this.config.controllerId),
                this.topics.assignments(this.config.controllerId),
                this.topics.platformSafety(),
                this.topics.barnSafety(this.config.barnId),
                ...this.config.feederIds.map(id => this.topics.feederSafety(id))
            ]);
            await this.publishStatus("ONLINE");
            await this.publishHeartbeat();
            await this.reconcileAcknowledgements();
            this.scheduleHeartbeat();
        } catch (error) {
            this.reportError(error);
        }
    }

    handleDisconnected() {
        this.connected = false;
        this.controller.setNetworkConnected(false);
        this.stopHeartbeat();
    }

    subscribe(topics) {
        return new Promise((resolve, reject) => {
            this.client.subscribe(topics, { qos: 1 }, error => error ? reject(error) : resolve());
        });
    }

    async receiveMessage(topic, payload) {
        let envelope;
        try {
            const parsedTopic = this.topics.parse(topic);
            envelope = parsePayload(payload);
            if (parsedTopic.kind === "CONTROLLER"
                && parsedTopic.controllerId === this.config.controllerId
                && parsedTopic.channel === "assignments") {
                return this.receiveAssignment(envelope);
            }
            if (parsedTopic.kind === "SAFETY") {
                return this.receiveSafety(parsedTopic, envelope);
            }
            if (parsedTopic.kind === "CONTROLLER"
                && parsedTopic.controllerId === this.config.controllerId
                && parsedTopic.channel === "commands") {
                return await this.receiveCommand(envelope);
            }
            throw Object.assign(new Error("Edge controller received an unauthorised topic."), {
                code: "MQTT_TOPIC_NOT_AUTHORISED"
            });
        } catch (error) {
            this.store.incrementCounter("edge_protocol_error", {
                code: error.code,
                message: String(error.message || error),
                commandId: envelope?.commandId || null
            });
            this.reportError(error);
        }
    }

    receiveAssignment(envelope) {
        validateServerStateEnvelope(envelope, {
            verifier: this.security.serverVerifier,
            messageType: "CONTROLLER_ASSIGNMENT",
            expectedControllerId: this.config.controllerId,
            expectedBarnId: this.config.barnId,
            now: this.clock()
        });
        this.assignmentEnvelope = envelope;
        this.controller.acceptAssignmentEnvelope(envelope);
    }

    receiveSafety(parsedTopic, envelope) {
        validateServerStateEnvelope(envelope, {
            verifier: this.security.serverVerifier,
            messageType: "SAFETY_STATE",
            expectedBarnId: parsedTopic.barnId || this.config.barnId,
            expectedFeederId: parsedTopic.feederId,
            now: this.clock()
        });
        this.controller.acceptSafetyEnvelope(envelope);
    }

    async receiveCommand(envelope) {
        const assignment = this.store.getAssignment(envelope.feederId);
        validateCommandEnvelope(envelope, {
            verifier: this.security.serverVerifier,
            expectedControllerId: this.config.controllerId,
            expectedBarnId: this.config.barnId,
            expectedFeederId: envelope.feederId,
            currentAssignmentGeneration: assignment?.assignmentGeneration,
            now: this.clock(),
            clockDriftToleranceMs: this.config.mqttClockDriftToleranceMs
        });
        if (!this.config.feederIds.includes(envelope.feederId)) {
            throw Object.assign(new Error("Command feeder is not assigned to this process."), {
                code: "MQTT_MESSAGE_IDENTITY_MISMATCH"
            });
        }
        return this.controller.handleCommand(envelope, {
            emitAcknowledgement: (status, acknowledgement, command) => (
                this.publishAcknowledgement(envelope, status, acknowledgement, command)
            )
        });
    }

    async publishAcknowledgement(envelope, status, acknowledgement, command) {
        if (this.simulateAcknowledgementLoss) {
            throw Object.assign(new Error("Deterministic acknowledgement loss."), {
                code: "EDGE_ACKNOWLEDGEMENT_LOSS"
            });
        }
        const protocolStatus = status === "CANCELLED" ? "REJECTED" : status;
        const signed = createAcknowledgementEnvelope({
            acknowledgement: {
                acknowledgementId: acknowledgement.acknowledgementId,
                receivedAt: acknowledgement.occurredAt,
                measuredQuantity: acknowledgement.measuredQuantity,
                errorCode: acknowledgement.errorCode,
                errorMessage: acknowledgement.errorMessage
            },
            status: protocolStatus,
            command: envelope,
            controllerId: this.config.controllerId,
            controllerBootId: this.controller.boot.bootId,
            controllerJournalSequence: Math.max(
                1,
                Number(command?.journalSequence || 1) * 10
                    + Number(ACK_ORDINAL[status] || 9)
            ),
            assignmentGeneration: envelope.assignmentGeneration,
            correlationId: envelope.correlationId,
            occurredAt: acknowledgement.occurredAt,
            outcomeDetails: {
                measuredQuantity: acknowledgement.measuredQuantity,
                errorCode: acknowledgement.errorCode,
                errorMessage: acknowledgement.errorMessage,
                cycleId: acknowledgement.cycleId,
                calibrationVersion: acknowledgement.calibrationVersion,
                welfareConfigurationVersion: acknowledgement.welfareConfigurationVersion,
                feedMovementOccurred: acknowledgement.feedMovementOccurred,
                sensorEvidence: acknowledgement.evidence,
                details: acknowledgement.details
            },
            signer: this.security.controllerSigner
        });
        await this.publish(this.topics.acknowledgements(this.config.controllerId), signed, {
            qos: 1,
            retain: false
        });
    }

    async reconcileAcknowledgements() {
        const pending = this.store.recentCommands(1000).filter(command => (
            TERMINAL_COMMAND_STATES.has(command.state)
            && command.acknowledgementDeliveryStatus !== "DELIVERED"
            && command.finalAcknowledgement
        ));
        for (const command of pending) {
            const envelope = {
                commandId: command.commandId,
                eventId: command.eventId,
                barnId: command.barnId,
                feederId: command.feederId,
                deviceId: command.deviceId,
                assignmentGeneration: command.assignmentGeneration,
                correlationId: command.eventId || command.commandId
            };
            try {
                await this.publishAcknowledgement(
                    envelope,
                    command.finalAcknowledgement.status,
                    command.finalAcknowledgement,
                    command
                );
                this.store.markAcknowledgementDelivery(command.commandId, true);
                this.store.incrementCounter("reconciliation_success", {
                    commandId: command.commandId
                });
            } catch (error) {
                this.store.markAcknowledgementDelivery(command.commandId, false);
                this.store.incrementCounter("reconciliation_failure", {
                    commandId: command.commandId,
                    code: error.code
                });
            }
        }
    }

    async publishHeartbeat() {
        if (!this.connected) return;
        const now = this.clock();
        const envelope = createHeartbeatEnvelope({
            controllerId: this.config.controllerId,
            barnId: this.config.barnId,
            controllerBootId: this.controller.boot.bootId,
            bootCounter: this.controller.boot.bootCounter,
            sequence: this.nextSequence(),
            occurredAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + this.config.mqttStaleThresholdMs).toISOString(),
            signer: this.security.controllerSigner
        });
        await this.publish(this.topics.heartbeats(this.config.controllerId), envelope, {
            qos: 0,
            retain: false
        });
    }

    async publishStatus(status = "ONLINE") {
        if (!this.connected) return;
        const now = this.clock();
        const edgeStatus = {
            ...this.controller.getStatus(),
            process: {
                connected: this.connected,
                lastError: this.lastError,
                metrics: { ...this.metrics }
            }
        };
        const envelope = createStatusEnvelope({
            controllerId: this.config.controllerId,
            barnId: this.config.barnId,
            controllerBootId: this.controller.boot.bootId,
            bootCounter: this.controller.boot.bootCounter,
            sequence: this.nextSequence(),
            status,
            occurredAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + this.config.mqttOfflineThresholdMs).toISOString(),
            edgeStatus,
            signer: this.security.controllerSigner
        });
        await this.publish(this.topics.status(this.config.controllerId), envelope, {
            qos: 1,
            retain: true
        });
    }

    publish(topic, payload, options) {
        if (!this.client?.connected) {
            return Promise.reject(Object.assign(new Error("Edge MQTT connection is unavailable."), {
                code: "EDGE_MQTT_DISCONNECTED"
            }));
        }
        return new Promise((resolve, reject) => {
            this.client.publish(topic, JSON.stringify(payload), options,
                error => error ? reject(error) : resolve());
        });
    }

    scheduleHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setTimeout(async () => {
            this.heartbeatTimer = null;
            try {
                await this.publishHeartbeat();
                await this.publishStatus("ONLINE");
            } catch (error) {
                this.reportError(error);
            }
            if (this.connected) this.scheduleHeartbeat();
        }, this.config.mqttHeartbeatIntervalMs);
        this.heartbeatTimer.unref?.();
    }

    stopHeartbeat() {
        if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    nextSequence() {
        this.sequence += 1;
        return this.sequence;
    }

    reportError(error) {
        this.lastError = {
            code: error?.code || "EDGE_PROCESS_ERROR",
            message: String(error?.message || error),
            occurredAt: this.clock().toISOString()
        };
        this.logger?.warn?.({ err: error, event: "edge_process_error" },
            "Barn edge-controller error");
    }

    async shutdown({ closeStore = false } = {}) {
        this.started = false;
        this.stopHeartbeat();
        this.controller.shutdown();
        if (this.connected) {
            try { await this.publishStatus("OFFLINE"); } catch {}
        }
        this.connected = false;
        this.controller.setNetworkConnected(false);
        if (this.client) {
            const client = this.client;
            this.client = null;
            await new Promise(resolve => client.end(false, {}, resolve));
        }
        if (closeStore) this.store.close();
    }
}

const TERMINAL_COMMAND_STATES = new Set([
    "COMPLETED", "REJECTED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"
]);
