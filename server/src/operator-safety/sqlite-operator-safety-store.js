import { randomUUID } from "node:crypto";

function parseJson(value) {
    return value === null || value === undefined || value === ""
        ? null
        : JSON.parse(value);
}

function serializeJson(value) {
    return JSON.stringify(value ?? null);
}

function mapEmergencyStop(row) {
    return row ? {
        emergencyStopSequence: row.emergencyStopSequence,
        emergencyStopId: row.emergencyStopId,
        level: row.level,
        barnId: row.barnId,
        feederId: row.feederId,
        status: row.status,
        activatedBy: row.activatedBy,
        activatedRole: row.activatedRole,
        reason: row.reason,
        requestId: row.requestId,
        activatedAt: row.activatedAt,
        clearedAt: row.clearedAt,
        clearanceApprovalRequestId: row.clearanceApprovalRequestId
    } : null;
}

function mapApprovalRequest(row) {
    return row ? {
        approvalRequestSequence: row.approvalRequestSequence,
        approvalRequestId: row.approvalRequestId,
        actionType: row.actionType,
        requestedBy: row.requestedBy,
        targetType: row.targetType,
        targetId: row.targetId,
        barnId: row.barnId,
        feederId: row.feederId,
        reason: row.reason,
        requiredAuthorities: parseJson(row.requiredAuthoritiesJson),
        actionPayload: parseJson(row.actionPayloadJson),
        status: row.status,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        completedAt: row.completedAt
    } : null;
}

function mapApprovalDecision(row) {
    return row ? {
        approvalDecisionSequence: row.approvalDecisionSequence,
        approvalDecisionId: row.approvalDecisionId,
        approvalRequestId: row.approvalRequestId,
        administratorId: row.administratorId,
        effectiveRole: row.effectiveRole,
        authorityRepresented: row.authorityRepresented,
        decision: row.decision,
        reason: row.reason,
        authenticationStrength: row.authenticationStrength,
        decidedAt: row.decidedAt
    } : null;
}

function mapResolutionCase(row) {
    return row ? {
        resolutionCaseSequence: row.resolutionCaseSequence,
        resolutionCaseId: row.resolutionCaseId,
        eventId: row.eventId,
        commandId: row.commandId,
        barnId: row.barnId,
        feederId: row.feederId,
        deviceId: row.deviceId,
        caseType: row.caseType,
        status: row.status,
        requestedResolution: row.requestedResolution,
        reason: row.reason,
        supportingNotes: row.supportingNotes,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        approvalDeadline: row.approvalDeadline,
        approvalRequestId: row.approvalRequestId,
        resolvedAt: row.resolvedAt,
        finalResolution: row.finalResolution,
        welfareImpact: parseJson(row.welfareImpactJson),
        replacementCommandId: row.replacementCommandId
    } : null;
}

export class SqliteOperatorSafetyStore {
    constructor({ eventStore, idGenerator = randomUUID }) {
        this.eventStore = eventStore;
        this.database = eventStore.database;
        this.idGenerator = idGenerator;
        this.prepareStatements();
    }

