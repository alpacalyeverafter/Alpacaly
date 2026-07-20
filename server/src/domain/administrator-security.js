import { randomUUID } from "node:crypto";

export const ADMINISTRATOR_STATUSES = Object.freeze([
    "ACTIVE",
    "SUSPENDED",
    "REVOKED"
]);

export const ADMINISTRATOR_ROLES = Object.freeze([
    "VIEWER",
    "WELFARE_OPERATOR",
    "HARDWARE_OPERATOR",
    "ADMINISTRATOR"
]);

export const AUTHENTICATION_STRENGTHS = Object.freeze([
    "DEVELOPMENT",
    "PASSWORD",
    "MFA",
    "PHISHING_RESISTANT"
]);

export const OPERATOR_AUDIT_RESULTS = Object.freeze([
    "SUCCEEDED",
    "REJECTED",
    "FAILED"
]);

function requireText(value, name) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
        throw new Error(`${name} is required.`);
    }
    return normalized;
}

function optionalText(value, maximumLength = 1000) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    return String(value).trim().slice(0, maximumLength) || null;
}

function requireTimestamp(value, name, clock) {
    const normalized = requireText(value || clock().toISOString(), name);
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

function normalizeEmail(value) {
    const normalized = requireText(value, "email").toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
        throw new Error("email must be a valid email address.");
    }
    return normalized;
}

export function createAdministrator(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    const now = requireTimestamp(input?.createdAt, "createdAt", clock);
    return Object.freeze({
        administratorId: immutableId(
            "administrator",
            input?.administratorId,
            idGenerator
        ),
        externalIdentityId: requireText(
            input?.externalIdentityId,
            "externalIdentityId"
        ),
        displayName: requireText(input?.displayName, "displayName").slice(0, 120),
        email: normalizeEmail(input?.email),
        status: requireEnum(
            input?.status || "ACTIVE",
            ADMINISTRATOR_STATUSES,
            "status"
        ),
        createdAt: now,
        updatedAt: requireTimestamp(input?.updatedAt || now, "updatedAt", clock),
        lastAuthenticatedAt: input?.lastAuthenticatedAt
            ? requireTimestamp(input.lastAuthenticatedAt, "lastAuthenticatedAt", clock)
            : null
    });
}

export function createRoleAssignment(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    const assignedAt = requireTimestamp(input?.assignedAt, "assignedAt", clock);
    return Object.freeze({
        roleAssignmentId: immutableId(
            "role_assignment",
            input?.roleAssignmentId,
            idGenerator
        ),
        administratorId: requireText(input?.administratorId, "administratorId"),
        role: requireEnum(input?.role, ADMINISTRATOR_ROLES, "role"),
        platformWide: input?.platformWide === true,
        assignedAt,
        revokedAt: null
    });
}

export function createBarnScope(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    const assignedAt = requireTimestamp(input?.assignedAt, "assignedAt", clock);
    return Object.freeze({
        barnScopeId: immutableId("barn_scope", input?.barnScopeId, idGenerator),
        roleAssignmentId: requireText(
            input?.roleAssignmentId,
            "roleAssignmentId"
        ),
        administratorId: requireText(input?.administratorId, "administratorId"),
        barnId: requireText(input?.barnId, "barnId"),
        assignedAt,
        revokedAt: null
    });
}

export function createOperatorAuditRecord(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    return Object.freeze({
        auditRecordId: immutableId(
            "operator_audit",
            input?.auditRecordId,
            idGenerator
        ),
        administratorId: input?.administratorId || null,
        effectiveRole: input?.effectiveRole || null,
        barnId: input?.barnId || null,
        feederId: input?.feederId || null,
        deviceId: input?.deviceId || null,
        action: requireText(input?.action, "action").toUpperCase(),
        targetType: requireText(input?.targetType || "SYSTEM", "targetType")
            .toUpperCase(),
        targetId: optionalText(input?.targetId, 256),
        reason: optionalText(input?.reason, 1000),
        requestId: optionalText(input?.requestId, 128),
        approvalId: optionalText(input?.approvalId, 256),
        authenticationStrength: input?.authenticationStrength
            ? requireEnum(
                input.authenticationStrength,
                AUTHENTICATION_STRENGTHS,
                "authenticationStrength"
            )
            : null,
        timestamp: requireTimestamp(input?.timestamp, "timestamp", clock),
        result: requireEnum(
            input?.result,
            OPERATOR_AUDIT_RESULTS,
            "result"
        ),
        beforeSummary: input?.beforeSummary ?? null,
        afterSummary: input?.afterSummary ?? null,
        metadata: input?.metadata ?? null
    });
}
