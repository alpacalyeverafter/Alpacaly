import { randomUUID } from "node:crypto";

export const PAYMENT_PROVIDERS = Object.freeze(["STRIPE"]);

export const PAYMENT_MODES = Object.freeze(["TEST"]);

export const PAYMENT_STATUSES = Object.freeze([
    "PENDING",
    "COMPLETED",
    "FAILED",
    "EXPIRED",
    "REFUNDED",
    "DISPUTED"
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

export function createPaymentRequest(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    const now = requireTimestamp(input?.createdAt || clock().toISOString(), "createdAt");
    const amountMinor = Number(input?.amountMinor);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
        throw new Error("amountMinor must be a positive safe integer.");
    }
    const currency = requireText(input?.currency, "currency").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
        throw new Error("currency must be a three-letter code.");
    }

    return Object.freeze({
        paymentRequestId: input?.paymentRequestId
            ? requireText(input.paymentRequestId, "paymentRequestId")
            : `payment_request_${idGenerator()}`,
        provider: requireEnum(input?.provider, PAYMENT_PROVIDERS, "provider"),
        mode: requireEnum(input?.mode || "TEST", PAYMENT_MODES, "mode"),
        clientRequestId: requireText(input?.clientRequestId, "clientRequestId"),
        checkoutSessionId: null,
        checkoutUrl: null,
        paymentIntentId: null,
        supporterDisplayName: requireText(
            input?.supporterDisplayName,
            "supporterDisplayName"
        ),
        amountMinor,
        currency,
        status: "PENDING",
        providerStatus: "checkout_not_created",
        failureCode: null,
        lastProviderEventId: null,
        contributionId: null,
        feedIntentId: null,
        eventId: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null
    });
}
