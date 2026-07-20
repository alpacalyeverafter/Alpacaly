import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { connect as mqttConnect } from "mqtt";

import {
    DeviceCommandOutcomeUnknownError,
    DeviceUnavailableError
} from "../device-commands/device-adapter.js";
import {
    DeviceTransport,
    DeviceTransportError
} from "../device-commands/device-transport.js";
import {
    createAssignmentEnvelope,
    createCommandEnvelope,
    createSafetyEnvelope,
    validateAcknowledgementEnvelope,
    validateControllerStateEnvelope
} from "./protocol-envelopes.js";
import { MqttTopicNamespace } from "./topic-namespace.js";

function parsePayload(buffer) {
    try {
        return JSON.parse(buffer.toString("utf8"));
    } catch {
        const error = new Error("MQTT payload is not valid JSON.");
        error.code = "MQTT_PAYLOAD_INVALID_JSON";
        throw error;
    }
}

function mqttOptions(config) {
    const options = {
        protocolVersion: config.mqttProtocolVersion || 5,
        clientId: config.mqttClientId || "alpacaly-server",
        clean: false,
        reconnectPeriod: config.mqttReconnectPeriodMs ?? 1000,
        connectTimeout: config.mqttConnectTimeoutMs ?? 5000,
        rejectUnauthorized: true
    };
    if (config.mqttTlsCaPath) {
        options.ca = readFileSync(config.mqttTlsCaPath);
        options.cert = readFileSync(config.mqttTlsCertificatePath);
        options.key = readFileSync(config.mqttTlsPrivateKeyPath);
    }
    return options;
}

export class MqttDeviceTransport extends DeviceTransport {
    constructor({
        store,
        deviceCommandStore,
        config,
        logger,
        security,
        clock = () => new Date(),
        connect = mqttConnect,
        idGenerator = randomUUID,
        simulatedControllerFactory = null
    }) {
        super();
        this.store = store;
        this.deviceCommandStore = deviceCommandStore;
        this.config = config;
        this.logger = logger;
        this.security = security;
        this.clock = clock;
        this.connect = connect;
        this.idGenerator = idGenerator;
        this.simulatedControllerFactory = simulatedControllerFactory;
        this.simulatedControllers = new Map();
        this.topics = new MqttTopicNamespace(security.environment);
        this.client = null;
        this.started = false;
        this.connected = false;
        this.everConnected = false;
        this.reconnectCount = 0;
        this.lastConnectedAt = null;
        this.lastDisconnectedAt = null;
        this.lastError = null;
        this.onAcknowledgement = () => {};
        this.onTransportError = () => {};
        this.onOutcomeUnknown = () => {};
        this.onReconnect = () => {};
        this.safetyService = null;
        this.removeSafetyListener = null;
        this.metrics = Object.create(null);
    }

    start(callbacks = {}) {
        this.onAcknowledgement = callbacks.onAcknowledgement || this.onAcknowledgement;
        this.onTransportError = callbacks.onTransportError || this.onTransportError;
        this.onOutcomeUnknown = callbacks.onOutcomeUnknown || this.onOutcomeUnknown;
        this.onReconnect = callbacks.onReconnect || this.onReconnect;
        if (this.started) {
            return;
        }
        this.started = true;
        this.client = this.connect(
            this.config.mqttBrokerUrl,
            mqttOptions(this.config)
        );
        this.client.on("connect", () => void this.handleConnected());
        this.client.on("reconnect", () => {
            this.reconnectCount += 1;
            this.increment("mqttReconnect");
            this.recordEvent({ eventType: "MQTT_RECONNECT", severity: "WARN" });
        });
        this.client.on("close", () => {
            this.connected = false;
            this.lastDisconnectedAt = this.clock().toISOString();
        });
        this.client.on("offline", () => {
            this.connected = false;
            this.lastDisconnectedAt = this.clock().toISOString();
        });
        this.client.on("error", error => this.reportError(error));
        this.client.on("message", (topic, payload) => {
            void this.receiveMessage(topic, payload);
        });
        this.store.getControllers().forEach(controller => (
            this.ensureSimulatedController(controller.controllerId)
        ));
    }

