import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_RESOURCE_IDS } from "../domain/resources.js";
import { runEventStoreMigrations } from "./migrations/index.js";

function parseJson(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    return JSON.parse(value);
}

function serializeJson(value) {
    return JSON.stringify(value ?? null);
}

function mapProviderEvent(row) {
    return row ? {
        providerEventId: row.providerEventId,
        provider: row.provider,
        externalEventId: row.externalEventId,
        receivedAt: row.receivedAt,
        verificationStatus: row.verificationStatus,
        rawMetadata: parseJson(row.rawMetadataJson),
        rejectionReason: row.rejectionReason,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
    } : null;
}

function mapContribution(row) {
    return row ? {
        contributionId: row.contributionId,
        providerEventId: row.providerEventId,
        verifiedAt: row.verifiedAt,
        amountMinor: row.amountMinor,
        currency: row.currency,
        supporterDisplayName: row.supporterDisplayName,
        eligibilityStatus: row.eligibilityStatus,
        feedQuantity: row.feedQuantity,
        metadata: parseJson(row.metadataJson),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
    } : null;
}

function mapFeedIntent(row) {
    return row ? {
        feedIntentId: row.feedIntentId,
        contributionId: row.contributionId,
        barnId: row.barnId,
        feederId: row.feederId,
        queueId: row.queueId,
        message: row.message,
        status: row.status,
        createdAt: row.createdAt,
        outboxQueuedAt: row.outboxQueuedAt,
        processingStartedAt: row.processingStartedAt,
        feedRequestCreatedAt: row.feedRequestCreatedAt,
        queueInsertionCompletedAt: row.queueInsertionCompletedAt,
        processingCompletedAt: row.processingCompletedAt,
        processingFailedAt: row.processingFailedAt,
        failureReason: row.failureReason,
        attemptCount: row.attemptCount,
        updatedAt: row.updatedAt
    } : null;
}

function mapOutboxEntry(row) {
    return row ? {
        outboxSequence: row.outboxSequence,
        outboxEntryId: row.outboxEntryId,
        feedIntentId: row.feedIntentId,
        status: row.status,
        createdAt: row.createdAt,
        availableAt: row.availableAt,
        processingStartedAt: row.processingStartedAt,
        completedAt: row.completedAt,
        failedAt: row.failedAt,
        attemptCount: row.attemptCount,
        lastError: row.lastError,
        updatedAt: row.updatedAt
    } : null;
}

function mapFeedIntentHistory(row) {
    return {
        historySequence: row.historySequence,
        feedIntentId: row.feedIntentId,
        action: row.action,
        timestamp: row.timestamp,
        details: parseJson(row.detailsJson)
    };
}

function mapAuditRecord(row) {
    return {
        auditSequence: row.auditSequence,
        auditRecordId: row.auditRecordId,
        action: row.action,
        providerEventId: row.providerEventId,
        contributionId: row.contributionId,
        eventId: row.eventId,
        occurredAt: row.occurredAt,
        details: parseJson(row.detailsJson)
    };
}

export class SqliteEventStore {
    constructor({ databasePath, logger }) {
        if (!databasePath) {
            throw new Error("SqliteEventStore requires a databasePath.");
        }

        this.databasePath = databasePath;
        this.logger = logger;
        this.closed = false;

        if (databasePath !== ":memory:") {
            mkdirSync(dirname(databasePath), { recursive: true });
        }

        this.database = new DatabaseSync(databasePath);
        this.configureConnection();
        this.schemaVersion = runEventStoreMigrations(this.database, logger);
        this.prepareStatements();

        this.logger.info({
            event: "event_store_connected",
            databasePath: databasePath === ":memory:" ? ":memory:" : databasePath
        }, "SQLite Event Store connected");
    }

    configureConnection() {
        this.database.exec("PRAGMA foreign_keys = ON;");
        this.database.exec("PRAGMA busy_timeout = 5000;");

        if (this.databasePath !== ":memory:") {
            this.database.exec("PRAGMA journal_mode = WAL;");
            this.database.exec("PRAGMA synchronous = FULL;");
        }
    }

