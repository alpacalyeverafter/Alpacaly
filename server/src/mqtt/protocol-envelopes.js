import { randomUUID } from "node:crypto";

export const MQTT_PROTOCOL_VERSION = "1.0";
export const MQTT_COMMAND_ACTIONS = Object.freeze(["RING_BELL", "DISPENSE_FEED"]);
export const MQTT_ACKNOWLEDGEMENT_STATUSES = Object.freeze([
    "RECEIVED",
    "ACCEPTED",
    "STARTED",
    "COMPLETED",
    "REJECTED",
    "FAILED",
    "OUTCOME_UNKNOWN"
]);

export class MqttProtocolError extends Error {
    constructor(message, code = "MQTT_MESSAGE_MALFORMED", details = null) {
        super(message);
        this.name = "MqttProtocolError";
        this.code = code;
        this.details = details;
        this.terminalFailure = true;
    }
}

function requireObject(value, name) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new MqttProtocolError(`${name} must be an object.`);
    }
    return value;
}

function requireText(value, name, maximum = 1000) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
        throw new MqttProtocolError(`${name} is required.`);
    }
    return normalized.slice(0, maximum);
}

function optionalText(value, maximum = 1000) {
    return value === null || value === undefined || value === ""
        ? null : requireText(String(value), "value", maximum);
}

function requireTimestamp(value, name) {
    const normalized = requireText(value, name, 100);
    if (!Number.isFinite(Date.parse(normalized))) {
        throw new MqttProtocolError(`${name} must be an ISO-compatible timestamp.`);
    }
    return normalized;
}

function positiveInteger(value, name) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) {
        throw new MqttProtocolError(`${name} must be a positive safe integer.`);
    }
    return number;
}

function assertBase(envelope, messageType) {
    requireObject(envelope, "envelope");
    if (envelope.protocolVersion !== MQTT_PROTOCOL_VERSION) {
        throw new MqttProtocolError(
            "Protocol version is unsupported.",
            "MQTT_PROTOCOL_VERSION_UNSUPPORTED"
        );
    }
    if (envelope.messageType !== messageType) {
        throw new MqttProtocolError(
            `Expected ${messageType} message.`,
            "MQTT_MESSAGE_TYPE_INVALID"
        );
    }
    requireObject(envelope.signatureMetadata, "signatureMetadata");
    requireText(envelope.signature, "signature", 4096);
}

function assertIdentity(actual, expected, name) {
    if (expected !== undefined && expected !== null && actual !== expected) {
        throw new MqttProtocolError(
            `${name} does not match the authorised resource.`,
            "MQTT_MESSAGE_IDENTITY_MISMATCH",
            { name }
        );
    }
}

export function createCommandEnvelope(command, {
    controllerId,
    assignmentGeneration,
    authorityLeaseExpiresAt,
    expiresAt,
    correlationId = command.eventId,
    deliveryId = `delivery_${randomUUID()}`,
    signer,
    issuedAt
}) {
    return signer.sign({
        protocolVersion: MQTT_PROTOCOL_VERSION,
        messageType: "DEVICE_COMMAND",
        commandId: command.commandId,
        eventId: command.eventId || null,
        controllerId,
        barnId: command.barnId,
        feederId: command.feederId,
        deviceId: command.deviceId,
        action: command.commandType,
        parameters: command.commandPayload ?? null,
        issuedAt,
        expiresAt,
        deliveryId,
        assignmentGeneration,
        fencingToken: command.fencingToken,
        authorityLeaseExpiresAt,
        correlationId
    });
}

