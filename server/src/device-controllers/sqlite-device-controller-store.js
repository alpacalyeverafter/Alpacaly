import { randomUUID } from "node:crypto";

import {
    createSimulatedController,
    normalizeSimulationBehaviour
} from "../domain/device-controllers.js";

function parseJson(value) {
    return value === null || value === undefined ? null : JSON.parse(value);
}

function serializeJson(value) {
    return JSON.stringify(value ?? null);
}

function mapJournal(row) {
    return row ? {
        journalSequence: row.journalSequence,
        journalId: row.journalId,
        controllerId: row.controllerId,
        commandId: row.commandId,
        barnId: row.barnId,
        feederId: row.feederId,
        deviceId: row.deviceId,
        fencingToken: row.fencingToken,
        assignmentGeneration: row.assignmentGeneration,
        executionState: row.executionState,
        dispensePerformed: row.dispensePerformed === 1,
        receivedAt: row.receivedAt,
        acceptedAt: row.acceptedAt,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        updatedAt: row.updatedAt,
        finalAcknowledgement: parseJson(row.finalAcknowledgementJson),
        failureReason: row.failureReason,
        acknowledgementDeliverySucceeded:
            row.acknowledgementDeliverySucceeded === null
                ? null : row.acknowledgementDeliverySucceeded === 1,
        reconciliationState: row.reconciliationState,
        commandAction: row.commandAction,
        commandParameters: parseJson(row.commandParametersJson),
        evidenceAt: row.evidenceAt,
        controllerBootId: row.controllerBootId
    } : null;
}

export class SqliteDeviceControllerStore {
    constructor({
        eventStore,
        deviceCommandStore,
        heartbeatTimeoutMs = 15_000,
        offlineTimeoutMs = 30_000,
        authorityLeaseMs = 30_000,
        clock = () => new Date(),
        idGenerator = randomUUID
    }) {
        this.eventStore = eventStore;
        this.database = eventStore.database;
        this.deviceCommandStore = deviceCommandStore;
        this.heartbeatTimeoutMs = heartbeatTimeoutMs;
        this.offlineTimeoutMs = Math.max(heartbeatTimeoutMs, offlineTimeoutMs);
        this.authorityLeaseMs = authorityLeaseMs;
        this.clock = clock;
        this.idGenerator = idGenerator;
        this.prepareStatements();
    }