    prepareStatements() {
        this.statements = {
            insertBarn: this.database.prepare(`
                INSERT INTO Barns (barnId, name, timezone, createdAt)
                VALUES (?, ?, ?, ?)
            `),
            insertFeeder: this.database.prepare(`
                INSERT INTO Feeders (feederId, barnId, name, createdAt)
                VALUES (?, ?, ?, ?)
            `),
            insertCamera: this.database.prepare(`
                INSERT INTO Cameras (cameraId, barnId, name, createdAt)
                VALUES (?, ?, ?, ?)
            `),
            insertDevice: this.database.prepare(`
                INSERT INTO Devices (deviceId, barnId, name, kind, createdAt)
                VALUES (?, ?, ?, ?, ?)
            `),
            insertResourceQueue: this.database.prepare(`
                INSERT INTO Queues (
                    queueId,
                    barnId,
                    feederId,
                    resourceType,
                    resourceId,
                    name,
                    createdAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `),
            insertProviderEvent: this.database.prepare(`
                INSERT INTO ProviderEvents (
                    providerEventId,
                    provider,
                    externalEventId,
                    receivedAt,
                    verificationStatus,
                    rawMetadataJson,
                    rejectionReason,
                    createdAt,
                    updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            selectProviderEventById: this.database.prepare(`
                SELECT
                    providerEventId,
                    provider,
                    externalEventId,
                    receivedAt,
                    verificationStatus,
                    rawMetadataJson,
                    rejectionReason,
                    createdAt,
                    updatedAt
                FROM ProviderEvents
                WHERE providerEventId = ?
            `),
            selectProviderEventByExternalId: this.database.prepare(`
                SELECT
                    providerEventId,
                    provider,
                    externalEventId,
                    receivedAt,
                    verificationStatus,
                    rawMetadataJson,
                    rejectionReason,
                    createdAt,
                    updatedAt
                FROM ProviderEvents
                WHERE provider = ? AND externalEventId = ?
            `),
            updateProviderEventDecision: this.database.prepare(`
                UPDATE ProviderEvents
                SET verificationStatus = ?, rejectionReason = ?, updatedAt = ?
                WHERE providerEventId = ? AND verificationStatus = 'PENDING'
            `),
            insertContribution: this.database.prepare(`
                INSERT INTO Contributions (
                    contributionId,
                    providerEventId,
                    verifiedAt,
                    amountMinor,
                    currency,
                    supporterDisplayName,
                    eligibilityStatus,
                    feedQuantity,
                    metadataJson,
                    createdAt,
                    updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            selectContributionById: this.database.prepare(`
                SELECT
                    contributionId,
                    providerEventId,
                    verifiedAt,
                    amountMinor,
                    currency,
                    supporterDisplayName,
                    eligibilityStatus,
                    feedQuantity,
                    metadataJson,
                    createdAt,
                    updatedAt
                FROM Contributions
                WHERE contributionId = ?
            `),
            selectContributionByProviderEventId: this.database.prepare(`
                SELECT
                    contributionId,
                    providerEventId,
                    verifiedAt,
                    amountMinor,
                    currency,
                    supporterDisplayName,
                    eligibilityStatus,
                    feedQuantity,
                    metadataJson,
                    createdAt,
                    updatedAt
                FROM Contributions
                WHERE providerEventId = ?
            `),
            selectContributionsWithoutFeedIntent: this.database.prepare(`
                SELECT
                    contribution.contributionId,
                    contribution.providerEventId,
                    contribution.verifiedAt,
                    contribution.amountMinor,
                    contribution.currency,
                    contribution.supporterDisplayName,
                    contribution.eligibilityStatus,
                    contribution.feedQuantity,
                    contribution.metadataJson,
                    contribution.createdAt,
                    contribution.updatedAt
                FROM Contributions AS contribution
                JOIN ProviderEvents AS providerEvent
                  ON providerEvent.providerEventId = contribution.providerEventId
                LEFT JOIN FeedIntents AS intent
                  ON intent.contributionId = contribution.contributionId
                WHERE intent.feedIntentId IS NULL
                  AND contribution.eligibilityStatus = 'ELIGIBLE'
                  AND contribution.feedQuantity > 0
                  AND providerEvent.verificationStatus = 'VERIFIED'
                ORDER BY contribution.createdAt ASC, contribution.contributionId ASC
            `),
            insertFeedIntent: this.database.prepare(`
                INSERT INTO FeedIntents (
                    feedIntentId,
                    contributionId,
                    barnId,
                    feederId,
                    queueId,
                    message,
                    status,
                    createdAt,
                    outboxQueuedAt,
                    processingStartedAt,
                    feedRequestCreatedAt,
                    queueInsertionCompletedAt,
                    processingCompletedAt,
                    processingFailedAt,
                    failureReason,
                    attemptCount,
                    updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            insertOutboxEntry: this.database.prepare(`
                INSERT INTO Outbox (
                    outboxEntryId,
                    feedIntentId,
                    status,
                    createdAt,
                    availableAt,
                    processingStartedAt,
                    completedAt,
                    failedAt,
                    attemptCount,
                    lastError,
                    updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            insertFeedIntentHistory: this.database.prepare(`
                INSERT INTO FeedIntentHistory (
                    feedIntentId,
                    action,
                    timestamp,
                    detailsJson
                ) VALUES (?, ?, ?, ?)
            `),
            selectFeedIntentById: this.database.prepare(`
                SELECT * FROM FeedIntents WHERE feedIntentId = ?
            `),
            selectFeedIntentByContribution: this.database.prepare(`
                SELECT * FROM FeedIntents WHERE contributionId = ?
            `),
            selectOutboxByFeedIntent: this.database.prepare(`
                SELECT * FROM Outbox WHERE feedIntentId = ?
            `),
            selectProcessableOutbox: this.database.prepare(`
                SELECT outbox.*
                FROM Outbox AS outbox
                JOIN FeedIntents AS intent
                  ON intent.feedIntentId = outbox.feedIntentId
                WHERE outbox.status IN ('PENDING', 'FAILED')
                  AND outbox.availableAt <= ?
                  AND NOT EXISTS (
                      SELECT 1
                      FROM Outbox AS earlierOutbox
                      JOIN FeedIntents AS earlierIntent
                        ON earlierIntent.feedIntentId = earlierOutbox.feedIntentId
                      WHERE earlierIntent.feederId = intent.feederId
                        AND earlierOutbox.outboxSequence < outbox.outboxSequence
                        AND earlierOutbox.status <> 'COMPLETED'
                  )
                ORDER BY outbox.outboxSequence ASC
                LIMIT ?
            `),
            selectProcessingOutbox: this.database.prepare(`
                SELECT *
                FROM Outbox
                WHERE status = 'PROCESSING'
                ORDER BY outboxSequence ASC
            `),
            claimOutboxEntry: this.database.prepare(`
                UPDATE Outbox
                SET status = 'PROCESSING',
                    processingStartedAt = ?,
                    failedAt = NULL,
                    lastError = NULL,
                    attemptCount = attemptCount + 1,
                    updatedAt = ?
                WHERE feedIntentId = ?
                  AND status IN ('PENDING', 'FAILED')
            `),
            claimFeedIntent: this.database.prepare(`
                UPDATE FeedIntents
                SET status = 'PROCESSING',
                    processingStartedAt = ?,
                    processingFailedAt = NULL,
                    failureReason = NULL,
                    attemptCount = attemptCount + 1,
                    updatedAt = ?
                WHERE feedIntentId = ?
                  AND status IN ('PENDING', 'FAILED')
            `),
            failOutboxEntry: this.database.prepare(`
                UPDATE Outbox
                SET status = 'FAILED',
                    availableAt = ?,
                    failedAt = ?,
                    lastError = ?,
                    updatedAt = ?
                WHERE feedIntentId = ? AND status = 'PROCESSING'
            `),
            failFeedIntent: this.database.prepare(`
                UPDATE FeedIntents
                SET status = 'FAILED',
                    processingFailedAt = ?,
                    failureReason = ?,
                    updatedAt = ?
                WHERE feedIntentId = ? AND status = 'PROCESSING'
            `),
            recoverOutboxEntry: this.database.prepare(`
                UPDATE Outbox
                SET status = 'PENDING',
                    availableAt = ?,
                    lastError = 'Recovered after interrupted processing',
                    updatedAt = ?
                WHERE feedIntentId = ? AND status = 'PROCESSING'
            `),
            recoverFeedIntent: this.database.prepare(`
                UPDATE FeedIntents
                SET status = 'PENDING',
                    failureReason = NULL,
                    updatedAt = ?
                WHERE feedIntentId = ? AND status = 'PROCESSING'
            `),
            completeOutboxEntry: this.database.prepare(`
                UPDATE Outbox
                SET status = 'COMPLETED',
                    completedAt = ?,
                    failedAt = NULL,
                    lastError = NULL,
                    updatedAt = ?
                WHERE feedIntentId = ? AND status = 'PROCESSING'
            `),
            completeFeedIntent: this.database.prepare(`
                UPDATE FeedIntents
                SET status = 'COMPLETED',
                    feedRequestCreatedAt = ?,
                    queueInsertionCompletedAt = ?,
                    processingCompletedAt = ?,
                    processingFailedAt = NULL,
                    failureReason = NULL,
                    updatedAt = ?
                WHERE feedIntentId = ? AND status = 'PROCESSING'
            `),
            selectFeedIntentHistory: this.database.prepare(`
                SELECT
                    historySequence,
                    feedIntentId,
                    action,
                    timestamp,
                    detailsJson
                FROM FeedIntentHistory
                WHERE feedIntentId = ?
                ORDER BY historySequence ASC
            `),
            insertAuditRecord: this.database.prepare(`
                INSERT INTO AuditRecords (
                    auditRecordId,
                    action,
                    providerEventId,
                    contributionId,
                    eventId,
                    occurredAt,
                    detailsJson
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `),
            selectAuditRecords: this.database.prepare(`
                SELECT
                    auditSequence,
                    auditRecordId,
                    action,
                    providerEventId,
                    contributionId,
                    eventId,
                    occurredAt,
                    detailsJson
                FROM AuditRecords
                WHERE (? IS NULL OR providerEventId = ?)
                  AND (? IS NULL OR contributionId = ?)
                  AND (? IS NULL OR eventId = ?)
                ORDER BY auditSequence ASC
            `),
            selectEventIdByContribution: this.database.prepare(`
                SELECT eventId
                FROM Events
                WHERE contributionId = ?
            `),
            selectEventIdByFeedIntent: this.database.prepare(`
                SELECT eventId
                FROM Events
                WHERE feedIntentId = ?
            `),
            insertEvent: this.database.prepare(`
                INSERT INTO Events (
                    eventId,
                    type,
                    sequenceNumber,
                    supporterName,
                    source,
                    message,
                    clientRequestId,
                    requestedAt,
                    updatedAt,
                    currentState,
                    barnId,
                    feederId,
                    queueId,
                    contributionId,
                    feedIntentId
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            insertHistory: this.database.prepare(`
                INSERT INTO LifecycleHistory (
                    eventId,
                    ordinal,
                    state,
                    timestamp,
                    detailsJson
                ) VALUES (?, ?, ?, ?, ?)
            `),
            insertQueue: this.database.prepare(`
                INSERT INTO Queue (eventId, queueId, queuePosition, enqueuedAt)
                VALUES (?, ?, ?, ?)
            `),
            updateEventState: this.database.prepare(`
                UPDATE Events
                SET currentState = ?, updatedAt = ?
                WHERE eventId = ? AND currentState = ?
            `),
            deleteQueueEvent: this.database.prepare(`
                DELETE FROM Queue WHERE eventId = ?
            `),
            insertAcknowledgement: this.database.prepare(`
                INSERT INTO HardwareAcknowledgements (
                    eventId,
                    stage,
                    status,
                    receivedAt,
                    detailsJson
                ) VALUES (?, ?, ?, ?, ?)
            `),
            updateEventTimestamp: this.database.prepare(`
                UPDATE Events SET updatedAt = ? WHERE eventId = ?
            `),
            updateEventSafetyState: this.database.prepare(`
                UPDATE Events
                SET safetyState = ?, safetyUpdatedAt = ?, updatedAt = ?
                WHERE eventId = ?
            `),
            selectEvents: this.database.prepare(`
                SELECT
                    eventId,
                    type,
                    sequenceNumber,
                    supporterName,
                    source,
                    message,
                    clientRequestId,
                    requestedAt,
                    updatedAt,
                    currentState,
                    barnId,
                    feederId,
                    queueId,
                    contributionId,
                    feedIntentId,
                    safetyState,
                    safetyUpdatedAt
                FROM Events
                ORDER BY sequenceNumber ASC
            `),
            selectHistory: this.database.prepare(`
                SELECT eventId, ordinal, state, timestamp, detailsJson
                FROM LifecycleHistory
                ORDER BY eventId ASC, ordinal ASC
            `),
            selectQueue: this.database.prepare(`
                SELECT eventId, queueId, queuePosition, enqueuedAt
                FROM Queue
                ORDER BY queueId ASC, queuePosition ASC
            `),
            selectAcknowledgements: this.database.prepare(`
                SELECT
                    acknowledgementId,
                    eventId,
                    stage,
                    status,
                    receivedAt,
                    detailsJson
                FROM HardwareAcknowledgements
                ORDER BY eventId ASC, acknowledgementId ASC
            `),
            selectBarns: this.database.prepare(`
                SELECT barnId, name, timezone, createdAt
                FROM Barns
                ORDER BY barnId ASC
            `),
            selectFeeders: this.database.prepare(`
                SELECT feederId, barnId, name, createdAt
                FROM Feeders
                ORDER BY barnId ASC, feederId ASC
            `),
            selectCameras: this.database.prepare(`
                SELECT cameraId, barnId, name, createdAt
                FROM Cameras
                ORDER BY barnId ASC, cameraId ASC
            `),
            selectDevices: this.database.prepare(`
                SELECT deviceId, barnId, name, kind, createdAt
                FROM Devices
                ORDER BY barnId ASC, deviceId ASC
            `),
            selectResourceQueues: this.database.prepare(`
                SELECT
                    queueId,
                    barnId,
                    feederId,
                    resourceType,
                    resourceId,
                    name,
                    createdAt
                FROM Queues
                ORDER BY barnId ASC, queueId ASC
            `),
            selectDefaultAssignment: this.database.prepare(`
                SELECT queueId, barnId, feederId
                FROM Queues
                WHERE queueId = ?
            `),
            selectQueueByFeeder: this.database.prepare(`
                SELECT
                    queueId,
                    barnId,
                    feederId,
                    resourceType,
                    resourceId,
                    name,
                    createdAt
                FROM Queues
                WHERE feederId = ?
            `),
            selectFeederOperationalStatus: this.database.prepare(`
                SELECT operationalStatus, operationalReason, operationalUpdatedAt
                FROM Feeders
                WHERE feederId = ?
            `)
        };
    }

    transaction(callback) {
        this.assertOpen();
        this.database.exec("BEGIN IMMEDIATE;");
        try {
            const result = callback();
            this.database.exec("COMMIT;");
            return result;
        } catch (error) {
            this.database.exec("ROLLBACK;");
            throw error;
        }
    }

    saveBarn(barn) {
        this.assertOpen();
        this.statements.insertBarn.run(
            barn.barnId,
            barn.name,
            barn.timezone,
            barn.createdAt
        );
        return { ...barn };
    }

    saveFeeder(feeder) {
        this.assertOpen();
        this.statements.insertFeeder.run(
            feeder.feederId,
            feeder.barnId,
            feeder.name,
            feeder.createdAt
        );
        return { ...feeder };
    }

    saveCamera(camera) {
        this.assertOpen();
        this.statements.insertCamera.run(
            camera.cameraId,
            camera.barnId,
            camera.name,
            camera.createdAt
        );
        return { ...camera };
    }

    saveDevice(device) {
        this.assertOpen();
        this.statements.insertDevice.run(
            device.deviceId,
            device.barnId,
            device.name,
            device.kind,
            device.createdAt
        );
        return { ...device };
    }

    saveQueue(queue) {
        this.assertOpen();
        this.statements.insertResourceQueue.run(
            queue.queueId,
            queue.barnId,
            queue.feederId,
            queue.resourceType,
            queue.resourceId,
            queue.name,
            queue.createdAt
        );
        return { ...queue };
    }

    getResources() {
        this.assertOpen();
        return {
            barns: this.statements.selectBarns.all(),
            feeders: this.statements.selectFeeders.all(),
            cameras: this.statements.selectCameras.all(),
            devices: this.statements.selectDevices.all(),
            queues: this.statements.selectResourceQueues.all()
        };
    }

    getDefaultResourceAssignment() {
        this.assertOpen();
        const assignment = this.statements.selectDefaultAssignment.get(
            DEFAULT_RESOURCE_IDS.queueId
        );
        if (!assignment) {
            throw new Error("Default Event Engine resources are missing.");
        }
        return { ...assignment };
    }

    getQueueForFeeder(feederId) {
        this.assertOpen();
        const queue = this.statements.selectQueueByFeeder.get(feederId);
        return queue ? { ...queue } : null;
    }

    getFeederOperationalStatus(feederId) {
        this.assertOpen();
        const row = this.statements.selectFeederOperationalStatus.get(feederId);
        return row ? { ...row } : null;
    }

    createProviderEvent(providerEvent, auditRecord) {
        this.transaction(() => {
            this.statements.insertProviderEvent.run(
                providerEvent.providerEventId,
                providerEvent.provider,
                providerEvent.externalEventId,
                providerEvent.receivedAt,
                providerEvent.verificationStatus,
                serializeJson(providerEvent.rawMetadata),
                providerEvent.rejectionReason,
                providerEvent.createdAt,
                providerEvent.updatedAt
            );
            this.insertAuditRecord(auditRecord);
        });
        return { ...providerEvent };
    }

    getProviderEvent(providerEventId) {
        this.assertOpen();
        return mapProviderEvent(
            this.statements.selectProviderEventById.get(providerEventId)
        );
    }

    getProviderEventByExternalId(provider, externalEventId) {
        this.assertOpen();
        return mapProviderEvent(
            this.statements.selectProviderEventByExternalId.get(
                provider,
                externalEventId
            )
        );
    }

    getContribution(contributionId) {
        this.assertOpen();
        return mapContribution(
            this.statements.selectContributionById.get(contributionId)
        );
    }

    getContributionByProviderEvent(providerEventId) {
        this.assertOpen();
        return mapContribution(
            this.statements.selectContributionByProviderEventId.get(providerEventId)
        );
    }

    getContributionsWithoutFeedIntents() {
        this.assertOpen();
        return this.statements.selectContributionsWithoutFeedIntent.all()
            .map(mapContribution);
    }

    getFeedIntent(feedIntentId) {
        this.assertOpen();
        return mapFeedIntent(
            this.statements.selectFeedIntentById.get(feedIntentId)
        );
    }

    getFeedIntentByContribution(contributionId) {
        this.assertOpen();
        return mapFeedIntent(
            this.statements.selectFeedIntentByContribution.get(contributionId)
        );
    }

    getOutboxEntry(feedIntentId) {
        this.assertOpen();
        return mapOutboxEntry(
            this.statements.selectOutboxByFeedIntent.get(feedIntentId)
        );
    }

    getFeedIntentHistory(feedIntentId) {
        this.assertOpen();
        return this.statements.selectFeedIntentHistory.all(feedIntentId)
            .map(mapFeedIntentHistory);
    }

    createFeedIntentOutbox(feedIntent, outboxEntry) {
        this.transaction(() => {
            this.insertFeedIntentOutbox(feedIntent, outboxEntry);
        });
        return {
            feedIntent: { ...feedIntent },
            outboxEntry: { ...outboxEntry }
        };
    }

    persistContributionDecision({
        providerEventId,
        verificationStatus,
        rejectionReason,
        updatedAt,
        contribution = null,
        feedIntent = null,
        outboxEntry = null,
        auditRecords = []
    }) {
        this.transaction(() => {
            const result = this.statements.updateProviderEventDecision.run(
                verificationStatus,
                rejectionReason,
                updatedAt,
                providerEventId
            );
            if (Number(result.changes) !== 1) {
                throw new Error(
                    `ProviderEvent ${providerEventId} is no longer pending verification.`
                );
            }

            if (contribution) {
                this.statements.insertContribution.run(
                    contribution.contributionId,
                    contribution.providerEventId,
                    contribution.verifiedAt,
                    contribution.amountMinor,
                    contribution.currency,
                    contribution.supporterDisplayName,
                    contribution.eligibilityStatus,
                    contribution.feedQuantity,
                    serializeJson(contribution.metadata),
                    contribution.createdAt,
                    contribution.updatedAt
                );

                if (!feedIntent || !outboxEntry) {
                    throw new Error(
                        "An eligible Contribution requires a FeedIntent and Outbox entry."
                    );
                }
                this.insertFeedIntentOutbox(feedIntent, outboxEntry);
            }

            auditRecords.forEach(auditRecord => {
                this.insertAuditRecord(auditRecord);
            });
        });
        return contribution ? { ...contribution } : null;
    }

    insertFeedIntentOutbox(feedIntent, outboxEntry) {
        if (outboxEntry.feedIntentId !== feedIntent.feedIntentId) {
            throw new Error("Outbox entry does not match its FeedIntent.");
        }

        this.statements.insertFeedIntent.run(
            feedIntent.feedIntentId,
            feedIntent.contributionId,
            feedIntent.barnId,
            feedIntent.feederId,
            feedIntent.queueId,
            feedIntent.message,
            feedIntent.status,
            feedIntent.createdAt,
            feedIntent.outboxQueuedAt,
            feedIntent.processingStartedAt,
            feedIntent.feedRequestCreatedAt,
            feedIntent.queueInsertionCompletedAt,
            feedIntent.processingCompletedAt,
            feedIntent.processingFailedAt,
            feedIntent.failureReason,
            feedIntent.attemptCount,
            feedIntent.updatedAt
        );
        this.statements.insertOutboxEntry.run(
            outboxEntry.outboxEntryId,
            outboxEntry.feedIntentId,
            outboxEntry.status,
            outboxEntry.createdAt,
            outboxEntry.availableAt,
            outboxEntry.processingStartedAt,
            outboxEntry.completedAt,
            outboxEntry.failedAt,
            outboxEntry.attemptCount,
            outboxEntry.lastError,
            outboxEntry.updatedAt
        );
        this.insertFeedIntentHistory(
            feedIntent.feedIntentId,
            "FEED_INTENT_CREATED",
            feedIntent.createdAt,
            { contributionId: feedIntent.contributionId }
        );
        this.insertFeedIntentHistory(
            feedIntent.feedIntentId,
            "OUTBOX_QUEUED",
            feedIntent.outboxQueuedAt,
            { outboxEntryId: outboxEntry.outboxEntryId }
        );
    }

    appendAuditRecord(auditRecord) {
        this.assertOpen();
        this.insertAuditRecord(auditRecord);
        return { ...auditRecord };
    }

    getAuditRecords({
        providerEventId = null,
        contributionId = null,
        eventId = null
    } = {}) {
        this.assertOpen();
        return this.statements.selectAuditRecords.all(
            providerEventId,
            providerEventId,
            contributionId,
            contributionId,
            eventId,
            eventId
        ).map(mapAuditRecord);
    }

    getEventIdByContribution(contributionId) {
        this.assertOpen();
        return this.statements.selectEventIdByContribution.get(contributionId)?.eventId
            || null;
    }

    getEventIdByFeedIntent(feedIntentId) {
        this.assertOpen();
        return this.statements.selectEventIdByFeedIntent.get(feedIntentId)?.eventId
            || null;
    }

    getProcessableOutboxEntries(now, limit = 100) {
        this.assertOpen();
        return this.statements.selectProcessableOutbox.all(now, limit)
            .map(mapOutboxEntry);
    }

    claimFeedIntent(feedIntentId, startedAt) {
        return this.transaction(() => {
            const outboxResult = this.statements.claimOutboxEntry.run(
                startedAt,
                startedAt,
                feedIntentId
            );
            const intentResult = this.statements.claimFeedIntent.run(
                startedAt,
                startedAt,
                feedIntentId
            );
            if (
                Number(outboxResult.changes) === 0
                && Number(intentResult.changes) === 0
            ) {
                return false;
            }
            if (
                Number(outboxResult.changes) !== 1
                || Number(intentResult.changes) !== 1
            ) {
                throw new Error(
                    `FeedIntent ${feedIntentId} could not be claimed consistently.`
                );
            }
            this.insertFeedIntentHistory(
                feedIntentId,
                "PROCESSING_STARTED",
                startedAt,
                null
            );
            return true;
        });
    }

    markFeedIntentFailed(feedIntentId, {
        failedAt,
        retryAt,
        error
    }) {
        this.transaction(() => {
            const message = String(error?.message || error || "Unknown processing failure")
                .slice(0, 1000);
            const outboxResult = this.statements.failOutboxEntry.run(
                retryAt,
                failedAt,
                message,
                failedAt,
                feedIntentId
            );
            const intentResult = this.statements.failFeedIntent.run(
                failedAt,
                message,
                failedAt,
                feedIntentId
            );
            if (
                Number(outboxResult.changes) !== 1
                || Number(intentResult.changes) !== 1
            ) {
                throw new Error(
                    `FeedIntent ${feedIntentId} could not be marked failed consistently.`
                );
            }
            this.insertFeedIntentHistory(
                feedIntentId,
                "PROCESSING_FAILED",
                failedAt,
                { error: message, retryAt }
            );
        });
    }

    recoverInterruptedFeedIntents(recoveredAt) {
        const processingEntries = this.statements.selectProcessingOutbox.all()
            .map(mapOutboxEntry);
        if (processingEntries.length === 0) {
            return [];
        }

        this.transaction(() => {
            processingEntries.forEach(entry => {
                const outboxResult = this.statements.recoverOutboxEntry.run(
                    recoveredAt,
                    recoveredAt,
                    entry.feedIntentId
                );
                const intentResult = this.statements.recoverFeedIntent.run(
                    recoveredAt,
                    entry.feedIntentId
                );
                if (
                    Number(outboxResult.changes) !== 1
                    || Number(intentResult.changes) !== 1
                ) {
                    throw new Error(
                        `FeedIntent ${entry.feedIntentId} could not be recovered consistently.`
                    );
                }
                this.insertFeedIntentHistory(
                    entry.feedIntentId,
                    "PROCESSING_RECOVERED",
                    recoveredAt,
                    { reason: "SERVER_RESTART" }
                );
            });
        });
        return processingEntries.map(entry => entry.feedIntentId);
    }

    insertFeedIntentHistory(feedIntentId, action, timestamp, details) {
        this.statements.insertFeedIntentHistory.run(
            feedIntentId,
            action,
            timestamp,
            serializeJson(details)
        );
    }

    insertAuditRecord(auditRecord) {
        this.statements.insertAuditRecord.run(
            auditRecord.auditRecordId,
            auditRecord.action,
            auditRecord.providerEventId,
            auditRecord.contributionId,
            auditRecord.eventId,
            auditRecord.occurredAt,
            serializeJson(auditRecord.details)
        );
    }

    createQueuedEvent(feedRequest, {
        queuePosition = feedRequest.sequenceNumber,
        auditRecord = null,
        feedIntentId = feedRequest.feedIntentId
    } = {}) {
        this.transaction(() => {
            this.statements.insertEvent.run(
                feedRequest.eventId,
                feedRequest.type,
                feedRequest.sequenceNumber,
                feedRequest.supporterName,
                feedRequest.source,
                feedRequest.message,
                feedRequest.clientRequestId,
                feedRequest.requestedAt,
                feedRequest.updatedAt,
                feedRequest.state,
                feedRequest.barnId,
                feedRequest.feederId,
                feedRequest.queueId,
                feedRequest.contributionId,
                feedIntentId
            );

            feedRequest.timeline.forEach((entry, index) => {
                this.statements.insertHistory.run(
                    feedRequest.eventId,
                    index + 1,
                    entry.state,
                    entry.timestamp,
                    serializeJson(entry.details)
                );
            });

            this.statements.insertQueue.run(
                feedRequest.eventId,
                feedRequest.queueId,
                queuePosition,
                feedRequest.stateTimestamps.QUEUED
            );

            if (auditRecord) {
                this.insertAuditRecord({
                    ...auditRecord,
                    eventId: feedRequest.eventId
                });
            }

            const createdAt = feedRequest.requestedAt;
            const queuedAt = feedRequest.stateTimestamps.QUEUED;
            const intentResult = this.statements.completeFeedIntent.run(
                createdAt,
                queuedAt,
                queuedAt,
                queuedAt,
                feedIntentId
            );
            const outboxResult = this.statements.completeOutboxEntry.run(
                queuedAt,
                queuedAt,
                feedIntentId
            );
            if (
                Number(intentResult.changes) !== 1
                || Number(outboxResult.changes) !== 1
            ) {
                throw new Error(
                    `FeedIntent ${feedIntentId} was not claimed by the Outbox worker.`
                );
            }
            this.insertFeedIntentHistory(
                feedIntentId,
                "FEED_REQUEST_CREATED",
                createdAt,
                { eventId: feedRequest.eventId }
            );
            this.insertFeedIntentHistory(
                feedIntentId,
                "QUEUE_INSERTION_COMPLETED",
                queuedAt,
                { eventId: feedRequest.eventId, queueId: feedRequest.queueId }
            );
            this.insertFeedIntentHistory(
                feedIntentId,
                "PROCESSING_COMPLETED",
                queuedAt,
                { eventId: feedRequest.eventId }
            );
        });
    }

    appendLifecycleTransition(feedRequest, timelineEntry) {
        this.transaction(() => {
            this.statements.insertHistory.run(
                feedRequest.eventId,
                feedRequest.timeline.length + 1,
                timelineEntry.state,
                timelineEntry.timestamp,
                serializeJson(timelineEntry.details)
            );

            const result = this.statements.updateEventState.run(
                timelineEntry.state,
                timelineEntry.timestamp,
                feedRequest.eventId,
                feedRequest.state
            );

            if (Number(result.changes) !== 1) {
                throw new Error(
                    `Persistent state for ${feedRequest.eventId} did not match ${feedRequest.state}.`
                );
            }
        });
    }

    removeFromQueue(eventId) {
        this.assertOpen();
        this.statements.deleteQueueEvent.run(eventId);
    }

    addHardwareAcknowledgement(eventId, acknowledgement) {
        this.transaction(() => {
            this.statements.insertAcknowledgement.run(
                eventId,
                acknowledgement.stage,
                acknowledgement.status,
                acknowledgement.receivedAt,
                serializeJson(acknowledgement.details)
            );
            this.statements.updateEventTimestamp.run(
                acknowledgement.receivedAt,
                eventId
            );
        });
    }

    setEventSafetyState(eventId, safetyState, timestamp) {
        this.assertOpen();
        const result = this.statements.updateEventSafetyState.run(
            safetyState,
            timestamp,
            timestamp,
            eventId
        );
        if (Number(result.changes) !== 1) {
            throw new Error(`Persistent event ${eventId} was not found.`);
        }
    }

    loadState() {
        this.assertOpen();
        const historiesByEvent = new Map();
        const acknowledgementsByEvent = new Map();

        this.statements.selectHistory.all().forEach(row => {
            const entries = historiesByEvent.get(row.eventId) || [];
            entries.push({
                state: row.state,
                timestamp: row.timestamp,
                details: parseJson(row.detailsJson)
            });
            historiesByEvent.set(row.eventId, entries);
        });

        this.statements.selectAcknowledgements.all().forEach(row => {
            const entries = acknowledgementsByEvent.get(row.eventId) || [];
            entries.push({
                stage: row.stage,
                status: row.status,
                receivedAt: row.receivedAt,
                details: parseJson(row.detailsJson)
            });
            acknowledgementsByEvent.set(row.eventId, entries);
        });

        const events = this.statements.selectEvents.all().map(row => {
            const timeline = historiesByEvent.get(row.eventId) || [];
            const acknowledgementHistory = acknowledgementsByEvent.get(row.eventId) || [];
            const stateTimestamps = Object.fromEntries(
                timeline.map(entry => [entry.state, entry.timestamp])
            );
            const hardwareAcknowledgements = {
                BELL: null,
                DISPENSING: null
            };
            acknowledgementHistory.forEach(entry => {
                hardwareAcknowledgements[entry.stage] = entry;
            });

            return {
                id: row.eventId,
                eventId: row.eventId,
                type: row.type,
                state: row.currentState,
                status: row.currentState,
                lifecycleState: row.currentState,
                safetyState: row.safetyState,
                safetyUpdatedAt: row.safetyUpdatedAt,
                sequenceNumber: row.sequenceNumber,
                supporterName: row.supporterName,
                source: row.source,
                message: row.message,
                clientRequestId: row.clientRequestId,
                contributionId: row.contributionId,
                feedIntentId: row.feedIntentId,
                barnId: row.barnId,
                feederId: row.feederId,
                queueId: row.queueId,
                requestedAt: row.requestedAt,
                updatedAt: row.updatedAt,
                stateTimestamps,
                timeline,
                hardwareAcknowledgements,
                acknowledgementHistory
            };
        });

        const queueEntries = this.statements.selectQueue.all();
        return {
            events,
            queueEntries,
            queueEventIds: queueEntries.map(row => row.eventId)
        };
    }

    clearAll() {
        this.transaction(() => {
            this.database.exec(`
                DELETE FROM WelfareSafetyLedger;
                DELETE FROM ApprovalDecisions;
                DELETE FROM ApprovalRequestHistory;
                DELETE FROM DeviceAcknowledgements;
                DELETE FROM SimulatedDeviceExecutions;
                DELETE FROM SimulatedDeviceFences;
                DELETE FROM DeviceCommandAuditRecords;
                DELETE FROM DeviceCommandHistory;
                DELETE FROM DeviceCommandOutbox;
                DELETE FROM DeviceCommands;
                DELETE FROM OperatorResolutionCases;
                DELETE FROM ApprovalRequests;
                DELETE FROM EmergencyStops;
                DELETE FROM AuditRecords;
                DELETE FROM Events;
                DELETE FROM FeedIntentHistory;
                DELETE FROM Outbox;
                DELETE FROM FeedIntents;
                DELETE FROM Contributions;
                DELETE FROM ProviderEvents;
                UPDATE Feeders
                SET safetyStatus = 'ONLINE', safetyReason = NULL,
                    safetyUpdatedAt = NULL;
            `);
        });
    }

    getQueueEntries(queueId = null) {
        this.assertOpen();
        return this.statements.selectQueue.all()
            .filter(entry => queueId === null || entry.queueId === queueId);
    }

    getSchemaVersion() {
        this.assertOpen();
        return this.schemaVersion;
    }

    getTableNames() {
        this.assertOpen();
        return this.database.prepare(`
            SELECT name
            FROM sqlite_schema
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name ASC
        `).all().map(row => row.name);
    }

    close() {
        if (this.closed) {
            return;
        }

        this.database.close();
        this.closed = true;
    }

    assertOpen() {
        if (this.closed) {
            throw new Error("SQLite Event Store is closed.");
        }
    }
}