export function validateCommandEnvelope(envelope, {
    verifier,
    expectedControllerId,
    expectedBarnId,
    expectedFeederId,
    currentAssignmentGeneration,
    now = new Date(),
    clockDriftToleranceMs = 0
}) {
    assertBase(envelope, "DEVICE_COMMAND");
    requireText(envelope.commandId, "commandId", 256);
    requireText(envelope.controllerId, "controllerId", 256);
    requireText(envelope.barnId, "barnId", 256);
    requireText(envelope.feederId, "feederId", 256);
    requireText(envelope.deviceId, "deviceId", 256);
    requireText(envelope.deliveryId, "deliveryId", 256);
    requireText(envelope.correlationId, "correlationId", 256);
    const action = requireText(envelope.action, "action", 100).toUpperCase();
    if (!MQTT_COMMAND_ACTIONS.includes(action)) {
        throw new MqttProtocolError(
            "Command action is not authorised.",
            "MQTT_COMMAND_ACTION_INVALID"
        );
    }
    const issuedAt = requireTimestamp(envelope.issuedAt, "issuedAt");
    const expiresAt = requireTimestamp(envelope.expiresAt, "expiresAt");
    const authorityLeaseExpiresAt = requireTimestamp(
        envelope.authorityLeaseExpiresAt,
        "authorityLeaseExpiresAt"
    );
    const generation = positiveInteger(
        envelope.assignmentGeneration,
        "assignmentGeneration"
    );
    positiveInteger(envelope.fencingToken, "fencingToken");
    requireObject(envelope.parameters ?? {}, "parameters");
    assertIdentity(envelope.controllerId, expectedControllerId, "controllerId");
    assertIdentity(envelope.barnId, expectedBarnId, "barnId");
    assertIdentity(envelope.feederId, expectedFeederId, "feederId");
    if (
        currentAssignmentGeneration !== undefined
        && generation !== currentAssignmentGeneration
    ) {
        throw new MqttProtocolError(
            "Command assignment generation is stale.",
            "MQTT_FENCING_GENERATION_STALE"
        );
    }
    const current = now.getTime();
    if (Date.parse(issuedAt) > current + clockDriftToleranceMs) {
        throw new MqttProtocolError(
            "Command issuedAt is beyond clock-drift tolerance.",
            "MQTT_COMMAND_CLOCK_INVALID"
        );
    }
    if (Date.parse(expiresAt) <= current) {
        throw new MqttProtocolError("Command has expired.", "MQTT_COMMAND_EXPIRED");
    }
    if (Date.parse(authorityLeaseExpiresAt) <= current) {
        throw new MqttProtocolError(
            "Controller authority lease has expired.",
            "MQTT_AUTHORITY_LEASE_EXPIRED"
        );
    }
    verifier.verify(envelope);
    return envelope;
}

export function createAcknowledgementEnvelope({
    acknowledgement,
    status,
    command,
    controllerId,
    controllerBootId,
    controllerJournalSequence,
    assignmentGeneration,
    correlationId = command.eventId,
    outcomeDetails = null,
    signer,
    occurredAt = acknowledgement?.receivedAt
}) {
    return signer.sign({
        protocolVersion: MQTT_PROTOCOL_VERSION,
        messageType: "DEVICE_ACKNOWLEDGEMENT",
        acknowledgementId: acknowledgement?.acknowledgementId
            || `controller_ack_${command.commandId}_${status.toLowerCase()}`,
        commandId: command.commandId,
        controllerId,
        barnId: command.barnId,
        feederId: command.feederId,
        deviceId: command.deviceId,
        controllerBootId,
        controllerJournalSequence,
        assignmentGeneration,
        status,
        occurredAt,
        correlationId,
        outcomeDetails: outcomeDetails || {
            measuredQuantity: acknowledgement?.measuredQuantity ?? null,
            errorCode: acknowledgement?.errorCode || null,
            errorMessage: acknowledgement?.errorMessage || null
        }
    });
}

