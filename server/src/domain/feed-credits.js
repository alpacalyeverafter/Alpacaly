import { randomBytes, randomUUID } from "node:crypto";

export const FEED_CREDIT_PACKS = Object.freeze([
    Object.freeze({ packId: "feed_credit_1", amountMinor: 500, credits: 1 }),
    Object.freeze({ packId: "feed_credit_3", amountMinor: 1500, credits: 3 }),
    Object.freeze({ packId: "feed_credit_5", amountMinor: 2500, credits: 5 })
]);

export const CREDIT_LEDGER_ENTRY_TYPES = Object.freeze([
    "PURCHASE",
    "RESERVATION",
    "REDEMPTION",
    "RELEASE",
    "REFUND_ADJUSTMENT",
    "ADMIN_CORRECTION"
]);

export const CREDIT_RESERVATION_STATUSES = Object.freeze([
    "WAITING",
    "YOUR_TURN",
    "CONFIRMED",
    "REDEEMED",
    "RELEASED",
    "OUTCOME_UNKNOWN"
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

function requireInteger(value, name) {
    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized)) {
        throw new Error(`${name} must be a safe integer.`);
    }
    return normalized;
}

function requireEnum(value, allowed, name) {
    const normalized = requireText(value, name).toUpperCase();
    if (!allowed.includes(normalized)) {
        throw new Error(`${name} is not supported.`);
    }
    return normalized;
}

export function getFeedCreditPack(packId) {
    const normalized = requireText(packId, "packId");
    return FEED_CREDIT_PACKS.find(pack => pack.packId === normalized) || null;
}

export function createWalletRecoveryToken() {
    return randomBytes(32).toString("base64url");
}

export function createCreditWallet(input, {
    idGenerator = randomUUID,
    tokenGenerator = createWalletRecoveryToken,
    clock = () => new Date()
} = {}) {
    const now = requireTimestamp(input?.createdAt || clock().toISOString(), "createdAt");
    const supporterDisplayName = requireText(
        input?.supporterDisplayName,
        "supporterDisplayName"
    );
    if (supporterDisplayName.length > 80) {
        throw new Error("supporterDisplayName must be 80 characters or fewer.");
    }
    const recoveryToken = tokenGenerator();
    return {
        wallet: Object.freeze({
            walletId: input?.walletId
                ? requireText(input.walletId, "walletId")
                : `credit_wallet_${idGenerator()}`,
            recoveryTokenHash: requireText(
                input?.recoveryTokenHash,
                "recoveryTokenHash"
            ),
            supporterDisplayName,
            status: "ACTIVE",
            createdAt: now,
            updatedAt: now,
            lastSeenAt: now
        }),
        recoveryToken
    };
}

export function createCreditPurchase(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    const pack = getFeedCreditPack(input?.packId);
    if (!pack) {
        throw new Error("packId is not supported.");
    }
    const now = requireTimestamp(input?.createdAt || clock().toISOString(), "createdAt");
    return Object.freeze({
        purchaseId: input?.purchaseId
            ? requireText(input.purchaseId, "purchaseId")
            : `credit_purchase_${idGenerator()}`,
        walletId: requireText(input?.walletId, "walletId"),
        paymentRequestId: requireText(input?.paymentRequestId, "paymentRequestId"),
        packId: pack.packId,
        credits: pack.credits,
        amountMinor: pack.amountMinor,
        currency: "GBP",
        status: "PENDING",
        creditedAt: null,
        adjustedCredits: 0,
        createdAt: now,
        updatedAt: now
    });
}

export function createCreditReservation(input, {
    idGenerator = randomUUID,
    clock = () => new Date(),
    lifetimeMs = 30 * 60 * 1000
} = {}) {
    const nowDate = clock();
    const now = requireTimestamp(input?.createdAt || nowDate.toISOString(), "createdAt");
    const expiresAt = requireTimestamp(
        input?.expiresAt || new Date(nowDate.getTime() + lifetimeMs).toISOString(),
        "expiresAt"
    );
    return Object.freeze({
        reservationId: input?.reservationId
            ? requireText(input.reservationId, "reservationId")
            : `credit_reservation_${idGenerator()}`,
        walletId: requireText(input?.walletId, "walletId"),
        clientRequestId: requireText(input?.clientRequestId, "clientRequestId"),
        status: "WAITING",
        contributionId: null,
        feedIntentId: null,
        eventId: null,
        expiresAt,
        turnStartedAt: null,
        confirmationExpiresAt: null,
        confirmedAt: null,
        redeemedAt: null,
        releasedAt: null,
        releaseReason: null,
        lastHeartbeatAt: now,
        createdAt: now,
        updatedAt: now
    });
}

export function createCreditLedgerEntry(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    return Object.freeze({
        ledgerEntryId: input?.ledgerEntryId
            ? requireText(input.ledgerEntryId, "ledgerEntryId")
            : `credit_ledger_${idGenerator()}`,
        walletId: requireText(input?.walletId, "walletId"),
        entryType: requireEnum(
            input?.entryType,
            CREDIT_LEDGER_ENTRY_TYPES,
            "entryType"
        ),
        availableDelta: requireInteger(input?.availableDelta ?? 0, "availableDelta"),
        reservedDelta: requireInteger(input?.reservedDelta ?? 0, "reservedDelta"),
        spentDelta: requireInteger(input?.spentDelta ?? 0, "spentDelta"),
        paymentRequestId: input?.paymentRequestId
            ? requireText(input.paymentRequestId, "paymentRequestId")
            : null,
        reservationId: input?.reservationId
            ? requireText(input.reservationId, "reservationId")
            : null,
        eventId: input?.eventId ? requireText(input.eventId, "eventId") : null,
        idempotencyKey: requireText(input?.idempotencyKey, "idempotencyKey"),
        reason: input?.reason ? requireText(input.reason, "reason") : null,
        metadata: input?.metadata ?? null,
        createdAt: requireTimestamp(input?.createdAt || clock().toISOString(), "createdAt")
    });
}