    prepareStatements() {
        this.statements = {
            insertController: this.database.prepare(`
                INSERT INTO SimulatedControllers (
                    controllerId, barnId, name, enabled, softwareVersion,
                    protocolVersion, lastSeenAt, connectionState,
                    simulationBehaviourJson, createdAt, updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            insertAssignment: this.database.prepare(`
                INSERT OR IGNORE INTO SimulatedControllerFeederAssignments (
                    controllerId, barnId, feederId, createdAt,
                    assignmentGeneration, authorityLeaseExpiresAt, updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `),
            selectController: this.database.prepare(`
                SELECT * FROM SimulatedControllers WHERE controllerId = ?
            `),
            selectControllers: this.database.prepare(`
                SELECT *
                FROM SimulatedControllers
                WHERE (? IS NULL OR barnId = ?)
                ORDER BY controllerSequence ASC
            `),
            selectControllerForFeeder: this.database.prepare(`
                SELECT controller.*
                FROM SimulatedControllers AS controller
                JOIN SimulatedControllerFeederAssignments AS assignment
                  ON assignment.controllerId = controller.controllerId
                WHERE assignment.feederId = ?
            `),
            selectFirstControllerForBarn: this.database.prepare(`
                SELECT *
                FROM SimulatedControllers
                WHERE barnId = ?
                ORDER BY controllerSequence ASC
                LIMIT 1
            `),
            selectAssignments: this.database.prepare(`
                SELECT controllerId, barnId, feederId, createdAt,
                       assignmentGeneration, authorityLeaseExpiresAt, updatedAt
                FROM SimulatedControllerFeederAssignments
                WHERE controllerId = ?
                ORDER BY feederId ASC
            `),
            selectAssignment: this.database.prepare(`
                SELECT controllerId, barnId, feederId, createdAt,
                       assignmentGeneration, authorityLeaseExpiresAt, updatedAt
                FROM SimulatedControllerFeederAssignments
                WHERE controllerId = ? AND feederId = ?
            `),
            selectFeeder: this.database.prepare(`
                SELECT feederId, barnId FROM Feeders WHERE feederId = ?
            `),
            updateHeartbeat: this.database.prepare(`
                UPDATE SimulatedControllers
                SET lastSeenAt = ?, connectionState = 'ONLINE', updatedAt = ?
                WHERE controllerId = ?
            `),
            updateConnection: this.database.prepare(`
                UPDATE SimulatedControllers
                SET connectionState = ?, updatedAt = ?
                WHERE controllerId = ?
            `),
            updateEnabled: this.database.prepare(`
                UPDATE SimulatedControllers
                SET enabled = ?, updatedAt = ?
                WHERE controllerId = ?
            `),
            updateAssignmentAuthority: this.database.prepare(`
                UPDATE SimulatedControllerFeederAssignments
                SET assignmentGeneration = ?, authorityLeaseExpiresAt = ?,
                    updatedAt = ?
                WHERE controllerId = ? AND feederId = ?
            `),
            reassignFeeder: this.database.prepare(`
                UPDATE SimulatedControllerFeederAssignments
                SET controllerId = ?, barnId = ?, assignmentGeneration = ?,
                    authorityLeaseExpiresAt = ?, updatedAt = ?
                WHERE feederId = ?
            `),
            selectAssignmentForFeeder: this.database.prepare(`
                SELECT controllerId, barnId, feederId, createdAt,
                       assignmentGeneration, authorityLeaseExpiresAt, updatedAt
                FROM SimulatedControllerFeederAssignments
                WHERE feederId = ?
            `),
            selectMaximumAssignmentGeneration: this.database.prepare(`
                SELECT COALESCE(MAX(assignmentGeneration), 0) AS maximumGeneration
                FROM ControllerAssignmentHistory
                WHERE feederId = ?
            `),
            insertAssignmentHistory: this.database.prepare(`
                INSERT INTO ControllerAssignmentHistory (
                    controllerId, barnId, feederId, assignmentGeneration,
                    assignmentStatus, authorityLeaseExpiresAt, reason,
                    approvalRequestId, occurredAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            selectAssignmentHistory: this.database.prepare(`
                SELECT * FROM ControllerAssignmentHistory
                WHERE feederId = ?
                ORDER BY assignmentHistorySequence ASC
            `),
            updateControllerBoot: this.database.prepare(`
                UPDATE SimulatedControllers
                SET controllerBootId = ?, bootCounter = bootCounter + 1,
                    lastControllerSequence = 0, updatedAt = ?
                WHERE controllerId = ?
            `),
            updateControllerProtocolState: this.database.prepare(`
                UPDATE SimulatedControllers
                SET controllerBootId = ?, bootCounter = ?,
                    lastControllerSequence = ?, lastHeartbeatReceivedAt = ?,
                    statusExpiresAt = ?, connectionState = ?, updatedAt = ?
                WHERE controllerId = ?
            `),
            updateBehaviour: this.database.prepare(`
                UPDATE SimulatedControllers
                SET simulationBehaviourJson = ?, updatedAt = ?
                WHERE controllerId = ?
            `),
            insertJournal: this.database.prepare(`
                INSERT INTO SimulatedControllerCommandJournal (
                    journalId, controllerId, commandId, barnId, feederId,
                    deviceId, fencingToken, executionState, dispensePerformed,
                    receivedAt, acceptedAt, startedAt, completedAt, updatedAt,
                    finalAcknowledgementJson, failureReason,
                    assignmentGeneration, reconciliationState,
                    commandAction, commandParametersJson, controllerBootId
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'RECEIVED', 0, ?, NULL, NULL,
                          NULL, ?, NULL, NULL, ?, 'PENDING', ?, ?, ?)
            `),
            selectJournalByCommand: this.database.prepare(`
                SELECT *
                FROM SimulatedControllerCommandJournal
                WHERE commandId = ?
            `),
            selectJournalById: this.database.prepare(`
                SELECT *
                FROM SimulatedControllerCommandJournal
                WHERE journalId = ?
            `),
            selectIncompleteJournals: this.database.prepare(`
                SELECT *
                FROM SimulatedControllerCommandJournal
                WHERE executionState IN ('RECEIVED', 'ACCEPTED', 'STARTED')
                ORDER BY journalSequence ASC
            `),
            selectRecentJournals: this.database.prepare(`
                SELECT *
                FROM SimulatedControllerCommandJournal
                WHERE controllerId = ?
                ORDER BY journalSequence DESC
                LIMIT ?
            `),
            updateJournal: this.database.prepare(`
                UPDATE SimulatedControllerCommandJournal
                SET executionState = ?, dispensePerformed = ?,
                    acceptedAt = ?, startedAt = ?, completedAt = ?,
                    updatedAt = ?, finalAcknowledgementJson = ?,
                    failureReason = ?, evidenceAt = ?
                WHERE journalId = ? AND executionState = ?
            `),
            updateJournalDelivery: this.database.prepare(`
                UPDATE SimulatedControllerCommandJournal
                SET acknowledgementDeliverySucceeded = ?,
                    reconciliationState = ?, updatedAt = ?
                WHERE journalId = ?
            `),
            insertJournalHistory: this.database.prepare(`
                INSERT INTO SimulatedControllerJournalHistory (
                    journalId, fromState, toState, timestamp, detailsJson
                ) VALUES (?, ?, ?, ?, ?)
            `),
            selectJournalHistory: this.database.prepare(`
                SELECT historySequence, journalId, fromState, toState,
                       timestamp, detailsJson
                FROM SimulatedControllerJournalHistory
                WHERE journalId = ?
                ORDER BY historySequence ASC
            `),
            insertOutboundDelivery: this.database.prepare(`
                INSERT INTO MqttOutboundDeliveries (
                    deliveryId, commandId, controllerId, assignmentGeneration,
                    topic, publishedAt, state
                ) VALUES (?, ?, ?, ?, ?, ?, 'PUBLISHING')
            `),
            updateOutboundDelivery: this.database.prepare(`
                UPDATE MqttOutboundDeliveries
                SET state = ?, brokerAcknowledgedAt = ?, failureCode = ?
                WHERE deliveryId = ?
            `),
            selectOutboundDeliveries: this.database.prepare(`
                SELECT * FROM MqttOutboundDeliveries
                WHERE commandId = ?
                ORDER BY deliverySequence DESC
            `),
            insertInboundMessage: this.database.prepare(`
                INSERT OR IGNORE INTO MqttInboundMessages (
                    controllerId, messageType, messageId, controllerBootId,
                    controllerSequence, receivedAt
                ) VALUES (?, ?, ?, ?, ?, ?)
            `),
            incrementInboundDuplicate: this.database.prepare(`
                UPDATE MqttInboundMessages
                SET duplicateCount = duplicateCount + 1
                WHERE controllerId = ? AND messageType = ? AND messageId = ?
            `),
            insertProtocolEvent: this.database.prepare(`
                INSERT INTO MqttProtocolEvents (
                    severity, eventType, code, controllerId, commandId,
                    topic, occurredAt, detailsJson
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `),
            selectProtocolEvents: this.database.prepare(`
                SELECT * FROM MqttProtocolEvents
                WHERE (? IS NULL OR controllerId = ?)
                ORDER BY protocolEventSequence DESC
                LIMIT ?
            `),
            selectSafetyState: this.database.prepare(`
                SELECT * FROM MqttSafetyStates WHERE scopeKey = ?
            `),
            upsertSafetyState: this.database.prepare(`
                INSERT INTO MqttSafetyStates (
                    scopeKey, level, barnId, feederId, generation,
                    active, reason, updatedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(scopeKey) DO UPDATE SET
                    generation = excluded.generation,
                    active = excluded.active,
                    reason = excluded.reason,
                    updatedAt = excluded.updatedAt
            `),
            selectSafetyStates: this.database.prepare(`
                SELECT * FROM MqttSafetyStates ORDER BY scopeKey ASC
            `)
        };
    }

    createController(input, feederIds = []) {
        const controller = createSimulatedController(input, {
            clock: this.clock,
            idGenerator: this.idGenerator
        });
        return this.eventStore.transaction(() => {
            this.statements.insertController.run(
                controller.controllerId,
                controller.barnId,
                controller.name,
                controller.enabled ? 1 : 0,
                controller.softwareVersion,
                controller.protocolVersion,
                controller.lastSeenAt,
                controller.connectionState,
                serializeJson(controller.simulationBehaviour),
                controller.createdAt,
                controller.updatedAt
            );
            feederIds.forEach(feederId => this.assignFeeder(
                controller.controllerId,
                controller.barnId,
                feederId,
                controller.createdAt
            ));
            return this.getController(controller.controllerId);
        });
    }

    ensureControllerForFeeder({ barnId, feederId, createdAt }) {
        const existing = this.getControllerForFeeder(feederId);
        if (existing) {
            return existing;
        }
        const feeder = this.statements.selectFeeder.get(feederId);
        if (!feeder || feeder.barnId !== barnId) {
            throw new Error("Controller assignment Feeder does not belong to its Barn.");
        }
        return this.eventStore.transaction(() => {
            const concurrent = this.getControllerForFeeder(feederId);
            if (concurrent) {
                return concurrent;
            }
            let controller = this.mapController(
                this.statements.selectFirstControllerForBarn.get(barnId)
            );
            if (!controller) {
                const controllerId = `controller_simulated_${this.idGenerator()}`;
                const created = createSimulatedController({
                    controllerId,
                    barnId,
                    name: `Simulated Controller for ${barnId}`,
                    enabled: true,
                    connectionState: "ONLINE",
                    lastSeenAt: createdAt,
                    createdAt
                }, { clock: this.clock, idGenerator: this.idGenerator });
                this.statements.insertController.run(
                    created.controllerId,
                    created.barnId,
                    created.name,
                    1,
                    created.softwareVersion,
                    created.protocolVersion,
                    created.lastSeenAt,
                    created.connectionState,
                    serializeJson(created.simulationBehaviour),
                    created.createdAt,
                    created.updatedAt
                );
                controller = created;
            }
            this.assignFeeder(controller.controllerId, barnId, feederId, createdAt);
            return this.getController(controller.controllerId);
        });
    }

    assignFeeder(controllerId, barnId, feederId, createdAt) {
        const assignmentGeneration = Math.max(
            1,
            Number(this.statements.selectMaximumAssignmentGeneration
                .get(feederId).maximumGeneration) + 1
        );
        const authorityLeaseExpiresAt = new Date(
            Date.parse(createdAt) + this.authorityLeaseMs
        ).toISOString();
        this.statements.insertAssignment.run(
            controllerId,
            barnId,
            feederId,
            createdAt,
            assignmentGeneration,
            authorityLeaseExpiresAt,
            createdAt
        );
        const assignment = this.getAssignmentForFeeder(feederId);
        if (assignment?.controllerId === controllerId) {
            const alreadyRecorded = this.getAssignmentHistory(feederId)
                .some(item => (
                    item.controllerId === controllerId
                    && item.assignmentGeneration === assignment.assignmentGeneration
                ));
            if (!alreadyRecorded) {
                this.recordAssignmentHistory(assignment, "ACTIVE", {
                    reason: "CONTROLLER_ASSIGNED",
                    occurredAt: createdAt
                });
            }
        }
        return assignment;
    }

    getController(controllerId) {
        this.eventStore.assertOpen();
        return this.mapController(this.statements.selectController.get(controllerId));
    }

    getControllers({ barnId = null } = {}) {
        this.eventStore.assertOpen();
        return this.statements.selectControllers.all(barnId, barnId)
            .map(row => this.mapController(row));
    }

    getControllerForFeeder(feederId) {
        this.eventStore.assertOpen();
        return this.mapController(
            this.statements.selectControllerForFeeder.get(feederId)
        );
    }

    getAssignments(controllerId) {
        return this.statements.selectAssignments.all(controllerId)
            .map(row => ({ ...row }));
    }

    getAssignmentForFeeder(feederId) {
        const row = this.statements.selectAssignmentForFeeder.get(feederId);
        return row ? { ...row } : null;
    }

    getAssignmentHistory(feederId) {
        return this.statements.selectAssignmentHistory.all(feederId)
            .map(row => ({ ...row }));
    }

    renewAuthorityLease(feederId, {
        timestamp = this.clock().toISOString(),
        authorityLeaseMs = this.authorityLeaseMs,
        incrementGeneration = false,
        reason = "AUTHORITY_LEASE_RENEWED",
        approvalRequestId = null
    } = {}) {
        const current = this.getAssignmentForFeeder(feederId);
        if (!current) {
            throw new Error(`Controller assignment for ${feederId} was not found.`);
        }
        const generation = current.assignmentGeneration
            + (incrementGeneration ? 1 : 0);
        const authorityLeaseExpiresAt = new Date(
            Date.parse(timestamp) + authorityLeaseMs
        ).toISOString();
        this.statements.updateAssignmentAuthority.run(
            generation,
            authorityLeaseExpiresAt,
            timestamp,
            current.controllerId,
            feederId
        );
        const next = this.getAssignmentForFeeder(feederId);
        if (incrementGeneration) {
            this.recordAssignmentHistory(next, "ACTIVE", {
                reason,
                approvalRequestId,
                occurredAt: timestamp
            });
        }
        return next;
    }

    reassignFeeder(feederId, controllerId, {
        timestamp = this.clock().toISOString(),
        reason = "CONTROLLER_REASSIGNED",
        approvalRequestId = null
    } = {}) {
        const nextController = this.requireController(controllerId);
        const feeder = this.statements.selectFeeder.get(feederId);
        if (!feeder || feeder.barnId !== nextController.barnId) {
            throw new Error("Controller and Feeder must belong to the same Barn.");
        }
        const current = this.getAssignmentForFeeder(feederId);
        if (!current) {
            return this.assignFeeder(
                controllerId,
                nextController.barnId,
                feederId,
                timestamp
            );
        }
        if (current.controllerId === controllerId) {
            return this.renewAuthorityLease(feederId, {
                timestamp,
                incrementGeneration: true,
                reason: "CONTROLLER_REINSTALLED",
                approvalRequestId
            });
        }
        const generation = Math.max(
            current.assignmentGeneration,
            Number(this.statements.selectMaximumAssignmentGeneration
                .get(feederId).maximumGeneration)
        ) + 1;
        const authorityLeaseExpiresAt = new Date(
            Date.parse(timestamp) + this.authorityLeaseMs
        ).toISOString();
        this.recordAssignmentHistory(current, "REPLACED", {
            reason,
            approvalRequestId,
            occurredAt: timestamp
        });
        this.statements.reassignFeeder.run(
            controllerId,
            nextController.barnId,
            generation,
            authorityLeaseExpiresAt,
            timestamp,
            feederId
        );
        const next = this.getAssignmentForFeeder(feederId);
        this.recordAssignmentHistory(next, "ACTIVE", {
            reason,
            approvalRequestId,
            occurredAt: timestamp
        });
        return next;
    }

    recordAssignmentHistory(assignment, status, {
        reason,
        approvalRequestId = null,
        occurredAt = this.clock().toISOString()
    }) {
        this.statements.insertAssignmentHistory.run(
            assignment.controllerId,
            assignment.barnId,
            assignment.feederId,
            assignment.assignmentGeneration,
            status,
            assignment.authorityLeaseExpiresAt,
            reason,
            approvalRequestId,
            occurredAt
        );
    }

    isAuthorized(controllerId, command) {
        const controller = this.getController(controllerId);
        const assignment = this.statements.selectAssignment.get(
            controllerId,
            command.feederId
        );
        return Boolean(
            controller
            && assignment
            && controller.barnId === command.barnId
            && assignment.barnId === command.barnId
            && !controller.revokedAt
            && (command.assignmentGeneration === undefined
                || command.assignmentGeneration === assignment.assignmentGeneration)
        );
    }

    heartbeat(controllerId, timestamp = this.clock().toISOString()) {
        this.requireController(controllerId);
        this.statements.updateHeartbeat.run(timestamp, timestamp, controllerId);
        return this.getController(controllerId);
    }

    setConnectionState(controllerId, state, timestamp = this.clock().toISOString()) {
        const normalized = String(state || "").trim().toUpperCase();
        if (!["ONLINE", "OFFLINE"].includes(normalized)) {
            throw new Error("Controller connection state is not supported.");
        }
        this.requireController(controllerId);
        this.statements.updateConnection.run(normalized, timestamp, controllerId);
        return this.getController(controllerId);
    }

    setEnabled(controllerId, enabled, timestamp = this.clock().toISOString()) {
        const current = this.requireController(controllerId);
        if (current.enabled === Boolean(enabled)) {
            return current;
        }
        this.eventStore.transaction(() => {
            this.statements.updateEnabled.run(enabled ? 1 : 0, timestamp, controllerId);
            current.assignments.forEach(assignment => {
                const generation = assignment.assignmentGeneration + 1;
                const lease = enabled
                    ? new Date(Date.parse(timestamp) + this.authorityLeaseMs).toISOString()
                    : timestamp;
                this.statements.updateAssignmentAuthority.run(
                    generation,
                    lease,
                    timestamp,
                    controllerId,
                    assignment.feederId
                );
                this.recordAssignmentHistory(
                    this.getAssignmentForFeeder(assignment.feederId),
                    enabled ? "ACTIVE" : "DISABLED",
                    {
                        reason: enabled
                            ? "CONTROLLER_RE_ENABLED"
                            : "CONTROLLER_DISABLED",
                        occurredAt: timestamp
                    }
                );
            });
        });
        return this.getController(controllerId);
    }

    setBehaviour(controllerId, input, timestamp = this.clock().toISOString()) {
        this.requireController(controllerId);
        const behaviour = normalizeSimulationBehaviour(input);
        this.statements.updateBehaviour.run(
            serializeJson(behaviour),
            timestamp,
            controllerId
        );
        return this.getController(controllerId);
    }

    beginJournal(controllerId, command, timestamp = this.clock().toISOString()) {
        const existing = this.getJournalForCommand(command.commandId);
        if (existing) {
            return { journal: existing, created: false };
        }
        return this.eventStore.transaction(() => {
            const concurrent = mapJournal(
                this.statements.selectJournalByCommand.get(command.commandId)
            );
            if (concurrent) {
                return { journal: concurrent, created: false };
            }
            const journalId = `controller_journal_${this.idGenerator()}`;
            const assignment = this.getAssignmentForFeeder(command.feederId);
            this.statements.insertJournal.run(
                journalId,
                controllerId,
                command.commandId,
                command.barnId,
                command.feederId,
                command.deviceId,
                command.fencingToken,
                timestamp,
                timestamp,
                command.assignmentGeneration || assignment?.assignmentGeneration || 1,
                command.commandType,
                serializeJson(command.commandPayload),
                this.requireController(controllerId).controllerBootId
            );
            this.statements.insertJournalHistory.run(
                journalId,
                null,
                "RECEIVED",
                timestamp,
                serializeJson({ duplicateDelivery: false })
            );
            return {
                journal: mapJournal(this.statements.selectJournalById.get(journalId)),
                created: true
            };
        });
    }

    transitionJournal(journalId, toState, {
        timestamp = this.clock().toISOString(),
        dispensePerformed,
        finalAcknowledgement,
        failureReason,
        details = null
    } = {}) {
        return this.eventStore.transaction(() => {
            const current = mapJournal(this.statements.selectJournalById.get(journalId));
            if (!current) {
                throw new Error(`Controller journal ${journalId} was not found.`);
            }
            const next = {
                ...current,
                executionState: toState,
                dispensePerformed: dispensePerformed === undefined
                    ? current.dispensePerformed
                    : Boolean(dispensePerformed),
                acceptedAt: toState === "ACCEPTED" && !current.acceptedAt
                    ? timestamp : current.acceptedAt,
                startedAt: toState === "STARTED" && !current.startedAt
                    ? timestamp : current.startedAt,
                completedAt: [
                    "COMPLETED", "REJECTED", "FAILED", "OUTCOME_UNKNOWN"
                ].includes(toState) ? timestamp : current.completedAt,
                updatedAt: timestamp,
                finalAcknowledgement: finalAcknowledgement === undefined
                    ? current.finalAcknowledgement : finalAcknowledgement,
                failureReason: failureReason === undefined
                    ? current.failureReason : failureReason,
                evidenceAt: (dispensePerformed === true && !current.evidenceAt)
                    ? timestamp : current.evidenceAt
            };
            const result = this.statements.updateJournal.run(
                next.executionState,
                next.dispensePerformed ? 1 : 0,
                next.acceptedAt,
                next.startedAt,
                next.completedAt,
                next.updatedAt,
                serializeJson(next.finalAcknowledgement),
                next.failureReason,
                next.evidenceAt,
                journalId,
                current.executionState
            );
            if (Number(result.changes) !== 1) {
                throw new Error(`Controller journal ${journalId} changed concurrently.`);
            }
            if (current.executionState !== toState) {
                this.statements.insertJournalHistory.run(
                    journalId,
                    current.executionState,
                    toState,
                    timestamp,
                    serializeJson(details)
                );
            }
            return mapJournal(this.statements.selectJournalById.get(journalId));
        });
    }

    getJournalForCommand(commandId) {
        this.eventStore.assertOpen();
        return mapJournal(this.statements.selectJournalByCommand.get(commandId));
    }

    getIncompleteJournals() {
        this.eventStore.assertOpen();
        return this.statements.selectIncompleteJournals.all().map(mapJournal);
    }

    getRecentExecutions(controllerId, limit = 100) {
        this.requireController(controllerId);
        const normalizedLimit = Math.min(500, Math.max(1, Number(limit) || 100));
        return this.statements.selectRecentJournals.all(
            controllerId,
            normalizedLimit
        ).map(mapJournal);
    }

    getJournalHistory(journalId) {
        return this.statements.selectJournalHistory.all(journalId).map(row => ({
            ...row,
            details: parseJson(row.detailsJson)
        }));
    }

    recordAcknowledgementDelivery(commandId, succeeded, {
        timestamp = this.clock().toISOString(),
        reconciliationState = succeeded ? "DELIVERED" : "PENDING"
    } = {}) {
        const journal = this.getJournalForCommand(commandId);
        if (!journal) {
            return null;
        }
        this.statements.updateJournalDelivery.run(
            succeeded ? 1 : 0,
            reconciliationState,
            timestamp,
            journal.journalId
        );
        return this.getJournalForCommand(commandId);
    }

    startControllerBoot(controllerId, bootId, timestamp = this.clock().toISOString()) {
        this.requireController(controllerId);
        this.statements.updateControllerBoot.run(bootId, timestamp, controllerId);
        return this.getController(controllerId);
    }

    updateControllerProtocolState(controllerId, envelope, {
        connectionState = "ONLINE",
        heartbeat = false,
        timestamp = this.clock().toISOString()
    } = {}) {
        const controller = this.requireController(controllerId);
        const sequence = Number(envelope.sequence);
        const sameBoot = controller.controllerBootId === envelope.controllerBootId;
        if (
            sameBoot
            && sequence <= controller.lastControllerSequence
        ) {
            return { controller, stale: true };
        }
        if (
            envelope.bootCounter < controller.bootCounter
            || (envelope.bootCounter === controller.bootCounter && !sameBoot)
        ) {
            return { controller, stale: true };
        }
        this.statements.updateControllerProtocolState.run(
            envelope.controllerBootId,
            envelope.bootCounter,
            sequence,
            heartbeat ? timestamp : controller.lastHeartbeatReceivedAt,
            envelope.expiresAt,
            connectionState,
            timestamp,
            controllerId
        );
        return { controller: this.getController(controllerId), stale: false };
    }

    recordOutboundDelivery(input) {
        this.statements.insertOutboundDelivery.run(
            input.deliveryId,
            input.commandId,
            input.controllerId,
            input.assignmentGeneration,
            input.topic,
            input.publishedAt
        );
        return input;
    }

    completeOutboundDelivery(deliveryId, {
        succeeded,
        timestamp = this.clock().toISOString(),
        failureCode = null
    }) {
        this.statements.updateOutboundDelivery.run(
            succeeded ? "BROKER_ACKNOWLEDGED" : "FAILED",
            succeeded ? timestamp : null,
            failureCode,
            deliveryId
        );
    }

    getOutboundDeliveries(commandId) {
        return this.statements.selectOutboundDeliveries.all(commandId)
            .map(row => ({ ...row }));
    }

    recordInboundMessage({
        controllerId,
        messageType,
        messageId,
        controllerBootId = null,
        controllerSequence = null,
        receivedAt = this.clock().toISOString()
    }) {
        const result = this.statements.insertInboundMessage.run(
            controllerId,
            messageType,
            messageId,
            controllerBootId,
            controllerSequence,
            receivedAt
        );
        const duplicate = Number(result.changes) === 0;
        if (duplicate) {
            this.statements.incrementInboundDuplicate.run(
                controllerId,
                messageType,
                messageId
            );
        }
        return { duplicate };
    }

    recordProtocolEvent({
        severity = "INFO",
        eventType,
        code = null,
        controllerId = null,
        commandId = null,
        topic = null,
        occurredAt = this.clock().toISOString(),
        details = null
    }) {
        this.statements.insertProtocolEvent.run(
            severity,
            eventType,
            code,
            controllerId,
            commandId,
            topic,
            occurredAt,
            serializeJson(details)
        );
    }

    getProtocolEvents({ controllerId = null, limit = 100 } = {}) {
        const normalizedLimit = Math.min(500, Math.max(1, Number(limit) || 100));
        return this.statements.selectProtocolEvents.all(
            controllerId,
            controllerId,
            normalizedLimit
        ).map(row => ({ ...row, details: parseJson(row.detailsJson) }));
    }

    updateSafetyState({
        scopeKey,
        level,
        barnId = null,
        feederId = null,
        active,
        reason = null,
        timestamp = this.clock().toISOString()
    }) {
        const current = this.statements.selectSafetyState.get(scopeKey);
        const generation = Number(current?.generation || 0) + 1;
        this.statements.upsertSafetyState.run(
            scopeKey,
            level,
            barnId,
            feederId,
            generation,
            active ? 1 : 0,
            reason,
            timestamp
        );
        return this.getSafetyState(scopeKey);
    }

    getSafetyState(scopeKey) {
        const row = this.statements.selectSafetyState.get(scopeKey);
        return row ? { ...row, active: row.active === 1 } : null;
    }

    getSafetyStates() {
        return this.statements.selectSafetyStates.all()
            .map(row => ({ ...row, active: row.active === 1 }));
    }

    recordPhysicalAction(command, acknowledgement, performedAt) {
        return this.deviceCommandStore.recordSimulatedExecution(
            command,
            acknowledgement,
            performedAt
        );
    }

    requireController(controllerId) {
        const controller = this.getController(controllerId);
        if (!controller) {
            throw new Error(`SimulatedController ${controllerId} was not found.`);
        }
        return controller;
    }

    mapController(row) {
        if (!row) {
            return null;
        }
        const controller = {
            controllerId: row.controllerId,
            barnId: row.barnId,
            name: row.name,
            enabled: row.enabled === 1,
            softwareVersion: row.softwareVersion,
            protocolVersion: row.protocolVersion,
            lastSeenAt: row.lastSeenAt,
            connectionState: row.connectionState,
            simulationBehaviour: parseJson(row.simulationBehaviourJson),
            controllerBootId: row.controllerBootId,
            bootCounter: row.bootCounter,
            lastHeartbeatReceivedAt: row.lastHeartbeatReceivedAt,
            statusExpiresAt: row.statusExpiresAt,
            revokedAt: row.revokedAt,
            lastControllerSequence: row.lastControllerSequence,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            assignments: this.getAssignments(row.controllerId)
        };
        const lastSeen = Date.parse(
            controller.lastHeartbeatReceivedAt || controller.lastSeenAt
        );
        const heartbeatAge = this.clock().getTime() - lastSeen;
        controller.status = controller.revokedAt
            ? "REVOKED"
            : !controller.enabled
            ? "DISABLED"
            : controller.connectionState === "OFFLINE"
                ? "OFFLINE"
                : Number.isFinite(lastSeen)
                    && heartbeatAge > this.offlineTimeoutMs
                    ? "OFFLINE"
                : !Number.isFinite(lastSeen)
                    || heartbeatAge > this.heartbeatTimeoutMs
                    ? "STALE"
                    : "ONLINE";
        return controller;
    }
}