export function validateAcknowledgementEnvelope(envelope, {
    verifier,
    expectedControllerId,
    expectedBarnId,
    expectedFeederId,
    expectedAssignmentGeneration,
    now = new Date(),
    clockDriftToleranceMs = 0
}) {
    assertBase(envelope, "DEVICE_ACKNOWLEDGEMENT");
    ["acknowledgementId", "commandId", "controllerId", "barnId", "feederId",
        "deviceId", "controllerBootId", "correlationId"]
        .forEach(name => requireText(envelope[name], name, 256));
    const sequence = positiveInteger(
        envelope.controllerJournalSequence,
        "controllerJournalSequence"
    );
    const generation = positiveInteger(
        envelope.assignmentGeneration,
        "assignmentGeneration"
    );
    const status = requireText(envelope.status, "status", 100).toUpperCase();
    if (!MQTT_ACKNOWLEDGEMENT_STATUSES.includes(status)) {
        throw new MqttProtocolError(
            "Acknowledgement status is unsupported.",
            "MQTT_ACKNOWLEDGEMENT_STATUS_INVALID"
        );
    }
    const occurredAt = requireTimestamp(envelope.occurredAt, "occurredAt");
    if (Date.parse(occurredAt) > now.getTime() + clockDriftToleranceMs) {
        throw new MqttProtocolError(
            "Acknowledgement timestamp exceeds clock-drift tolerance.",
            "MQTT_ACKNOWLEDGEMENT_CLOCK_INVALID"
        );
    }
    requireObject(envelope.outcomeDetails ?? {}, "outcomeDetails");
    assertIdentity(envelope.controllerId, expectedControllerId, "controllerId");
    assertIdentity(envelope.barnId, expectedBarnId, "barnId");
    assertIdentity(envelope.feederId, expectedFeederId, "feederId");
    if (
        expectedAssignmentGeneration !== undefined
        && generation !== expectedAssignmentGeneration
    ) {
        throw new MqttProtocolError(
            "Acknowledgement assignment generation is stale.",
            "MQTT_ACKNOWLEDGEMENT_FENCING_STALE"
        );
    }
    verifier.verify(envelope);
    return { ...envelope, status, controllerJournalSequence: sequence };
}

export function createHeartbeatEnvelope({
    controllerId,
    barnId,
    controllerBootId,
    bootCounter,
    sequence,
    occurredAt,
    expiresAt,
    signer
}) {
    return signer.sign({
        protocolVersion: MQTT_PROTOCOL_VERSION,
        messageType: "CONTROLLER_HEARTBEAT",
        heartbeatId: `heartbeat_${controllerBootId}_${sequence}`,
        controllerId,
        barnId,
        controllerBootId,
        bootCounter,
        sequence,
        occurredAt,
        expiresAt
    });
}

export function createStatusEnvelope({
    controllerId,
    barnId,
    controllerBootId,
    bootCounter,
    sequence,
    status,
    occurredAt,
    expiresAt,
    signer,
    edgeStatus = null
}) {
    return signer.sign({
        protocolVersion: MQTT_PROTOCOL_VERSION,
        messageType: "CONTROLLER_STATUS",
        statusId: `status_${controllerBootId}_${sequence}_${status.toLowerCase()}`,
        controllerId,
        barnId,
        controllerBootId,
        bootCounter,
        sequence,
        status,
        occurredAt,
        expiresAt,
        ...(edgeStatus ? { edgeStatus } : {})
    });
}

export function validateControllerStateEnvelope(envelope, {
    verifier,
    messageType,
    expectedControllerId,
    expectedBarnId,
    now = new Date(),
    clockDriftToleranceMs = 0
}) {
    assertBase(envelope, messageType);
    const idName = messageType === "CONTROLLER_HEARTBEAT"
        ? "heartbeatId" : "statusId";
    [idName, "controllerId", "barnId", "controllerBootId"]
        .forEach(name => requireText(envelope[name], name, 256));
    positiveInteger(envelope.bootCounter, "bootCounter");
    positiveInteger(envelope.sequence, "sequence");
    const occurredAt = requireTimestamp(envelope.occurredAt, "occurredAt");
    const expiresAt = requireTimestamp(envelope.expiresAt, "expiresAt");
    if (Date.parse(occurredAt) > now.getTime() + clockDriftToleranceMs) {
        throw new MqttProtocolError(
            "Controller timestamp exceeds clock-drift tolerance.",
            "MQTT_CONTROLLER_CLOCK_INVALID"
        );
    }
    if (Date.parse(expiresAt) <= now.getTime()) {
        throw new MqttProtocolError(
            "Controller state message has expired.",
            "MQTT_CONTROLLER_STATE_EXPIRED"
        );
    }
    assertIdentity(envelope.controllerId, expectedControllerId, "controllerId");
    assertIdentity(envelope.barnId, expectedBarnId, "barnId");
    if (messageType === "CONTROLLER_STATUS") {
        const status = requireText(envelope.status, "status", 100).toUpperCase();
        if (!["ONLINE", "OFFLINE", "STALE", "DISABLED", "REVOKED"].includes(status)) {
            throw new MqttProtocolError(
                "Controller status is unsupported.",
                "MQTT_CONTROLLER_STATUS_INVALID"
            );
        }
        if (envelope.edgeStatus !== undefined) {
            requireObject(envelope.edgeStatus, "edgeStatus");
        }
    }
    verifier.verify(envelope);
    return envelope;
}

