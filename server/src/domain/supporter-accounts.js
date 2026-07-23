import { randomUUID } from "node:crypto";

export const SUPPORTER_ACCOUNT_STATUSES = Object.freeze([
    "ACTIVE",
    "SUSPENDED",
    "DELETED"
]);

export const SUPPORTER_ACCOUNT_EVENT_TYPES = Object.freeze([
    "ACCOUNT_CREATED",
    "IDENTITY_REFRESHED",
    "SESSION_AUTHENTICATED",
    "SESSIONS_REVOKED",
    "WALLET_LINKED",
    "WALLET_LINK_REJECTED",
    "ACCOUNT_SUSPENDED",
    "ACCOUNT_RESTORED",
    "ACCOUNT_DELETED",
    "DATA_EXPORTED",
    "ADMINISTRATOR_NOTE"
]);

function requireText(value, name, maximumLength = 500) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized || normalized.length > maximumLength) {
        throw new Error(`${name} is required and must be ${maximumLength} characters or fewer.`);
    }
    return normalized;
}

function requireTimestamp(value, name) {
    const normalized = requireText(value, name, 64);
    if (Number.isNaN(Date.parse(normalized))) {
        throw new Error(`${name} must be an ISO-compatible timestamp.`);
    }
    return normalized;
}

function optionalText(value, maximumLength = 500) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    return requireText(value, "value", maximumLength);
}

export function normalizeEmail(value) {
    const email = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!email || email.length > 320 || !email.includes("@")) {
        return null;
    }
    return email;
}

export function createSupporterAccount(input, {
    clock = () => new Date(),
    idGenerator = randomUUID
} = {}) {
    const createdAt = requireTimestamp(
        input.createdAt || clock().toISOString(),
        "createdAt"
    );
    const email = normalizeEmail(input.email);
    return Object.freeze({
        accountId: input.accountId || `supporter_account_${idGenerator()}`,
        providerName: requireText(input.providerName, "providerName", 80),
        externalIdentityId: requireText(
            input.externalIdentityId,
            "externalIdentityId",
            255
        ),
        emailNormalized: email,
        emailVerified: input.emailVerified === true,
        displayName: optionalText(input.displayName, 120),
        status: SUPPORTER_ACCOUNT_STATUSES.includes(input.status)
            ? input.status
            : "ACTIVE",
        sessionsValidAfter: createdAt,
        createdAt,
        updatedAt: createdAt,
        deletedAt: null
    });
}

export function createSupporterWalletLink(input, {
    clock = () => new Date(),
    idGenerator = randomUUID
} = {}) {
    const linkedAt = requireTimestamp(
        input.linkedAt || clock().toISOString(),
        "linkedAt"
    );
    return Object.freeze({
        linkId: input.linkId || `supporter_wallet_link_${idGenerator()}`,
        accountId: requireText(input.accountId, "accountId", 160),
        walletId: requireText(input.walletId, "walletId", 160),
        clientRequestId: requireText(input.clientRequestId, "clientRequestId", 160),
        status: "ACTIVE",
        linkedAt,
        releasedAt: null,
        releaseReason: null
    });
}

export function createSupporterAccountEvent(input, {
    clock = () => new Date(),
    idGenerator = randomUUID
} = {}) {
    const eventType = requireText(input.eventType, "eventType", 80);
    if (!SUPPORTER_ACCOUNT_EVENT_TYPES.includes(eventType)) {
        throw new Error("eventType is invalid.");
    }
    return Object.freeze({
        eventId: input.eventId || `supporter_account_event_${idGenerator()}`,
        accountId: optionalText(input.accountId, 160),
        walletId: optionalText(input.walletId, 160),
        eventType,
        actorType: requireText(input.actorType || "SYSTEM", "actorType", 40),
        actorReference: optionalText(input.actorReference, 160),
        requestId: optionalText(input.requestId, 160),
        reason: optionalText(input.reason, 500),
        metadata: input.metadata ?? null,
        createdAt: requireTimestamp(
            input.createdAt || clock().toISOString(),
            "createdAt"
        )
    });
}
