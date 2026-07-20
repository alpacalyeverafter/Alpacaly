import { randomUUID } from "node:crypto";

export const FEED_INTENT_STATUSES = Object.freeze([
    "PENDING",
    "PROCESSING",
    "COMPLETED",
    "FAILED"
]);

export const FEED_INTENT_HISTORY_ACTIONS = Object.freeze([
    "FEED_INTENT_CREATED",
    "OUTBOX_QUEUED",
    "PROCESSING_STARTED",
    "FEED_REQUEST_CREATED",
    "QUEUE_INSERTION_COMPLETED",
    "PROCESSING_COMPLETED",
    "PROCESSING_FAILED",
    "PROCESSING_RECOVERED"
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

function immutableId(prefix, value, idGenerator) {
    return value
        ? requireText(value, `${prefix}Id`)
        : `${prefix}_${idGenerator()}`;
}

export function createFeedIntent(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    const now = requireTimestamp(
        input?.createdAt || clock().toISOString(),
        "createdAt"
    );

    return Object.freeze({
        feedIntentId: immutableId(
            "feed_intent",
            input?.feedIntentId,
            idGenerator
        ),
        contributionId: requireText(input?.contributionId, "contributionId"),
        barnId: requireText(input?.barnId, "barnId"),
        feederId: requireText(input?.feederId, "feederId"),
        queueId: requireText(input?.queueId, "queueId"),
        message: typeof input?.message === "string" ? input.message.trim() : "",
        status: "PENDING",
        createdAt: now,
        outboxQueuedAt: now,
        processingStartedAt: null,
        feedRequestCreatedAt: null,
        queueInsertionCompletedAt: null,
        processingCompletedAt: null,
        processingFailedAt: null,
        failureReason: null,
        attemptCount: 0,
        updatedAt: now
    });
}

export function createOutboxEntry(input, {
    idGenerator = randomUUID,
    clock = () => new Date()
} = {}) {
    const now = requireTimestamp(
        input?.createdAt || clock().toISOString(),
        "createdAt"
    );

    return Object.freeze({
        outboxEntryId: immutableId(
            "outbox",
            input?.outboxEntryId,
            idGenerator
        ),
        feedIntentId: requireText(input?.feedIntentId, "feedIntentId"),
        status: "PENDING",
        createdAt: now,
        availableAt: requireTimestamp(input?.availableAt || now, "availableAt"),
        processingStartedAt: null,
        completedAt: null,
        failedAt: null,
        attemptCount: 0,
        lastError: null,
        updatedAt: now
    });
}