export function createAssignmentEnvelope({
    controllerId,
    barnId,
    assignments,
    occurredAt,
    expiresAt,
    signer
}) {
    return signer.sign({
        protocolVersion: MQTT_PROTOCOL_VERSION,
        messageType: "CONTROLLER_ASSIGNMENT",
        assignmentId: `assignment_${controllerId}_${Math.max(
            0,
            ...assignments.map(item => item.assignmentGeneration)
        )}`,
        controllerId,
        barnId,
        assignments: assignments.map(item => ({
            feederId: item.feederId,
            assignmentGeneration: item.assignmentGeneration,
            authorityLeaseExpiresAt: item.authorityLeaseExpiresAt,
            enabled: item.enabled !== false
        })),
        occurredAt,
        expiresAt
    });
}

export function createSafetyEnvelope({
    level,
    barnId = null,
    feederId = null,
    active,
    reason = null,
    generation,
    occurredAt,
    expiresAt,
    signer
}) {
    return signer.sign({
        protocolVersion: MQTT_PROTOCOL_VERSION,
        messageType: "SAFETY_STATE",
        safetyStateId: `safety_${level.toLowerCase()}_${barnId || feederId || "platform"}_${generation}`,
        level,
        barnId,
        feederId,
        active: active === true,
        reason: optionalText(reason),
        generation,
        occurredAt,
        expiresAt
    });
}

export function validateServerStateEnvelope(envelope, {
    verifier,
    messageType,
    expectedControllerId,
    expectedBarnId,
    expectedFeederId,
    now = new Date()
}) {
    assertBase(envelope, messageType);
    requireTimestamp(envelope.occurredAt, "occurredAt");
    const expiresAt = requireTimestamp(envelope.expiresAt, "expiresAt");
    if (Date.parse(expiresAt) <= now.getTime()) {
        throw new MqttProtocolError(
            "Retained authority state has expired.",
            "MQTT_RETAINED_STATE_EXPIRED"
        );
    }
    if (messageType === "CONTROLLER_ASSIGNMENT") {
        requireText(envelope.assignmentId, "assignmentId", 256);
        assertIdentity(envelope.controllerId, expectedControllerId, "controllerId");
        assertIdentity(envelope.barnId, expectedBarnId, "barnId");
        if (!Array.isArray(envelope.assignments)) {
            throw new MqttProtocolError("assignments must be an array.");
        }
        envelope.assignments.forEach(assignment => {
            requireText(assignment.feederId, "feederId", 256);
            positiveInteger(assignment.assignmentGeneration, "assignmentGeneration");
            requireTimestamp(
                assignment.authorityLeaseExpiresAt,
                "authorityLeaseExpiresAt"
            );
        });
    } else {
        requireText(envelope.safetyStateId, "safetyStateId", 256);
        positiveInteger(envelope.generation, "generation");
        if (!["PLATFORM", "BARN", "FEEDER"].includes(envelope.level)) {
            throw new MqttProtocolError("Safety level is unsupported.");
        }
        if (envelope.level === "BARN") {
            assertIdentity(envelope.barnId, expectedBarnId, "barnId");
        }
        if (envelope.level === "FEEDER") {
            assertIdentity(envelope.feederId, expectedFeederId, "feederId");
        }
    }
    verifier.verify(envelope);
    return envelope;
}
