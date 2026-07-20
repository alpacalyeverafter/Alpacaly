import { randomUUID } from "node:crypto";

export const DEVICE_COMMAND_TYPES = Object.freeze([
    "RING_BELL",
    "DISPENSE_FEED"
]);

export const DEVICE_COMMAND_STATES = Object.freeze([
    "PENDING",
    "READY",
    "SENT",
    "ACKNOWLEDGED",
    "RETRY_SCHEDULED",
    "TIMED_OUT",
    "FAILED",
    "OUTCOME_UNKNOWN",
    "CANCELLED"
]);

export const DEVICE_ACKNOWLEDGEMENT_RESULTS = Object.freeze([
    "ACCEPTED",
    "STARTED",
    "SUCCEEDED",
    "REJECTED",
    "FAILED"
]);

export const TERMINAL_DEVICE_COMMAND_STATES = Object.freeze([
    "ACKNOWLEDGED",
    "FAILED",
    "OUTCOME_UNKNOWN",
    "CANCELLED"
]);

function requireText(value, name) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
        throw new Error(`${name} is required.`);
    }
    return normalized;
}

function requireTimestamp(value, name, { nullable = false } = {}) {
    if ((value === null || value === undefined) && nullable) {
        return null;
    }
    const normalized = requireText(value, name);
    if (Number.isNaN(Date.parse(normalized))) {
        throw new Error(`${name} must be an ISO-compatible timestamp.`);
    }
    return normalized;
}

function requireEnum(value, values, name) {
    const normalized = requireText(value, name).toUpperCase();
    if (!values.includes(normalized)) {
        throw new Error(`${name} is not supported.`);
    }
    return normalized;
}

function immutableId(prefix, value, idGenerator) {
    return value
        ? requireText(value, `${prefix}Id`)
        : `${prefix}_${idGenerator()}`;
}

export function createDeviceCommand(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    const now = requireTimestamp(
        input?.createdAt || clock().toISOString(),
        "createdAt"
    );
    const maximumAttempts = Number(input?.maximumAttempts);
    if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1) {
        throw new Error("maximumAttempts must be a positive safe integer.");
    }

    return Object.freeze({
        commandId: immutableId("command", input?.commandId, idGenerator),
        eventId: requireText(input?.eventId, "eventId"),
        barnId: requireText(input?.barnId, "barnId"),
        feederId: requireText(input?.feederId, "feederId"),
        deviceId: requireText(input?.deviceId, "deviceId"),
        commandType: requireEnum(
            input?.commandType,
            DEVICE_COMMAND_TYPES,
            "commandType"
        ),
        commandPayload: input?.commandPayload ?? null,
        idempotencyKey: requireText(input?.idempotencyKey, "idempotencyKey"),
        fencingToken: input?.fencingToken ?? null,
        status: requireEnum(
            input?.status || "PENDING",
            DEVICE_COMMAND_STATES,
            "status"
        ),
        attemptCount: Number(input?.attemptCount || 0),
        maximumAttempts,
        acknowledgementDeadline: requireTimestamp(
            input?.acknowledgementDeadline,
            "acknowledgementDeadline",
            { nullable: true }
        ),
        nextAttemptAt: requireTimestamp(
            input?.nextAttemptAt || now,
            "nextAttemptAt"
        ),
        createdAt: now,
        sentAt: requireTimestamp(input?.sentAt, "sentAt", { nullable: true }),
        acknowledgedAt: requireTimestamp(
            input?.acknowledgedAt,
            "acknowledgedAt",
            { nullable: true }
        ),
        completedAt: requireTimestamp(
            input?.completedAt,
            "completedAt",
            { nullable: true }
        ),
        failedAt: requireTimestamp(input?.failedAt, "failedAt", { nullable: true }),
        lastError: input?.lastError ? String(input.lastError).slice(0, 1000) : null,
        updatedAt: requireTimestamp(input?.updatedAt || now, "updatedAt"),
        replacementOfCommandId: input?.replacementOfCommandId
            ? requireText(input.replacementOfCommandId, "replacementOfCommandId")
            : null,
        resolutionCaseId: input?.resolutionCaseId
            ? requireText(input.resolutionCaseId, "resolutionCaseId")
            : null
    });
}

export function createDeviceAcknowledgement(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    const receivedAt = requireTimestamp(
        input?.receivedAt || clock().toISOString(),
        "receivedAt"
    );
    const measuredQuantity = input?.measuredQuantity === null
        || input?.measuredQuantity === undefined
        ? null
        : Number(input.measuredQuantity);
    if (
        measuredQuantity !== null
        && (!Number.isFinite(measuredQuantity) || measuredQuantity < 0)
    ) {
        throw new Error("measuredQuantity must be a non-negative number when provided.");
    }

    return Object.freeze({
        acknowledgementId: immutableId(
            "device_ack",
            input?.acknowledgementId,
            idGenerator
        ),
        commandId: requireText(input?.commandId, "commandId"),
        deviceId: requireText(input?.deviceId, "deviceId"),
        acknowledgementType: requireText(
            input?.acknowledgementType,
            "acknowledgementType"
        ).toUpperCase(),
        receivedAt,
        deviceTimestamp: requireTimestamp(
            input?.deviceTimestamp || receivedAt,
            "deviceTimestamp"
        ),
        result: requireEnum(
            input?.result,
            DEVICE_ACKNOWLEDGEMENT_RESULTS,
            "result"
        ),
        measuredQuantity,
        errorCode: input?.errorCode ? String(input.errorCode).trim() : null,
        errorMessage: input?.errorMessage
            ? String(input.errorMessage).slice(0, 1000)
            : null,
        metadata: input?.metadata ?? null
    });
}

export function isTerminalDeviceCommandState(status) {
    return TERMINAL_DEVICE_COMMAND_STATES.includes(status);
}
