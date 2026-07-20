import { randomUUID } from "node:crypto";

import {
    DEFAULT_DEVICE_ID,
    DEFAULT_RESOURCE_IDS
} from "../domain/resources.js";

function parseJson(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    return JSON.parse(value);
}

function serializeJson(value) {
    return JSON.stringify(value ?? null);
}

function mapCommand(row) {
    return row ? {
        commandSequence: row.commandSequence,
        commandId: row.commandId,
        eventId: row.eventId,
        barnId: row.barnId,
        feederId: row.feederId,
        deviceId: row.deviceId,
        commandType: row.commandType,
        commandPayload: parseJson(row.commandPayloadJson),
        idempotencyKey: row.idempotencyKey,
        fencingToken: row.fencingToken,
        status: row.status,
        attemptCount: row.attemptCount,
        maximumAttempts: row.maximumAttempts,
        acknowledgementDeadline: row.acknowledgementDeadline,
        nextAttemptAt: row.nextAttemptAt,
        createdAt: row.createdAt,
        sentAt: row.sentAt,
        acknowledgedAt: row.acknowledgedAt,
        completedAt: row.completedAt,
        failedAt: row.failedAt,
        lastError: row.lastError,
        updatedAt: row.updatedAt,
        replacementOfCommandId: row.replacementOfCommandId,
        resolutionCaseId: row.resolutionCaseId
    } : null;
}

function mapAcknowledgement(row) {
    return row ? {
        acknowledgementSequence: row.acknowledgementSequence,
        acknowledgementId: row.acknowledgementId,
        commandId: row.commandId,
        deviceId: row.deviceId,
        acknowledgementType: row.acknowledgementType,
        receivedAt: row.receivedAt,
        deviceTimestamp: row.deviceTimestamp,
        result: row.result,
        measuredQuantity: row.measuredQuantity,
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
        metadata: parseJson(row.metadataJson)
    } : null;
}

export class SqliteDeviceCommandStore {
    constructor({ eventStore, idGenerator = randomUUID }) {
        this.eventStore = eventStore;
        this.database = eventStore.database;
        this.idGenerator = idGenerator;
        this.prepareStatements();
    }

