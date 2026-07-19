import { randomUUID } from "node:crypto";

export const PROVIDER_TYPES = Object.freeze([
    "WEBSITE",
    "STRIPE",
    "YOUTUBE",
    "TIKTOK",
    "FACEBOOK",
    "QR_CODE",
    "MANUAL_ADMIN",
    "CORPORATE_SPONSOR",
    "FUTURE_API"
]);

export const PROVIDER_EVENT_VERIFICATION_STATUSES = Object.freeze([
    "PENDING",
    "VERIFIED",
    "REJECTED"
]);

export const CONTRIBUTION_ELIGIBILITY_STATUSES = Object.freeze([
    "ELIGIBLE",
    "INELIGIBLE"
]);

export const CONTRIBUTION_AUDIT_ACTIONS = Object.freeze([
    "PROVIDER_EVENT_RECEIVED",
    "DUPLICATE_DETECTED",
    "VERIFICATION_PASSED",
    "VERIFICATION_FAILED",
    "CONTRIBUTION_CREATED",
    "CONTRIBUTION_REJECTED",
    "FEED_REQUEST_CREATED"
]);

function requireText(value, name) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
        throw new Error(`${name} is required.`);
    }
    return normalized;
}

function requireTimestamp(value, name) {
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

export function createProviderEvent(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    const now = clock().toISOString();
    return Object.freeze({
        providerEventId: immutableId(
            "provider_event",
            input?.providerEventId,
            idGenerator
        ),
        provider: requireEnum(input?.provider, PROVIDER_TYPES, "provider"),
        externalEventId: requireText(input?.externalEventId, "externalEventId"),
        receivedAt: requireTimestamp(input?.receivedAt || now, "receivedAt"),
        verificationStatus: requireEnum(
            input?.verificationStatus || "PENDING",
            PROVIDER_EVENT_VERIFICATION_STATUSES,
            "verificationStatus"
        ),
        rawMetadata: input?.rawMetadata ?? null,
        rejectionReason: input?.rejectionReason
            ? requireText(input.rejectionReason, "rejectionReason")
            : null,
        createdAt: requireTimestamp(input?.createdAt || now, "createdAt"),
        updatedAt: requireTimestamp(input?.updatedAt || now, "updatedAt")
    });
}

export function createContribution(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    const now = clock().toISOString();
    const amountMinor = Number(input?.amountMinor);
    const feedQuantity = Number(input?.feedQuantity);
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
        throw new Error("amountMinor must be a non-negative safe integer.");
    }
    if (!Number.isSafeInteger(feedQuantity) || feedQuantity < 0) {
        throw new Error("feedQuantity must be a non-negative safe integer.");
    }

    const currency = requireText(input?.currency, "currency").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
        throw new Error("currency must be a three-letter code.");
    }

    return Object.freeze({
        contributionId: immutableId(
            "contribution",
            input?.contributionId,
            idGenerator
        ),
        providerEventId: requireText(input?.providerEventId, "providerEventId"),
        verifiedAt: requireTimestamp(input?.verifiedAt || now, "verifiedAt"),
        amountMinor,
        currency,
        supporterDisplayName: requireText(
            input?.supporterDisplayName,
            "supporterDisplayName"
        ),
        eligibilityStatus: requireEnum(
            input?.eligibilityStatus,
            CONTRIBUTION_ELIGIBILITY_STATUSES,
            "eligibilityStatus"
        ),
        feedQuantity,
        metadata: input?.metadata ?? null,
        createdAt: requireTimestamp(input?.createdAt || now, "createdAt"),
        updatedAt: requireTimestamp(input?.updatedAt || now, "updatedAt")
    });
}

export function createContributionAuditRecord(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    return Object.freeze({
        auditRecordId: immutableId(
            "audit",
            input?.auditRecordId,
            idGenerator
        ),
        action: requireEnum(
            input?.action,
            CONTRIBUTION_AUDIT_ACTIONS,
            "action"
        ),
        providerEventId: input?.providerEventId || null,
        contributionId: input?.contributionId || null,
        eventId: input?.eventId || null,
        occurredAt: requireTimestamp(
            input?.occurredAt || clock().toISOString(),
            "occurredAt"
        ),
        details: input?.details ?? null
    });
}
