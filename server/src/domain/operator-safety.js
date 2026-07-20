import { randomUUID } from "node:crypto";

export const EMERGENCY_STOP_LEVELS = Object.freeze([
    "PLATFORM",
    "BARN",
    "FEEDER"
]);

export const APPROVAL_REQUEST_STATUSES = Object.freeze([
    "PENDING",
    "PARTIALLY_APPROVED",
    "APPROVED",
    "REJECTED",
    "EXPIRED",
    "CANCELLED",
    "EXECUTED",
    "EXECUTION_FAILED"
]);

export const APPROVAL_DECISIONS = Object.freeze(["APPROVE", "REJECT"]);

export const APPROVAL_AUTHORITIES = Object.freeze([
    "WELFARE",
    "HARDWARE",
    "PLATFORM_ADMIN"
]);

export const OPERATOR_RESOLUTIONS = Object.freeze([
    "CONFIRMED_DISPENSED",
    "CONFIRMED_NOT_DISPENSED",
    "CANCELLED_FOR_WELFARE",
    "MANUAL_REVIEW_REQUIRED"
]);

function requireText(value, name, maximumLength = 1000) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
        throw new Error(`${name} is required.`);
    }
    return normalized.slice(0, maximumLength);
}

function optionalText(value, maximumLength = 1000) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    return String(value).trim().slice(0, maximumLength) || null;
}

function requireTimestamp(value, name, clock) {
    const normalized = requireText(value || clock().toISOString(), name, 100);
    if (Number.isNaN(Date.parse(normalized))) {
        throw new Error(`${name} must be an ISO-compatible timestamp.`);
    }
    return normalized;
}

function requireEnum(value, values, name) {
    const normalized = requireText(value, name, 100).toUpperCase();
    if (!values.includes(normalized)) {
        throw new Error(`${name} is not supported.`);
    }
    return normalized;
}

function immutableId(prefix, value, idGenerator) {
    return value
        ? requireText(value, `${prefix}Id`, 256)
        : `${prefix}_${idGenerator()}`;
}

export function createEmergencyStop(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    const level = requireEnum(input?.level, EMERGENCY_STOP_LEVELS, "level");
    const barnId = optionalText(input?.barnId, 256);
    const feederId = optionalText(input?.feederId, 256);
    if (level === "PLATFORM" && (barnId || feederId)) {
        throw new Error("Platform emergency stops cannot specify Barn or Feeder IDs.");
    }
    if (level === "BARN" && (!barnId || feederId)) {
        throw new Error("Barn emergency stops require only barnId.");
    }
    if (level === "FEEDER" && (!barnId || !feederId)) {
        throw new Error("Feeder emergency stops require barnId and feederId.");
    }
    return Object.freeze({
        emergencyStopId: immutableId("emergency_stop", input?.emergencyStopId, idGenerator),
        level,
        barnId,
        feederId,
        status: "ACTIVE",
        activatedBy: requireText(input?.activatedBy, "activatedBy", 256),
        activatedRole: requireText(input?.activatedRole, "activatedRole", 100)
            .toUpperCase(),
        reason: requireText(input?.reason, "reason"),
        requestId: optionalText(input?.requestId, 128),
        activatedAt: requireTimestamp(input?.activatedAt, "activatedAt", clock),
        clearedAt: null,
        clearanceApprovalRequestId: null
    });
}

export function createApprovalRequest(input, {
    idGenerator = randomUUID,
    clock = () => new Date(),
    approvalLifetimeMs = 15 * 60 * 1000
} = {}) {
    const createdAt = requireTimestamp(input?.createdAt, "createdAt", clock);
    const requiredAuthorities = Array.isArray(input?.requiredAuthorities)
        ? input.requiredAuthorities.map(authority => requireEnum(
            authority,
            APPROVAL_AUTHORITIES,
            "requiredAuthority"
        ))
        : [];
    if (requiredAuthorities.length !== 2) {
        throw new Error("Exactly two approval authorities are required.");
    }
    return Object.freeze({
        approvalRequestId: immutableId(
            "approval_request",
            input?.approvalRequestId,
            idGenerator
        ),
        actionType: requireText(input?.actionType, "actionType", 100).toUpperCase(),
        requestedBy: requireText(input?.requestedBy, "requestedBy", 256),
        targetType: requireText(input?.targetType, "targetType", 100).toUpperCase(),
        targetId: requireText(input?.targetId, "targetId", 256),
        barnId: optionalText(input?.barnId, 256),
        feederId: optionalText(input?.feederId, 256),
        reason: requireText(input?.reason, "reason"),
        requiredAuthorities: Object.freeze(requiredAuthorities),
        actionPayload: input?.actionPayload ?? null,
        status: "PENDING",
        createdAt,
        expiresAt: requireTimestamp(
            input?.expiresAt || new Date(
                Date.parse(createdAt) + approvalLifetimeMs
            ).toISOString(),
            "expiresAt",
            clock
        ),
        completedAt: null
    });
}

export function createApprovalDecision(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    return Object.freeze({
        approvalDecisionId: immutableId(
            "approval_decision",
            input?.approvalDecisionId,
            idGenerator
        ),
        approvalRequestId: requireText(
            input?.approvalRequestId,
            "approvalRequestId",
            256
        ),
        administratorId: requireText(input?.administratorId, "administratorId", 256),
        effectiveRole: requireText(input?.effectiveRole, "effectiveRole", 100)
            .toUpperCase(),
        authorityRepresented: requireEnum(
            input?.authorityRepresented,
            APPROVAL_AUTHORITIES,
            "authorityRepresented"
        ),
        decision: requireEnum(input?.decision, APPROVAL_DECISIONS, "decision"),
        reason: requireText(input?.reason, "reason"),
        authenticationStrength: requireText(
            input?.authenticationStrength,
            "authenticationStrength",
            100
        ).toUpperCase(),
        decidedAt: requireTimestamp(input?.decidedAt, "decidedAt", clock)
    });
}

export function createOperatorResolutionCase(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    const createdAt = requireTimestamp(input?.createdAt, "createdAt", clock);
    const quantity = Number(input?.welfareImpact?.quantity ?? 1);
    if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error("welfareImpact.quantity must be positive.");
    }
    return Object.freeze({
        resolutionCaseId: immutableId(
            "resolution_case",
            input?.resolutionCaseId,
            idGenerator
        ),
        eventId: requireText(input?.eventId, "eventId", 256),
        commandId: requireText(input?.commandId, "commandId", 256),
        barnId: requireText(input?.barnId, "barnId", 256),
        feederId: requireText(input?.feederId, "feederId", 256),
        deviceId: requireText(input?.deviceId, "deviceId", 256),
        caseType: requireText(
            input?.caseType || "DISPENSE_OUTCOME_UNKNOWN",
            "caseType",
            100
        ).toUpperCase(),
        status: "OPEN",
        requestedResolution: null,
        reason: requireText(input?.reason, "reason"),
        supportingNotes: optionalText(input?.supportingNotes, 4000),
        createdBy: optionalText(input?.createdBy, 256),
        createdAt,
        approvalDeadline: null,
        approvalRequestId: null,
        resolvedAt: null,
        finalResolution: null,
        welfareImpact: Object.freeze({
            quantity,
            unit: optionalText(input?.welfareImpact?.unit, 100) || "FEED_PORTION",
            countsAsDispensed: true
        }),
        replacementCommandId: null
    });
}