    prepareStatements() {
        this.statements = {
            selectAssignment: this.database.prepare(`
                SELECT feederId, barnId, deviceId, createdAt
                FROM FeederDeviceAssignments
                WHERE feederId = ?
            `),
            insertSimulatedDevice: this.database.prepare(`
                INSERT OR IGNORE INTO Devices (
                    deviceId, barnId, name, kind, createdAt
                ) VALUES (?, ?, ?, 'SIMULATED_FEEDER_CONTROLLER', ?)
            `),
            insertAssignment: this.database.prepare(`
                INSERT INTO FeederDeviceAssignments (
                    feederId, barnId, deviceId, createdAt
                ) VALUES (?, ?, ?, ?)
            `),
            selectCommandById: this.database.prepare(`
                SELECT * FROM DeviceCommands WHERE commandId = ?
            `),
            selectCommandByEventAction: this.database.prepare(`
                SELECT *
                FROM DeviceCommands
                WHERE eventId = ? AND commandType = ?
                ORDER BY commandSequence DESC
                LIMIT 1
            `),
            selectOriginalCommandByEventAction: this.database.prepare(`
                SELECT *
                FROM DeviceCommands
                WHERE eventId = ? AND commandType = ?
                  AND replacementOfCommandId IS NULL
            `),
            selectCommandByResolutionCase: this.database.prepare(`
                SELECT * FROM DeviceCommands WHERE resolutionCaseId = ?
            `),
            selectDeviceOperationalStatus: this.database.prepare(`
                SELECT operationalStatus, operationalReason, operationalUpdatedAt
                FROM Devices
                WHERE deviceId = ?
            `),
            selectMaximumFencingToken: this.database.prepare(`
                SELECT COALESCE(MAX(fencingToken), 0) AS maximumToken
                FROM DeviceCommands
                WHERE feederId = ?
            `),
            insertCommand: this.database.prepare(`
                INSERT INTO DeviceCommands (
                    commandId,
                    eventId,
                    barnId,
                    feederId,
                    deviceId,
                    commandType,
                    commandPayloadJson,
                    idempotencyKey,
                    fencingToken,
                    status,
                    attemptCount,
                    maximumAttempts,
                    acknowledgementDeadline,
                    nextAttemptAt,
                    createdAt,
                    sentAt,
                    acknowledgedAt,
                    completedAt,
                    failedAt,
                    lastError,
                    updatedAt,
                    replacementOfCommandId,
                    resolutionCaseId
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            updateCommand: this.database.prepare(`
                UPDATE DeviceCommands
                SET status = ?,
                    attemptCount = ?,
                    acknowledgementDeadline = ?,
                    nextAttemptAt = ?,
                    sentAt = ?,
                    acknowledgedAt = ?,
                    completedAt = ?,
                    failedAt = ?,
                    lastError = ?,
                    updatedAt = ?
                WHERE commandId = ? AND status = ?
            `),
            insertOutbox: this.database.prepare(`
                INSERT INTO DeviceCommandOutbox (
                    commandId, status, availableAt, claimedAt,
                    completedAt, createdAt, updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `),
            updateOutbox: this.database.prepare(`
                UPDATE DeviceCommandOutbox
                SET status = ?,
                    availableAt = ?,
                    claimedAt = ?,
                    completedAt = ?,
                    updatedAt = ?
                WHERE commandId = ?
            `),
            selectNextHistoryOrdinal: this.database.prepare(`
                SELECT COALESCE(MAX(ordinal), 0) + 1 AS nextOrdinal
                FROM DeviceCommandHistory
                WHERE commandId = ?
            `),
            insertHistory: this.database.prepare(`
                INSERT INTO DeviceCommandHistory (
                    commandId, ordinal, fromStatus, toStatus, timestamp, detailsJson
                ) VALUES (?, ?, ?, ?, ?, ?)
            `),
            insertAudit: this.database.prepare(`
                INSERT INTO DeviceCommandAuditRecords (
                    auditRecordId, commandId, acknowledgementId,
                    action, occurredAt, detailsJson
                ) VALUES (?, ?, ?, ?, ?, ?)
            `),
            selectDeliverableCommands: this.database.prepare(`
                SELECT command.*
                FROM DeviceCommands AS command
                JOIN DeviceCommandOutbox AS outbox
                  ON outbox.commandId = command.commandId
                JOIN Devices AS device
                  ON device.deviceId = command.deviceId
                WHERE command.status IN ('PENDING', 'READY', 'RETRY_SCHEDULED')
                  AND outbox.status = 'PENDING'
                  AND device.operationalStatus = 'AVAILABLE'
                  AND (command.nextAttemptAt IS NULL OR command.nextAttemptAt <= ?)
                  AND outbox.availableAt <= ?
                  AND NOT EXISTS (
                      SELECT 1
                      FROM DeviceCommands AS earlier
                      WHERE earlier.feederId = command.feederId
                        AND earlier.commandSequence < command.commandSequence
                        AND earlier.status NOT IN (
                            'ACKNOWLEDGED', 'FAILED', 'OUTCOME_UNKNOWN', 'CANCELLED'
                        )
                  )
                ORDER BY command.commandSequence ASC
                LIMIT ?
            `),
            selectOutstandingCommands: this.database.prepare(`
                SELECT *
                FROM DeviceCommands
                WHERE status IN ('SENT', 'TIMED_OUT')
                ORDER BY commandSequence ASC
            `),
            selectCommandsForEvent: this.database.prepare(`
                SELECT *
                FROM DeviceCommands
                WHERE eventId = ?
                ORDER BY commandSequence ASC
            `),
            selectAllCommands: this.database.prepare(`
                SELECT * FROM DeviceCommands ORDER BY commandSequence ASC
            `),
            selectAcknowledgementById: this.database.prepare(`
                SELECT *
                FROM DeviceAcknowledgements
                WHERE acknowledgementId = ?
            `),
            selectAcknowledgementsForCommand: this.database.prepare(`
                SELECT *
                FROM DeviceAcknowledgements
                WHERE commandId = ?
                ORDER BY acknowledgementSequence ASC
            `),
            insertDeviceAcknowledgement: this.database.prepare(`
                INSERT INTO DeviceAcknowledgements (
                    acknowledgementId,
                    commandId,
                    deviceId,
                    acknowledgementType,
                    receivedAt,
                    deviceTimestamp,
                    result,
                    measuredQuantity,
                    errorCode,
                    errorMessage,
                    metadataJson
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            insertLegacyAcknowledgement: this.database.prepare(`
                INSERT INTO HardwareAcknowledgements (
                    eventId, stage, status, receivedAt, detailsJson
                ) VALUES (?, ?, ?, ?, ?)
            `),
            updateEventTimestamp: this.database.prepare(`
                UPDATE Events SET updatedAt = ? WHERE eventId = ?
            `),
            selectHistory: this.database.prepare(`
                SELECT
                    historySequence, commandId, ordinal, fromStatus,
                    toStatus, timestamp, detailsJson
                FROM DeviceCommandHistory
                WHERE commandId = ?
                ORDER BY ordinal ASC
            `),
            selectAudit: this.database.prepare(`
                SELECT
                    auditSequence, auditRecordId, commandId,
                    acknowledgementId, action, occurredAt, detailsJson
                FROM DeviceCommandAuditRecords
                WHERE commandId = ?
                ORDER BY auditSequence ASC
            `),
            selectSimulatedExecution: this.database.prepare(`
                SELECT
                    commandId, deviceId, fencingToken, performedAt,
                    acknowledgementJson, actionCount
                FROM SimulatedDeviceExecutions
                WHERE commandId = ?
            `),
            selectSimulatedFence: this.database.prepare(`
                SELECT deviceId, highestFencingToken, updatedAt
                FROM SimulatedDeviceFences
                WHERE deviceId = ?
            `),
            upsertSimulatedFence: this.database.prepare(`
                INSERT INTO SimulatedDeviceFences (
                    deviceId, highestFencingToken, updatedAt
                ) VALUES (?, ?, ?)
                ON CONFLICT(deviceId) DO UPDATE SET
                    highestFencingToken = excluded.highestFencingToken,
                    updatedAt = excluded.updatedAt
            `),
            insertSimulatedExecution: this.database.prepare(`
                INSERT INTO SimulatedDeviceExecutions (
                    commandId, deviceId, fencingToken, performedAt,
                    acknowledgementJson, actionCount
                ) VALUES (?, ?, ?, ?, ?, 1)
            `)
        };
    }

    ensureFeederDeviceAssignment({ feederId, barnId, createdAt }) {
        const existing = this.statements.selectAssignment.get(feederId);
        if (existing) {
            if (existing.barnId !== barnId) {
                throw new Error(`Feeder ${feederId} has an invalid Device assignment.`);
            }
            return { ...existing };
        }

        const deviceId = feederId === DEFAULT_RESOURCE_IDS.feederId
            ? DEFAULT_DEVICE_ID
            : `device_simulated_${feederId}`;
        return this.eventStore.transaction(() => {
            this.lockAllocation(`assignment:${feederId}`);
            const concurrent = this.statements.selectAssignment.get(feederId);
            if (concurrent) {
                return { ...concurrent };
            }
            this.statements.insertSimulatedDevice.run(
                deviceId,
                barnId,
                `Simulated controller for ${feederId}`,
                createdAt
            );
            this.statements.insertAssignment.run(
                feederId,
                barnId,
                deviceId,
                createdAt
            );
            return { feederId, barnId, deviceId, createdAt };
        });
    }

    createCommand(command) {
        const existing = mapCommand(this.statements.selectOriginalCommandByEventAction
            .get(command.eventId, command.commandType));
        if (existing) {
            return { command: existing, created: false };
        }

        return this.eventStore.transaction(() => {
            this.lockAllocation(`fencing:${command.feederId}`);
            const concurrent = mapCommand(
                this.statements.selectOriginalCommandByEventAction.get(
                    command.eventId,
                    command.commandType
                )
            );
            if (concurrent) {
                return { command: concurrent, created: false };
            }

            const fencingToken = Number(
                this.statements.selectMaximumFencingToken.get(command.feederId)
                    .maximumToken
            ) + 1;
            const persisted = {
                ...command,
                fencingToken,
                status: "READY",
                nextAttemptAt: command.createdAt,
                updatedAt: command.createdAt
            };
            this.insertCommand(persisted);
            this.statements.insertOutbox.run(
                persisted.commandId,
                "PENDING",
                persisted.nextAttemptAt,
                null,
                null,
                persisted.createdAt,
                persisted.updatedAt
            );
            this.insertStateChange(
                persisted.commandId,
                null,
                "PENDING",
                persisted.createdAt,
                { idempotencyKey: persisted.idempotencyKey }
            );
            this.insertStateChange(
                persisted.commandId,
                "PENDING",
                "READY",
                persisted.createdAt,
                { outbox: "QUEUED" }
            );
            return { command: { ...persisted }, created: true };
        });
    }

    createReplacementCommand(command) {
        const existing = command.resolutionCaseId
            ? mapCommand(this.statements.selectCommandByResolutionCase.get(
                command.resolutionCaseId
            ))
            : null;
        if (existing) {
            return { command: existing, created: false };
        }
        return this.eventStore.transaction(() => {
            this.lockAllocation(`fencing:${command.feederId}`);
            const concurrent = command.resolutionCaseId
                ? mapCommand(this.statements.selectCommandByResolutionCase.get(
                    command.resolutionCaseId
                ))
                : null;
            if (concurrent) {
                return { command: concurrent, created: false };
            }
            const fencingToken = Number(
                this.statements.selectMaximumFencingToken.get(command.feederId)
                    .maximumToken
            ) + 1;
            const persisted = {
                ...command,
                fencingToken,
                status: "READY",
                nextAttemptAt: command.createdAt,
                updatedAt: command.createdAt
            };
            this.insertCommand(persisted);
            this.statements.insertOutbox.run(
                persisted.commandId,
                "PENDING",
                persisted.nextAttemptAt,
                null,
                null,
                persisted.createdAt,
                persisted.updatedAt
            );
            this.insertStateChange(
                persisted.commandId,
                null,
                "PENDING",
                persisted.createdAt,
                {
                    idempotencyKey: persisted.idempotencyKey,
                    replacementOfCommandId: persisted.replacementOfCommandId,
                    resolutionCaseId: persisted.resolutionCaseId
                }
            );
            this.insertStateChange(
                persisted.commandId,
                "PENDING",
                "READY",
                persisted.createdAt,
                { outbox: "QUEUED", approvedReplacement: true }
            );
            return { command: { ...persisted }, created: true };
        });
    }

    insertCommand(command) {
        this.statements.insertCommand.run(
            command.commandId,
            command.eventId,
            command.barnId,
            command.feederId,
            command.deviceId,
            command.commandType,
            serializeJson(command.commandPayload),
            command.idempotencyKey,
            command.fencingToken,
            command.status,
            command.attemptCount,
            command.maximumAttempts,
            command.acknowledgementDeadline,
            command.nextAttemptAt,
            command.createdAt,
            command.sentAt,
            command.acknowledgedAt,
            command.completedAt,
            command.failedAt,
            command.lastError,
            command.updatedAt,
            command.replacementOfCommandId,
            command.resolutionCaseId
        );
    }

    getCommand(commandId) {
        this.eventStore.assertOpen();
        return mapCommand(this.statements.selectCommandById.get(commandId));
    }

    getCommandForEventAction(eventId, commandType) {
        this.eventStore.assertOpen();
        return mapCommand(
            this.statements.selectCommandByEventAction.get(eventId, commandType)
        );
    }

    getDeviceOperationalStatus(deviceId) {
        this.eventStore.assertOpen();
        const row = this.statements.selectDeviceOperationalStatus.get(deviceId);
        return row ? { ...row } : null;
    }

    getCommandsForEvent(eventId) {
        this.eventStore.assertOpen();
        return this.statements.selectCommandsForEvent.all(eventId).map(mapCommand);
    }

    getAllCommands() {
        this.eventStore.assertOpen();
        return this.statements.selectAllCommands.all().map(mapCommand);
    }

    getDeliverableCommands(now, limit = 100) {
        this.eventStore.assertOpen();
        return this.statements.selectDeliverableCommands.all(now, now, limit)
            .map(mapCommand);
    }

    getOutstandingCommands() {
        this.eventStore.assertOpen();
        return this.statements.selectOutstandingCommands.all().map(mapCommand);
    }

    transitionCommand(commandId, toStatus, options = {}) {
        return this.eventStore.transaction(() => this.applyTransition(
            commandId,
            toStatus,
            options
        ));
    }

    applyTransition(commandId, toStatus, {
        timestamp,
        details = null,
        acknowledgementDeadline,
        nextAttemptAt,
        lastError,
        incrementAttempt = false
    }) {
        const current = mapCommand(this.statements.selectCommandById.get(commandId));
        if (!current) {
            throw new Error(`DeviceCommand ${commandId} was not found.`);
        }
        if (current.status === toStatus) {
            return current;
        }

        const next = {
            ...current,
            status: toStatus,
            updatedAt: timestamp,
            attemptCount: current.attemptCount + (incrementAttempt ? 1 : 0),
            acknowledgementDeadline: acknowledgementDeadline === undefined
                ? current.acknowledgementDeadline
                : acknowledgementDeadline,
            nextAttemptAt: nextAttemptAt === undefined
                ? current.nextAttemptAt
                : nextAttemptAt,
            lastError: lastError === undefined ? current.lastError : lastError
        };
        if (toStatus === "SENT") {
            next.sentAt = timestamp;
            next.failedAt = null;
        }
        if (toStatus === "ACKNOWLEDGED") {
            next.acknowledgedAt = timestamp;
            next.completedAt = timestamp;
            next.nextAttemptAt = null;
            next.lastError = null;
        }
        if (toStatus === "FAILED" || toStatus === "OUTCOME_UNKNOWN") {
            next.failedAt = timestamp;
            next.nextAttemptAt = null;
        }
        if (toStatus === "CANCELLED") {
            next.completedAt = timestamp;
            next.nextAttemptAt = null;
        }

        const result = this.statements.updateCommand.run(
            next.status,
            next.attemptCount,
            next.acknowledgementDeadline,
            next.nextAttemptAt,
            next.sentAt,
            next.acknowledgedAt,
            next.completedAt,
            next.failedAt,
            next.lastError,
            next.updatedAt,
            commandId,
            current.status
        );
        if (Number(result.changes) !== 1) {
            throw new Error(`DeviceCommand ${commandId} changed concurrently.`);
        }
        this.updateOutboxForCommand(next, timestamp);
        this.insertStateChange(
            commandId,
            current.status,
            toStatus,
            timestamp,
            {
                ...details,
                attemptCount: next.attemptCount,
                lastError: next.lastError
            }
        );
        return next;
    }

    updateOutboxForCommand(command, timestamp) {
        let status = "PROCESSING";
        let availableAt = command.nextAttemptAt || timestamp;
        let claimedAt = null;
        let completedAt = null;
        if (["PENDING", "READY", "RETRY_SCHEDULED"].includes(command.status)) {
            status = "PENDING";
        } else if (command.status === "SENT" || command.status === "TIMED_OUT") {
            status = "PROCESSING";
            claimedAt = command.sentAt || timestamp;
        } else if (command.status === "CANCELLED") {
            status = "CANCELLED";
            completedAt = timestamp;
        } else {
            status = "COMPLETED";
            completedAt = timestamp;
        }
        this.statements.updateOutbox.run(
            status,
            availableAt,
            claimedAt,
            completedAt,
            timestamp,
            command.commandId
        );
    }

    recordAcknowledgement(acknowledgement, {
        transitions = [],
        late = false,
        outOfOrder = false,
        legacyAcknowledgement = null
    } = {}) {
        const existing = this.getAcknowledgement(acknowledgement.acknowledgementId);
        if (existing) {
            return {
                acknowledgement: existing,
                command: this.getCommand(existing.commandId),
                duplicate: true,
                late: false,
                outOfOrder: false
            };
        }

        return this.eventStore.transaction(() => {
            const concurrent = mapAcknowledgement(
                this.statements.selectAcknowledgementById.get(
                    acknowledgement.acknowledgementId
                )
            );
            if (concurrent) {
                return {
                    acknowledgement: concurrent,
                    command: mapCommand(
                        this.statements.selectCommandById.get(concurrent.commandId)
                    ),
                    duplicate: true,
                    late: false,
                    outOfOrder: false
                };
            }

            this.statements.insertDeviceAcknowledgement.run(
                acknowledgement.acknowledgementId,
                acknowledgement.commandId,
                acknowledgement.deviceId,
                acknowledgement.acknowledgementType,
                acknowledgement.receivedAt,
                acknowledgement.deviceTimestamp,
                acknowledgement.result,
                acknowledgement.measuredQuantity,
                acknowledgement.errorCode,
                acknowledgement.errorMessage,
                serializeJson(acknowledgement.metadata)
            );
            this.insertAudit(
                acknowledgement.commandId,
                "ACKNOWLEDGEMENT_RECEIVED",
                acknowledgement.receivedAt,
                {
                    result: acknowledgement.result,
                    acknowledgementType: acknowledgement.acknowledgementType
                },
                acknowledgement.acknowledgementId
            );
            if (late) {
                this.insertAudit(
                    acknowledgement.commandId,
                    "LATE_ACKNOWLEDGEMENT",
                    acknowledgement.receivedAt,
                    { result: acknowledgement.result },
                    acknowledgement.acknowledgementId
                );
            }
            if (outOfOrder) {
                this.insertAudit(
                    acknowledgement.commandId,
                    "OUT_OF_ORDER_ACKNOWLEDGEMENT",
                    acknowledgement.receivedAt,
                    { result: acknowledgement.result },
                    acknowledgement.acknowledgementId
                );
            }

            let command = mapCommand(
                this.statements.selectCommandById.get(acknowledgement.commandId)
            );
            transitions.forEach(transition => {
                command = this.applyTransition(
                    acknowledgement.commandId,
                    transition.status,
                    {
                        timestamp: transition.timestamp,
                        details: transition.details,
                        lastError: transition.lastError
                    }
                );
            });

            if (legacyAcknowledgement) {
                this.statements.insertLegacyAcknowledgement.run(
                    command.eventId,
                    legacyAcknowledgement.stage,
                    legacyAcknowledgement.status,
                    acknowledgement.receivedAt,
                    serializeJson(legacyAcknowledgement.details)
                );
                this.statements.updateEventTimestamp.run(
                    acknowledgement.receivedAt,
                    command.eventId
                );
            }

            return {
                acknowledgement: { ...acknowledgement },
                command,
                duplicate: false,
                late,
                outOfOrder
            };
        });
    }

    getAcknowledgement(acknowledgementId) {
        this.eventStore.assertOpen();
        return mapAcknowledgement(
            this.statements.selectAcknowledgementById.get(acknowledgementId)
        );
    }

    getAcknowledgementsForCommand(commandId) {
        this.eventStore.assertOpen();
        return this.statements.selectAcknowledgementsForCommand.all(commandId)
            .map(mapAcknowledgement);
    }

    getHistory(commandId) {
        this.eventStore.assertOpen();
        return this.statements.selectHistory.all(commandId).map(row => ({
            historySequence: row.historySequence,
            commandId: row.commandId,
            ordinal: row.ordinal,
            fromStatus: row.fromStatus,
            toStatus: row.toStatus,
            timestamp: row.timestamp,
            details: parseJson(row.detailsJson)
        }));
    }

    getAuditRecords(commandId) {
        this.eventStore.assertOpen();
        return this.statements.selectAudit.all(commandId).map(row => ({
            auditSequence: row.auditSequence,
            auditRecordId: row.auditRecordId,
            commandId: row.commandId,
            acknowledgementId: row.acknowledgementId,
            action: row.action,
            occurredAt: row.occurredAt,
            details: parseJson(row.detailsJson)
        }));
    }

    appendAuditRecord(
        commandId,
        action,
        occurredAt,
        details,
        acknowledgementId = null
    ) {
        this.eventStore.transaction(() => {
            this.insertAudit(
                commandId,
                action,
                occurredAt,
                details,
                acknowledgementId
            );
        });
    }

    insertStateChange(commandId, fromStatus, toStatus, timestamp, details) {
        const ordinal = Number(
            this.statements.selectNextHistoryOrdinal.get(commandId).nextOrdinal
        );
        this.statements.insertHistory.run(
            commandId,
            ordinal,
            fromStatus,
            toStatus,
            timestamp,
            serializeJson(details)
        );
        this.insertAudit(
            commandId,
            "COMMAND_STATE_CHANGED",
            timestamp,
            { fromStatus, toStatus, ...details }
        );
    }

    insertAudit(
        commandId,
        action,
        occurredAt,
        details,
        acknowledgementId = null
    ) {
        this.statements.insertAudit.run(
            `device_audit_${this.idGenerator()}`,
            commandId,
            acknowledgementId,
            action,
            occurredAt,
            serializeJson(details)
        );
    }

    recordSimulatedExecution(command, acknowledgement, performedAt) {
        const existing = this.getSimulatedExecution(command.commandId);
        if (existing) {
            return { execution: existing, created: false };
        }
        return this.eventStore.transaction(() => {
            this.lockAllocation(`execution:${command.deviceId}`);
            const concurrent = this.readSimulatedExecution(command.commandId);
            if (concurrent) {
                return { execution: concurrent, created: false };
            }
            const fence = this.statements.selectSimulatedFence.get(command.deviceId);
            if (fence && command.fencingToken <= fence.highestFencingToken) {
                return {
                    execution: null,
                    created: false,
                    rejectedAsStale: true,
                    highestFencingToken: fence.highestFencingToken
                };
            }
            this.statements.insertSimulatedExecution.run(
                command.commandId,
                command.deviceId,
                command.fencingToken,
                performedAt,
                serializeJson(acknowledgement)
            );
            this.statements.upsertSimulatedFence.run(
                command.deviceId,
                command.fencingToken,
                performedAt
            );
            return {
                execution: {
                    commandId: command.commandId,
                    deviceId: command.deviceId,
                    fencingToken: command.fencingToken,
                    performedAt,
                    acknowledgement: { ...acknowledgement },
                    actionCount: 1
                },
                created: true
            };
        });
    }

    getSimulatedExecution(commandId) {
        this.eventStore.assertOpen();
        return this.readSimulatedExecution(commandId);
    }

    getSimulatedFence(deviceId) {
        this.eventStore.assertOpen();
        const row = this.statements.selectSimulatedFence.get(deviceId);
        return row ? { ...row } : null;
    }

    readSimulatedExecution(commandId) {
        const row = this.statements.selectSimulatedExecution.get(commandId);
        return row ? {
            commandId: row.commandId,
            deviceId: row.deviceId,
            fencingToken: row.fencingToken,
            performedAt: row.performedAt,
            acknowledgement: parseJson(row.acknowledgementJson),
            actionCount: row.actionCount
        } : null;
    }

    lockAllocation(key) {
        if (this.eventStore.databaseType === "postgres") {
            this.database.prepare(`
                SELECT pg_advisory_xact_lock(hashtext(?))
            `).get(`alpacaly-device:${key}`);
        }
    }
}
