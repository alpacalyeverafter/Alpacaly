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
        executionState: row.executionState,
        dispensePerformed: row.dispensePerformed === 1,
        receivedAt: row.receivedAt,
        acceptedAt: row.acceptedAt,
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        updatedAt: row.updatedAt,
        finalAcknowledgement: parseJson(row.finalAcknowledgementJson),
        failureReason: row.failureReason
    } : null;
}

export class SqliteDeviceControllerStore {
    constructor({
        eventStore,
        deviceCommandStore,
        heartbeatTimeoutMs = 15_000,
        clock = () => new Date(),
        idGenerator = randomUUID
    }) {
        this.eventStore = eventStore;
        this.database = eventStore.database;
        this.deviceCommandStore = deviceCommandStore;
        this.heartbeatTimeoutMs = heartbeatTimeoutMs;
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
                    controllerId, barnId, feederId, createdAt
                ) VALUES (?, ?, ?, ?)
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
                SELECT controllerId, barnId, feederId, createdAt
                FROM SimulatedControllerFeederAssignments
                WHERE controllerId = ?
                ORDER BY feederId ASC
            `),
            selectAssignment: this.database.prepare(`
                SELECT controllerId, barnId, feederId, createdAt
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
                    finalAcknowledgementJson, failureReason
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'RECEIVED', 0, ?, NULL, NULL,
                          NULL, ?, NULL, NULL)
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
                    failureReason = ?
                WHERE journalId = ? AND executionState = ?
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
        this.statements.insertAssignment.run(
            controllerId,
            barnId,
            feederId,
            createdAt
        );
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
        this.requireController(controllerId);
        this.statements.updateEnabled.run(enabled ? 1 : 0, timestamp, controllerId);
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
            this.statements.insertJournal.run(
                journalId,
                controllerId,
                command.commandId,
                command.barnId,
                command.feederId,
                command.deviceId,
                command.fencingToken,
                timestamp,
                timestamp
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
                    ? current.failureReason : failureReason
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
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            assignments: this.getAssignments(row.controllerId)
        };
        const lastSeen = Date.parse(controller.lastSeenAt);
        controller.status = !controller.enabled
            ? "DISABLED"
            : controller.connectionState === "OFFLINE"
                ? "OFFLINE"
                : !Number.isFinite(lastSeen)
                    || this.clock().getTime() - lastSeen > this.heartbeatTimeoutMs
                    ? "STALE"
                    : "ONLINE";
        return controller;
    }
}