    async handleConnected() {
        const reconnect = this.everConnected;
        this.connected = true;
        this.everConnected = true;
        this.lastConnectedAt = this.clock().toISOString();
        this.lastError = null;
        try {
            await Promise.all([
                this.subscribe(this.topics.controllerWildcard("acknowledgements")),
                this.subscribe(this.topics.controllerWildcard("heartbeats")),
                this.subscribe(this.topics.controllerWildcard("status"))
            ]);
            await this.publishAuthorityState();
            if (reconnect) {
                this.onReconnect();
            }
        } catch (error) {
            this.reportError(error);
        }
    }

    subscribe(topic) {
        return new Promise((resolve, reject) => {
            this.client.subscribe(topic, { qos: 1 }, error => (
                error ? reject(error) : resolve()
            ));
        });
    }

    async deliver(command) {
        if (!this.started || !this.connected || !this.client?.connected) {
            this.increment("commandPublishFailure");
            throw new DeviceUnavailableError("MQTT broker connection is unavailable.");
        }
        const controller = this.store.ensureControllerForFeeder({
            barnId: command.barnId,
            feederId: command.feederId,
            createdAt: this.clock().toISOString()
        });
        this.ensureSimulatedController(controller.controllerId);
        if (!controller.enabled || controller.revokedAt) {
            const error = new DeviceUnavailableError(
                "The assigned controller is disabled or revoked."
            );
            error.terminalFailure = true;
            throw error;
        }
        const assignment = this.store.renewAuthorityLease(command.feederId, {
            timestamp: this.clock().toISOString(),
            authorityLeaseMs: this.config.mqttAuthorityLeaseMs
        });
        await this.publishAssignments(controller.controllerId);
        const issuedAtDate = this.clock();
        const deliveryId = `delivery_${this.idGenerator()}`;
        const expiresAt = new Date(
            issuedAtDate.getTime() + this.config.mqttCommandExpiryMs
        ).toISOString();
        const envelope = createCommandEnvelope(command, {
            controllerId: controller.controllerId,
            assignmentGeneration: assignment.assignmentGeneration,
            authorityLeaseExpiresAt: assignment.authorityLeaseExpiresAt,
            expiresAt,
            issuedAt: issuedAtDate.toISOString(),
            deliveryId,
            signer: this.security.serverSigner
        });
        const topic = this.topics.commands(controller.controllerId);
        this.store.recordOutboundDelivery({
            deliveryId,
            commandId: command.commandId,
            controllerId: controller.controllerId,
            assignmentGeneration: assignment.assignmentGeneration,
            topic,
            publishedAt: issuedAtDate.toISOString()
        });
        try {
            await this.publish(topic, envelope, {
                qos: this.config.mqttCommandQos ?? 1,
                retain: false,
                messageExpiryInterval: Math.max(
                    1,
                    Math.ceil(this.config.mqttCommandExpiryMs / 1000)
                )
            });
            this.store.completeOutboundDelivery(deliveryId, {
                succeeded: true,
                timestamp: this.clock().toISOString()
            });
            return {
                delivered: true,
                controllerId: controller.controllerId,
                deliveryId,
                assignmentGeneration: assignment.assignmentGeneration
            };
        } catch (error) {
            this.store.completeOutboundDelivery(deliveryId, {
                succeeded: false,
                timestamp: this.clock().toISOString(),
                failureCode: error.code || "MQTT_PUBLISH_FAILED"
            });
            this.increment("commandPublishFailure");
            this.recordEvent({
                eventType: "COMMAND_PUBLISH_FAILURE",
                severity: "ERROR",
                code: error.code || "MQTT_PUBLISH_FAILED",
                controllerId: controller.controllerId,
                commandId: command.commandId,
                topic
            });
            throw new DeviceTransportError("MQTT command publishing failed.", {
                code: "MQTT_COMMAND_PUBLISH_FAILED",
                deliveryOutcome: "UNKNOWN"
            });
        }
    }

