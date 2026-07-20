import { randomUUID } from "node:crypto";

export const DEFAULT_SIMULATED_CONTROLLER_ID =
    "controller_simulated_default_barn";

export const CONTROLLER_CONNECTION_STATES = Object.freeze([
    "ONLINE",
    "OFFLINE"
]);

export const CONTROLLER_EFFECTIVE_STATES = Object.freeze([
    "ONLINE",
    "OFFLINE",
    "STALE",
    "DISABLED"
]);

export const CONTROLLER_EXECUTION_STATES = Object.freeze([
    "RECEIVED",
    "ACCEPTED",
    "STARTED",
    "COMPLETED",
    "REJECTED",
    "FAILED",
    "OUTCOME_UNKNOWN"
]);

export const SIMULATION_BEHAVIOUR_MODES = Object.freeze([
    "NORMAL",
    "DUPLICATE_ACKNOWLEDGEMENT",
    "ACKNOWLEDGEMENT_LOSS",
    "COMMAND_REJECTION",
    "FAIL_BEFORE_DISPENSE",
    "FAIL_AFTER_DISPENSE",
    "DISCONNECT_BEFORE_RECEIPT",
    "DISCONNECT_DURING_EXECUTION",
    "RESTART_DURING_EXECUTION",
    "HEARTBEAT_LOSS",
    "MALFORMED_ACKNOWLEDGEMENT",
    "WRONG_CONTROLLER_IDENTITY",
    "WRONG_FEEDER_IDENTITY"
]);

function requireText(value, name, maximumLength = 1000) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
        throw new Error(`${name} is required.`);
    }
    return normalized.slice(0, maximumLength);
}

function requireTimestamp(value, name) {
    const normalized = requireText(value, name, 100);
    if (Number.isNaN(Date.parse(normalized))) {
        throw new Error(`${name} must be an ISO-compatible timestamp.`);
    }
    return normalized;
}

function nonNegativeInteger(value, name, fallback = 0) {
    const number = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(number) || number < 0) {
        throw new Error(`${name} must be a non-negative integer.`);
    }
    return number;
}

export function normalizeSimulationBehaviour(input = {}) {
    const mode = String(input.mode || "NORMAL").trim().toUpperCase();
    if (!SIMULATION_BEHAVIOUR_MODES.includes(mode)) {
        throw new Error("Simulation behaviour mode is not supported.");
    }
    return Object.freeze({
        mode,
        acknowledgementDelayMs: nonNegativeInteger(
            input.acknowledgementDelayMs,
            "acknowledgementDelayMs"
        ),
        completionDelayMs: nonNegativeInteger(
            input.completionDelayMs,
            "completionDelayMs"
        )
    });
}

export function createSimulatedController(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    const createdAt = requireTimestamp(
        input?.createdAt || clock().toISOString(),
        "createdAt"
    );
    const connectionState = String(input?.connectionState || "ONLINE")
        .trim().toUpperCase();
    if (!CONTROLLER_CONNECTION_STATES.includes(connectionState)) {
        throw new Error("connectionState is not supported.");
    }
    return Object.freeze({
        controllerId: input?.controllerId
            ? requireText(input.controllerId, "controllerId", 256)
            : `controller_${idGenerator()}`,
        barnId: requireText(input?.barnId, "barnId", 256),
        name: requireText(input?.name, "name", 256),
        enabled: input?.enabled !== false,
        softwareVersion: requireText(
            input?.softwareVersion || "phase-7c-simulator",
            "softwareVersion",
            100
        ),
        protocolVersion: requireText(
            input?.protocolVersion || "1.0",
            "protocolVersion",
            100
        ),
        lastSeenAt: input?.lastSeenAt
            ? requireTimestamp(input.lastSeenAt, "lastSeenAt")
            : null,
        connectionState,
        simulationBehaviour: normalizeSimulationBehaviour(
            input?.simulationBehaviour
        ),
        createdAt,
        updatedAt: requireTimestamp(input?.updatedAt || createdAt, "updatedAt")
    });
}