    prepareStatements() {
        this.statements = {
            insertEmergencyStop: this.database.prepare(`
                INSERT INTO EmergencyStops (
                    emergencyStopId, level, barnId, feederId, status,
                    activatedBy, activatedRole, reason, requestId, activatedAt,
                    clearedAt, clearanceApprovalRequestId
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            selectEmergencyStop: this.database.prepare(`
                SELECT * FROM EmergencyStops WHERE emergencyStopId = ?
            `),
            selectEmergencyStops: this.database.prepare(`
                SELECT * FROM EmergencyStops
                WHERE (? IS NULL OR status = ?)
                  AND (? IS NULL OR barnId = ? OR level = 'PLATFORM')
                  AND (? IS NULL OR feederId = ? OR feederId IS NULL)
                ORDER BY emergencyStopSequence DESC
            `),
            clearEmergencyStop: this.database.prepare(`
                UPDATE EmergencyStops
                SET status = 'CLEARED', clearedAt = ?,
                    clearanceApprovalRequestId = ?
                WHERE emergencyStopId = ? AND status = 'ACTIVE'
            `),
            selectEffectiveStops: this.database.prepare(`
                SELECT * FROM EmergencyStops
                WHERE status = 'ACTIVE'
                  AND (
                    level = 'PLATFORM'
                    OR (level = 'BARN' AND barnId = ?)
                    OR (level = 'FEEDER' AND barnId = ? AND feederId = ?)
                  )
                ORDER BY emergencyStopSequence ASC
            `),
            insertApprovalRequest: this.database.prepare(`
                INSERT INTO ApprovalRequests (
                    approvalRequestId, actionType, requestedBy, targetType,
                    targetId, barnId, feederId, reason,
                    requiredAuthoritiesJson, actionPayloadJson, status,
                    createdAt, expiresAt, completedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            selectApprovalRequest: this.database.prepare(`
                SELECT * FROM ApprovalRequests WHERE approvalRequestId = ?
            `),
            selectApprovalRequests: this.database.prepare(`
                SELECT * FROM ApprovalRequests
                WHERE (? IS NULL OR status = ?)
                  AND (? IS NULL OR barnId = ? OR barnId IS NULL)
                ORDER BY approvalRequestSequence DESC
            `),
            insertApprovalDecision: this.database.prepare(`
                INSERT INTO ApprovalDecisions (
                    approvalDecisionId, approvalRequestId, administratorId,
                    effectiveRole, authorityRepresented, decision, reason,
                    authenticationStrength, decidedAt
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            selectApprovalDecisions: this.database.prepare(`
                SELECT * FROM ApprovalDecisions
                WHERE approvalRequestId = ?
                ORDER BY approvalDecisionSequence ASC
            `),
            updateApprovalRequest: this.database.prepare(`
                UPDATE ApprovalRequests
                SET status = ?, completedAt = ?
                WHERE approvalRequestId = ? AND status = ?
            `),
            expireApprovalRequests: this.database.prepare(`
                SELECT * FROM ApprovalRequests
                WHERE status IN ('PENDING', 'PARTIALLY_APPROVED', 'APPROVED')
                  AND expiresAt <= ?
                ORDER BY approvalRequestSequence ASC
            `),
            insertApprovalHistory: this.database.prepare(`
                INSERT INTO ApprovalRequestHistory (
                    approvalRequestId, fromStatus, toStatus, timestamp, detailsJson
                ) VALUES (?, ?, ?, ?, ?)
            `),
            selectApprovalHistory: this.database.prepare(`
                SELECT * FROM ApprovalRequestHistory
                WHERE approvalRequestId = ?
                ORDER BY approvalHistorySequence ASC
            `),
            insertResolutionCase: this.database.prepare(`
                INSERT INTO OperatorResolutionCases (
                    resolutionCaseId, eventId, commandId, barnId, feederId,
                    deviceId, caseType, status, requestedResolution, reason,
                    supportingNotes, createdBy, createdAt, approvalDeadline,
                    approvalRequestId, resolvedAt, finalResolution,
                    welfareImpactJson, replacementCommandId
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            selectResolutionCase: this.database.prepare(`
                SELECT * FROM OperatorResolutionCases WHERE resolutionCaseId = ?
            `),
            selectResolutionCaseByCommand: this.database.prepare(`
                SELECT * FROM OperatorResolutionCases WHERE commandId = ?
            `),
            selectResolutionCases: this.database.prepare(`
                SELECT * FROM OperatorResolutionCases
                WHERE (? IS NULL OR status = ?)
                  AND (? IS NULL OR barnId = ?)
                  AND (? IS NULL OR feederId = ?)
                ORDER BY resolutionCaseSequence DESC
            `),
            updateResolutionApproval: this.database.prepare(`
                UPDATE OperatorResolutionCases
                SET requestedResolution = ?, supportingNotes = ?,
                    approvalDeadline = ?, approvalRequestId = ?
                WHERE resolutionCaseId = ? AND status = 'OPEN'
            `),
            resolveResolutionCase: this.database.prepare(`
                UPDATE OperatorResolutionCases
                SET status = 'RESOLVED', resolvedAt = ?, finalResolution = ?,
                    replacementCommandId = COALESCE(?, replacementCommandId)
                WHERE resolutionCaseId = ? AND status = 'OPEN'
            `),
            setReplacementCommand: this.database.prepare(`
                UPDATE OperatorResolutionCases SET replacementCommandId = ?
                WHERE resolutionCaseId = ? AND status = 'RESOLVED'
                  AND replacementCommandId IS NULL
            `),
            updateFeederSafety: this.database.prepare(`
                UPDATE Feeders
                SET safetyStatus = ?, safetyReason = ?, safetyUpdatedAt = ?
                WHERE feederId = ? AND barnId = ?
            `),
            selectFeederSafety: this.database.prepare(`
                SELECT feederId, barnId, operationalStatus, safetyStatus,
                       safetyReason, safetyUpdatedAt
                FROM Feeders WHERE feederId = ?
            `),
            selectFeeders: this.database.prepare(`
                SELECT feederId, barnId, operationalStatus, safetyStatus,
                       safetyReason, safetyUpdatedAt
                FROM Feeders ORDER BY feederId
            `),
            selectCommandsForScope: this.database.prepare(`
                SELECT * FROM DeviceCommands
                WHERE (? = 'PLATFORM')
                   OR (? = 'BARN' AND barnId = ?)
                   OR (? = 'FEEDER' AND barnId = ? AND feederId = ?)
                ORDER BY commandSequence ASC
            `),
            selectUnknownDispenseCommands: this.database.prepare(`
                SELECT * FROM DeviceCommands
                WHERE status = 'OUTCOME_UNKNOWN'
                  AND commandType = 'DISPENSE_FEED'
                ORDER BY commandSequence ASC
            `),
            selectEvent: this.database.prepare(`
                SELECT * FROM Events WHERE eventId = ?
            `),
            markEventSafetyState: this.database.prepare(`
                UPDATE Events SET safetyState = ?, safetyUpdatedAt = ?, updatedAt = ?
                WHERE eventId = ?
            `),
            insertWelfareEntry: this.database.prepare(`
                INSERT INTO WelfareSafetyLedger (
                    welfareEntryId, eventId, commandId, resolutionCaseId,
                    feederId, entryType, quantity, unit, countsAsDispensed,
                    recordedAt, detailsJson
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            selectWelfareEntries: this.database.prepare(`
                SELECT * FROM WelfareSafetyLedger
                WHERE (? IS NULL OR feederId = ?)
                ORDER BY welfareEntrySequence ASC
            `),
            selectCountedQuantity: this.database.prepare(`
                SELECT COALESCE(SUM(quantity), 0) AS total
                FROM WelfareSafetyLedger
                WHERE feederId = ? AND countsAsDispensed = 1
                  AND recordedAt >= ? AND recordedAt < ?
            `)
        };
    }

    createEmergencyStop(stop) {
        this.eventStore.assertOpen();
        this.statements.insertEmergencyStop.run(
            stop.emergencyStopId, stop.level, stop.barnId, stop.feederId,
            stop.status, stop.activatedBy, stop.activatedRole, stop.reason,
            stop.requestId, stop.activatedAt, stop.clearedAt,
            stop.clearanceApprovalRequestId
        );
        return this.getEmergencyStop(stop.emergencyStopId);
    }

    getEmergencyStop(emergencyStopId) {
        this.eventStore.assertOpen();
        return mapEmergencyStop(this.statements.selectEmergencyStop.get(emergencyStopId));
    }

    getEmergencyStops({ status = null, barnId = null, feederId = null } = {}) {
        this.eventStore.assertOpen();
        return this.statements.selectEmergencyStops.all(
            status, status, barnId, barnId, feederId, feederId
        ).map(mapEmergencyStop);
    }

    getEffectiveStops(barnId, feederId) {
        this.eventStore.assertOpen();
        return this.statements.selectEffectiveStops.all(barnId, barnId, feederId)
            .map(mapEmergencyStop);
    }

    clearEmergencyStop(emergencyStopId, approvalRequestId, clearedAt) {
        const result = this.statements.clearEmergencyStop.run(
            clearedAt, approvalRequestId, emergencyStopId
        );
        return Number(result.changes) === 1
            ? this.getEmergencyStop(emergencyStopId)
            : null;
    }

    createApprovalRequest(request) {
        return this.eventStore.transaction(() => {
            this.statements.insertApprovalRequest.run(
                request.approvalRequestId, request.actionType,
                request.requestedBy, request.targetType, request.targetId,
                request.barnId, request.feederId, request.reason,
                serializeJson(request.requiredAuthorities),
                serializeJson(request.actionPayload), request.status,
                request.createdAt, request.expiresAt, request.completedAt
            );
            this.insertApprovalHistory(
                request.approvalRequestId, null, request.status,
                request.createdAt, { requestedBy: request.requestedBy }
            );
            return this.getApprovalRequest(request.approvalRequestId);
        });
    }

    getApprovalRequest(approvalRequestId) {
        this.eventStore.assertOpen();
        return mapApprovalRequest(
            this.statements.selectApprovalRequest.get(approvalRequestId)
        );
    }

    getApprovalRequests({ status = null, barnId = null } = {}) {
        this.eventStore.assertOpen();
        return this.statements.selectApprovalRequests.all(
            status, status, barnId, barnId
        ).map(mapApprovalRequest);
    }

    getApprovalDecisions(approvalRequestId) {
        this.eventStore.assertOpen();
        return this.statements.selectApprovalDecisions.all(approvalRequestId)
            .map(mapApprovalDecision);
    }

    getApprovalHistory(approvalRequestId) {
        this.eventStore.assertOpen();
        return this.statements.selectApprovalHistory.all(approvalRequestId)
            .map(row => ({
                approvalHistorySequence: row.approvalHistorySequence,
                approvalRequestId: row.approvalRequestId,
                fromStatus: row.fromStatus,
                toStatus: row.toStatus,
                timestamp: row.timestamp,
                details: parseJson(row.detailsJson)
            }));
    }

    addApprovalDecision(decision, fromStatus, toStatus, completedAt = null) {
        return this.eventStore.transaction(() => {
            this.statements.insertApprovalDecision.run(
                decision.approvalDecisionId, decision.approvalRequestId,
                decision.administratorId, decision.effectiveRole,
                decision.authorityRepresented, decision.decision,
                decision.reason, decision.authenticationStrength,
                decision.decidedAt
            );
            const result = this.statements.updateApprovalRequest.run(
                toStatus, completedAt, decision.approvalRequestId, fromStatus
            );
            if (Number(result.changes) !== 1) {
                throw new Error("Approval Request changed concurrently.");
            }
            this.insertApprovalHistory(
                decision.approvalRequestId, fromStatus, toStatus,
                decision.decidedAt, {
                    decision: decision.decision,
                    administratorId: decision.administratorId,
                    authorityRepresented: decision.authorityRepresented
                }
            );
            return this.getApprovalRequest(decision.approvalRequestId);
        });
    }

    changeApprovalStatus(approvalRequestId, fromStatus, toStatus, timestamp, details) {
        return this.eventStore.transaction(() => {
            const completedAt = [
                "REJECTED", "EXPIRED", "CANCELLED", "EXECUTED", "EXECUTION_FAILED"
            ].includes(toStatus) ? timestamp : null;
            const result = this.statements.updateApprovalRequest.run(
                toStatus, completedAt, approvalRequestId, fromStatus
            );
            if (Number(result.changes) !== 1) {
                return null;
            }
            this.insertApprovalHistory(
                approvalRequestId, fromStatus, toStatus, timestamp, details
            );
            return this.getApprovalRequest(approvalRequestId);
        });
    }

    getExpiredApprovalRequests(timestamp) {
        return this.statements.expireApprovalRequests.all(timestamp)
            .map(mapApprovalRequest);
    }

    insertApprovalHistory(requestId, fromStatus, toStatus, timestamp, details) {
        this.statements.insertApprovalHistory.run(
            requestId, fromStatus, toStatus, timestamp, serializeJson(details)
        );
    }

    createResolutionCase(resolutionCase) {
        this.statements.insertResolutionCase.run(
            resolutionCase.resolutionCaseId, resolutionCase.eventId,
            resolutionCase.commandId, resolutionCase.barnId,
            resolutionCase.feederId, resolutionCase.deviceId,
            resolutionCase.caseType, resolutionCase.status,
            resolutionCase.requestedResolution, resolutionCase.reason,
            resolutionCase.supportingNotes, resolutionCase.createdBy,
            resolutionCase.createdAt, resolutionCase.approvalDeadline,
            resolutionCase.approvalRequestId, resolutionCase.resolvedAt,
            resolutionCase.finalResolution,
            serializeJson(resolutionCase.welfareImpact),
            resolutionCase.replacementCommandId
        );
        return this.getResolutionCase(resolutionCase.resolutionCaseId);
    }

    getResolutionCase(resolutionCaseId) {
        return mapResolutionCase(this.statements.selectResolutionCase.get(
            resolutionCaseId
        ));
    }

    getResolutionCaseByCommand(commandId) {
        return mapResolutionCase(this.statements.selectResolutionCaseByCommand.get(
            commandId
        ));
    }

    getResolutionCases({ status = null, barnId = null, feederId = null } = {}) {
        return this.statements.selectResolutionCases.all(
            status, status, barnId, barnId, feederId, feederId
        ).map(mapResolutionCase);
    }

    attachResolutionApproval(caseId, resolution, notes, deadline, requestId) {
        const result = this.statements.updateResolutionApproval.run(
            resolution, notes, deadline, requestId, caseId
        );
        return Number(result.changes) === 1 ? this.getResolutionCase(caseId) : null;
    }

    resolveCase(caseId, resolution, resolvedAt, replacementCommandId = null) {
        const result = this.statements.resolveResolutionCase.run(
            resolvedAt, resolution, replacementCommandId, caseId
        );
        return Number(result.changes) === 1 ? this.getResolutionCase(caseId) : null;
    }

    setReplacementCommand(caseId, commandId) {
        const result = this.statements.setReplacementCommand.run(commandId, caseId);
        return Number(result.changes) === 1 ? this.getResolutionCase(caseId) : null;
    }

    setFeederSafety(feederId, barnId, status, reason, updatedAt) {
        const result = this.statements.updateFeederSafety.run(
            status, reason, updatedAt, feederId, barnId
        );
        return Number(result.changes) === 1 ? this.getFeederSafety(feederId) : null;
    }

    getFeederSafety(feederId) {
        const row = this.statements.selectFeederSafety.get(feederId);
        return row ? { ...row } : null;
    }

    getFeederSafetyStates() {
        return this.statements.selectFeeders.all().map(row => ({ ...row }));
    }

    getCommandsForStop(stop) {
        return this.statements.selectCommandsForScope.all(
            stop.level, stop.level, stop.barnId,
            stop.level, stop.barnId, stop.feederId
        ).map(row => ({ ...row, commandPayload: parseJson(row.commandPayloadJson) }));
    }

    getUnknownDispenseCommands() {
        return this.statements.selectUnknownDispenseCommands.all()
            .map(row => ({ ...row, commandPayload: parseJson(row.commandPayloadJson) }));
    }

    getEvent(eventId) {
        const row = this.statements.selectEvent.get(eventId);
        return row ? { ...row } : null;
    }

    setEventSafetyState(eventId, safetyState, timestamp) {
        this.statements.markEventSafetyState.run(
            safetyState, timestamp, timestamp, eventId
        );
        return this.getEvent(eventId);
    }

    appendWelfareEntry({
        welfareEntryId = `welfare_entry_${this.idGenerator()}`,
        eventId,
        commandId,
        resolutionCaseId = null,
        feederId,
        entryType,
        quantity,
        unit = "FEED_PORTION",
        countsAsDispensed = true,
        recordedAt,
        details = null
    }) {
        this.statements.insertWelfareEntry.run(
            welfareEntryId, eventId, commandId, resolutionCaseId,
            feederId, entryType, quantity, unit,
            countsAsDispensed ? 1 : 0, recordedAt, serializeJson(details)
        );
        return { welfareEntryId };
    }

    getWelfareEntries(feederId = null) {
        return this.statements.selectWelfareEntries.all(feederId, feederId)
            .map(row => ({
                ...row,
                countsAsDispensed: row.countsAsDispensed === 1,
                details: parseJson(row.detailsJson)
            }));
    }

    getCountedWelfareQuantity(feederId, start, end) {
        return Number(this.statements.selectCountedQuantity.get(
            feederId, start, end
        ).total) || 0;
    }
}