    publish(topic, payload, { qos = 1, retain = false, messageExpiryInterval } = {}) {
        if (!this.client?.connected) {
            return Promise.reject(new DeviceUnavailableError(
                "MQTT broker connection is unavailable."
            ));
        }
        const options = { qos, retain };
        if (
            this.config.mqttProtocolVersion === 5
            && messageExpiryInterval !== undefined
        ) {
            options.properties = { messageExpiryInterval };
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

    async receiveMessage(topic, payload) {
        let parsedTopic;
        let envelope;
        try {
            parsedTopic = this.topics.parse(topic);
            if (parsedTopic.kind !== "CONTROLLER") {
                throw Object.assign(new Error("Unexpected inbound MQTT topic."), {
                    code: "MQTT_TOPIC_INVALID"
                });
            }
            envelope = parsePayload(payload);
            if (parsedTopic.channel === "acknowledgements") {
                await this.receiveAcknowledgement(topic, parsedTopic, envelope);
            } else if (parsedTopic.channel === "heartbeats") {
                this.receiveControllerState(topic, parsedTopic, envelope, true);
            } else if (parsedTopic.channel === "status") {
                this.receiveControllerState(topic, parsedTopic, envelope, false);
            }
        } catch (error) {
            const classification = this.classifyProtocolError(error);
            const eventType = classification.eventType;
            this.increment(classification.counter);
            this.recordEvent({
                eventType,
                severity: "ERROR",
                code: error.code || "MQTT_MESSAGE_REJECTED",
                controllerId: parsedTopic?.controllerId || envelope?.controllerId,
                commandId: envelope?.commandId,
                topic,
                details: { message: String(error.message || error) }
            });
            this.reportError(error, {
                controllerId: parsedTopic?.controllerId,
                commandId: envelope?.commandId
            });
        }
    }

    async receiveAcknowledgement(topic, parsedTopic, envelope) {
        this.topics.assertControllerTopic(
            topic,
            parsedTopic.controllerId,
            "acknowledgements"
        );
        const command = this.deviceCommandStore.getCommand(envelope.commandId);
        if (!command) {
            throw Object.assign(new Error("Acknowledged command was not found."), {
                code: "MQTT_COMMAND_NOT_FOUND"
            });
        }
        const assignment = this.store.getAssignmentForFeeder(command.feederId);
        const validated = validateAcknowledgementEnvelope(envelope, {
            verifier: this.security.controllerVerifier,
            expectedControllerId: parsedTopic.controllerId,
            expectedBarnId: command.barnId,
            expectedFeederId: command.feederId,
            expectedAssignmentGeneration: assignment?.assignmentGeneration,
            now: this.clock(),
            clockDriftToleranceMs: this.config.mqttClockDriftToleranceMs
        });
        if (assignment?.controllerId !== parsedTopic.controllerId) {
            throw Object.assign(new Error("Acknowledgement came from an old controller."), {
                code: "MQTT_ACKNOWLEDGEMENT_FENCING_STALE"
            });
        }
        const replay = this.store.recordInboundMessage({
            controllerId: validated.controllerId,
            messageType: validated.messageType,
            messageId: validated.acknowledgementId,
            controllerBootId: validated.controllerBootId,
            controllerSequence: validated.controllerJournalSequence,
            receivedAt: this.clock().toISOString()
        });
        if (replay.duplicate) {
            this.increment("duplicateDelivery");
            this.recordEvent({
                eventType: "DUPLICATE_ACKNOWLEDGEMENT",
                code: "MQTT_DUPLICATE_DELIVERY",
                controllerId: validated.controllerId,
                commandId: validated.commandId,
                topic
            });
        }
        if (validated.status === "RECEIVED") {
            this.deviceCommandStore.appendAuditRecord(
                command.commandId,
                "MQTT_COMMAND_RECEIVED_BY_CONTROLLER",
                this.clock().toISOString(),
                {
                    controllerId: validated.controllerId,
                    controllerBootId: validated.controllerBootId,
                    assignmentGeneration: validated.assignmentGeneration,
                    duplicate: replay.duplicate
                }
            );
            return;
        }
        if (validated.status === "OUTCOME_UNKNOWN") {
            this.increment("outcomeUnknown");
            this.onOutcomeUnknown({
                commandId: validated.commandId,
                reason: validated.outcomeDetails?.errorMessage
                    || "Controller reported OUTCOME_UNKNOWN"
            });
            return;
        }
        const result = validated.status === "COMPLETED"
            ? "SUCCEEDED" : validated.status;
        const latencyMs = Math.max(
            0,
            this.clock().getTime() - Date.parse(validated.occurredAt)
        );
        this.metrics.acknowledgementLatencyCount = Number(
            this.metrics.acknowledgementLatencyCount || 0
        ) + 1;
        this.metrics.acknowledgementLatencyTotalMs = Number(
            this.metrics.acknowledgementLatencyTotalMs || 0
        ) + latencyMs;
        this.onAcknowledgement({
            acknowledgementId: validated.acknowledgementId,
            commandId: validated.commandId,
            deviceId: validated.deviceId,
            acknowledgementType: `${command.commandType}_${result}`,
            receivedAt: this.clock().toISOString(),
            deviceTimestamp: validated.occurredAt,
            result,
            measuredQuantity: validated.outcomeDetails?.measuredQuantity ?? null,
            errorCode: validated.outcomeDetails?.errorCode || null,
            errorMessage: validated.outcomeDetails?.errorMessage || null,
            metadata: {
                mqtt: true,
                protocolVersion: validated.protocolVersion,
                controllerId: validated.controllerId,
                barnId: validated.barnId,
                feederId: validated.feederId,
                controllerBootId: validated.controllerBootId,
                controllerJournalSequence: validated.controllerJournalSequence,
                assignmentGeneration: validated.assignmentGeneration,
                correlationId: validated.correlationId
            }
        });
    }

    receiveControllerState(topic, parsedTopic, envelope, heartbeat) {
        const messageType = heartbeat
            ? "CONTROLLER_HEARTBEAT" : "CONTROLLER_STATUS";
        const controller = this.store.requireController(parsedTopic.controllerId);
        const validated = validateControllerStateEnvelope(envelope, {
            verifier: this.security.controllerVerifier,
            messageType,
            expectedControllerId: parsedTopic.controllerId,
            expectedBarnId: controller.barnId,
            now: this.clock(),
            clockDriftToleranceMs: this.config.mqttClockDriftToleranceMs
        });
        const messageId = heartbeat
            ? validated.heartbeatId : validated.statusId;
        const replay = this.store.recordInboundMessage({
            controllerId: validated.controllerId,
            messageType,
            messageId,
            controllerBootId: validated.controllerBootId,
            controllerSequence: validated.sequence,
            receivedAt: this.clock().toISOString()
        });
        if (replay.duplicate) {
            this.increment("duplicateDelivery");
            return;
        }
        const connectionState = heartbeat || validated.status === "ONLINE"
            ? "ONLINE" : "OFFLINE";
        if (!heartbeat && validated.status === "OFFLINE") {
            this.store.setConnectionState(
                validated.controllerId,
                "OFFLINE",
                this.clock().toISOString()
            );
            this.increment("controllerOffline");
            return;
        }
        const update = this.store.updateControllerProtocolState(
            validated.controllerId,
            validated,
            {
                connectionState,
                heartbeat,
                timestamp: this.clock().toISOString()
            }
        );
        if (!heartbeat && validated.edgeStatus && !update.stale) {
            this.store.recordEdgeStatus(
                validated.controllerId,
                validated,
                this.clock().toISOString()
            );
        }
        if (update.stale) {
            this.recordEvent({
                eventType: "STALE_CONTROLLER_STATE",
                severity: "WARN",
                code: "MQTT_CONTROLLER_SEQUENCE_STALE",
                controllerId: validated.controllerId,
                topic
            });
        }
        if (connectionState === "OFFLINE") {
            this.increment("controllerOffline");
        }
    }

    async publishAuthorityState() {
        const controllers = this.store.getControllers();
        await Promise.all(controllers.map(controller => (
            this.publishAssignments(controller.controllerId)
        )));
        await this.publishSafetySnapshot();
    }

    async publishAssignments(controllerId) {
        if (!this.connected) {
            return;
        }
        const controller = this.store.requireController(controllerId);
        const occurredAtDate = this.clock();
        const assignments = controller.assignments.map(item => ({
            ...item,
            enabled: controller.enabled && !controller.revokedAt
        }));
        const latestExpiry = assignments.reduce((latest, item) => Math.max(
            latest,
            Date.parse(item.authorityLeaseExpiresAt) || 0
        ), occurredAtDate.getTime() + this.config.mqttAuthorityLeaseMs);
        const envelope = createAssignmentEnvelope({
            controllerId,
            barnId: controller.barnId,
            assignments,
            occurredAt: occurredAtDate.toISOString(),
            expiresAt: new Date(latestExpiry).toISOString(),
            signer: this.security.serverSigner
        });
        await this.publish(this.topics.assignments(controllerId), envelope, {
            qos: 1,
            retain: true,
            messageExpiryInterval: Math.max(
                1,
                Math.ceil((latestExpiry - occurredAtDate.getTime()) / 1000)
            )
        });
    }

    setSafetyService(safetyService) {
        this.removeSafetyListener?.();
        this.safetyService = safetyService;
        this.removeSafetyListener = safetyService?.addStateListener?.(change => {
            if (change?.type === "ACTIVATED") {
                this.increment("emergencyStop");
                this.recordEvent({
                    eventType: "EMERGENCY_STOP",
                    severity: "WARN",
                    code: "MQTT_EMERGENCY_STOP_ACTIVATED",
                    details: {
                        level: change.stop?.level,
                        barnId: change.stop?.barnId,
                        feederId: change.stop?.feederId
                    }
                });
            }
            return this.connected ? this.publishSafetySnapshot() : undefined;
        });
        if (this.connected) {
            void this.publishSafetySnapshot();
        }
    }

    async publishSafetySnapshot() {
        if (!this.connected || !this.safetyService) {
            return;
        }
        const resources = this.store.eventStore.getResources();
        const activeStops = this.safetyService.getActiveStops();
        const scopes = [
            { scopeKey: "PLATFORM", level: "PLATFORM", barnId: null, feederId: null },
            ...resources.barns.map(barn => ({
                scopeKey: `BARN:${barn.barnId}`,
                level: "BARN",
                barnId: barn.barnId,
                feederId: null
            })),
            ...resources.feeders.map(feeder => ({
                scopeKey: `FEEDER:${feeder.feederId}`,
                level: "FEEDER",
                barnId: feeder.barnId,
                feederId: feeder.feederId
            }))
        ];
        await Promise.all(scopes.map(async scope => {
            const stop = activeStops.find(item => (
                item.level === scope.level
                && item.barnId === scope.barnId
                && item.feederId === scope.feederId
            ));
            const current = this.store.getSafetyState(scope.scopeKey);
            const desiredActive = Boolean(stop);
            const state = !current || current.active !== desiredActive
                || current.reason !== (stop?.reason || null)
                ? this.store.updateSafetyState({
                    ...scope,
                    active: desiredActive,
                    reason: stop?.reason || null,
                    timestamp: this.clock().toISOString()
                })
                : current;
            const occurredAt = this.clock();
            const expiresAt = new Date(
                occurredAt.getTime() + Math.max(
                    this.config.mqttOfflineThresholdMs * 2,
                    this.config.mqttAuthorityLeaseMs
                )
            ).toISOString();
            const envelope = createSafetyEnvelope({
                ...scope,
                active: state.active,
                reason: state.reason,
                generation: state.generation,
                occurredAt: occurredAt.toISOString(),
                expiresAt,
                signer: this.security.serverSigner
            });
            const topic = scope.level === "PLATFORM"
                ? this.topics.platformSafety()
                : scope.level === "BARN"
                    ? this.topics.barnSafety(scope.barnId)
                    : this.topics.feederSafety(scope.feederId);
            await this.publish(topic, envelope, {
                qos: 1,
                retain: true,
                messageExpiryInterval: Math.max(
                    1,
                    Math.ceil((Date.parse(expiresAt) - occurredAt.getTime()) / 1000)
                )
            });
        }));
    }

    async reconcile(command) {
        const journal = this.store.getJournalForCommand(command.commandId);
        if (journal?.executionState === "COMPLETED" && journal.finalAcknowledgement) {
            return { outcome: "PROCESSED", acknowledgement: journal.finalAcknowledgement };
        }
        if (journal?.dispensePerformed || journal?.executionState === "OUTCOME_UNKNOWN") {
            return { outcome: "UNKNOWN", acknowledgement: null };
        }
        const acknowledgements = this.deviceCommandStore
            .getAcknowledgementsForCommand(command.commandId);
        const completed = acknowledgements.find(item => item.result === "SUCCEEDED");
        if (completed) {
            return { outcome: "PROCESSED", acknowledgement: completed };
        }
        if (acknowledgements.some(item => item.result === "STARTED")) {
            return { outcome: "UNKNOWN", acknowledgement: null };
        }
        const deliveries = this.store.getOutboundDeliveries(command.commandId);
        if (deliveries.length > 0 && deliveries.every(item => item.state === "FAILED")) {
            return { outcome: "CONFIRMED_NOT_PROCESSED", acknowledgement: null };
        }
        return { outcome: "UNKNOWN", acknowledgement: null };
    }

    getConnectionStatus() {
        const controllerStates = this.store.getControllers().reduce(
            (summary, controller) => {
                summary[controller.status] = Number(summary[controller.status] || 0) + 1;
                return summary;
            }, {}
        );
        return {
            transportType: "mqtt",
            protocolVersion: this.config.mqttProtocolVersion,
            state: this.connected ? "CONNECTED" : this.started ? "RECONNECTING" : "DISCONNECTED",
            connected: this.connected,
            reconnectCount: this.reconnectCount,
            lastConnectedAt: this.lastConnectedAt,
            lastDisconnectedAt: this.lastDisconnectedAt,
            lastError: this.lastError,
            metrics: { ...this.metrics },
            controllerStates,
            simulatedControllerMetrics: Object.fromEntries(
                [...this.simulatedControllers.entries()].map(([id, controller]) => (
                    [id, { ...controller.metrics }]
                ))
            )
        };
    }

    increment(name) {
        this.metrics[name] = Number(this.metrics[name] || 0) + 1;
    }

    ensureSimulatedController(controllerId) {
        if (!this.simulatedControllerFactory) {
            return null;
        }
        if (!this.simulatedControllers.has(controllerId)) {
            const controller = this.simulatedControllerFactory(controllerId);
            this.simulatedControllers.set(controllerId, controller);
            controller.start();
        }
        return this.simulatedControllers.get(controllerId);
    }

    restartController(controllerId) {
        const current = this.simulatedControllers.get(controllerId);
        void current?.shutdown({ force: true });
        this.simulatedControllers.delete(controllerId);
        const restarted = this.ensureSimulatedController(controllerId);
        return {
            controller: this.store.requireController(controllerId),
            uncertainCommandIds: this.store.getIncompleteJournals()
                .filter(item => item.controllerId === controllerId)
                .filter(item => item.dispensePerformed)
                .map(item => item.commandId),
            runtime: restarted
        };
    }

    recordEvent(input) {
        try {
            this.store.recordProtocolEvent(input);
        } catch (error) {
            if (!this.store.eventStore.closed) {
                this.logger?.warn?.({ err: error }, "Could not persist MQTT protocol event");
            }
        }
    }

    reportError(error, context = {}) {
        this.lastError = {
            code: error?.code || "MQTT_TRANSPORT_ERROR",
            message: String(error?.message || error),
            occurredAt: this.clock().toISOString()
        };
        this.onTransportError({ ...context, error });
    }

    classifyProtocolError(error) {
        const code = String(error?.code || "");
        if (code.includes("SIGNATURE") || code.includes("SIGNING_KEY")) {
            return { eventType: "SIGNATURE_FAILURE", counter: "signatureFailure" };
        }
        if (code.includes("FENCING") || code.includes("GENERATION_STALE")) {
            return { eventType: "FENCING_TOKEN_FAILURE", counter: "fencingFailure" };
        }
        if (code.includes("AUTHORITY_LEASE_EXPIRED")) {
            return {
                eventType: "AUTHORITY_LEASE_EXPIRY",
                counter: "authorityLeaseExpiry"
            };
        }
        if (code.includes("COMMAND_EXPIRED")) {
            return { eventType: "COMMAND_EXPIRY", counter: "commandExpiry" };
        }
        if (code.includes("AUTH") || code.includes("IDENTITY")) {
            return { eventType: "AUTHENTICATION_FAILURE", counter: "authenticationFailure" };
        }
        return { eventType: "MALFORMED_CONTROLLER_MESSAGE", counter: "malformedMessage" };
    }

    async shutdown() {
        this.started = false;
        this.connected = false;
        this.removeSafetyListener?.();
        this.removeSafetyListener = null;
        await Promise.allSettled(
            [...this.simulatedControllers.values()].map(controller => (
                controller.shutdown()
            ))
        );
        this.simulatedControllers.clear();
        if (!this.client) {
            return;
        }
        const client = this.client;
        this.client = null;
        await new Promise(resolve => client.end(false, {}, resolve));
    }
}
