import { randomUUID } from "node:crypto";

import { ApplicationError } from "../errors/application-error.js";

const FEEDER_STATUSES = ["AVAILABLE", "PAUSED", "WELFARE_UNAVAILABLE", "MAINTENANCE"];
const DEVICE_STATUSES = ["AVAILABLE", "PAUSED", "MAINTENANCE"];

function requireReason(value) {
    const reason = typeof value === "string" ? value.trim() : "";
    if (!reason) {
        throw new ApplicationError("A reason is required for this action.", {
            code: "OPERATOR_ACTION_REASON_REQUIRED",
            statusCode: 400
        });
    }
    return reason.slice(0, 1000);
}

export class ResourceOperationsService {
    constructor({
        store,
        auditService,
        eventEngine,
        deviceCommandStore,
        deviceCommandWorker,
        clock = () => new Date(),
        idGenerator = randomUUID
    }) {
        this.store = store;
        this.auditService = auditService;
        this.eventEngine = eventEngine;
        this.deviceCommandStore = deviceCommandStore;
        this.deviceCommandWorker = deviceCommandWorker;
        this.clock = clock;
        this.idGenerator = idGenerator;
    }

    setFeederStatus(feederId, barnId, status, context) {
        const normalizedStatus = String(status || "").trim().toUpperCase();
        if (!FEEDER_STATUSES.includes(normalizedStatus)) {
            throw new ApplicationError("Feeder status is not supported.", {
                code: "FEEDER_STATUS_NOT_SUPPORTED",
                statusCode: 400
            });
        }
        const before = this.requireFeeder(feederId, barnId);
        if (
            normalizedStatus === "AVAILABLE"
            && before.operationalStatus === "MAINTENANCE"
            && context.authorization.effectiveRole === "WELFARE_OPERATOR"
        ) {
            throw new ApplicationError(
                "A Welfare Operator cannot clear hardware maintenance status.",
                {
                    code: "FEEDER_MAINTENANCE_CLEAR_FORBIDDEN",
                    statusCode: 403
                }
            );
        }
        const reason = requireReason(context.reason);
        const updatedAt = this.clock().toISOString();
        const action = {
            AVAILABLE: "FEEDER_RESUMED",
            PAUSED: "FEEDER_PAUSED",
            WELFARE_UNAVAILABLE: "FEEDER_MARKED_UNAVAILABLE",
            MAINTENANCE: "FEEDER_PLACED_IN_MAINTENANCE"
        }[normalizedStatus];
        const after = {
            ...before,
            operationalStatus: normalizedStatus,
            operationalReason: reason,
            operationalUpdatedAt: updatedAt
        };
        const audit = this.auditService.create({
            ...this.auditContext(context),
            barnId,
            feederId,
            action,
            targetType: "FEEDER",
            targetId: feederId,
            reason,
            result: "SUCCEEDED",
            beforeSummary: before,
            afterSummary: after
        });
        const persisted = this.store.updateFeederStatus(
            feederId,
            barnId,
            normalizedStatus,
            reason,
            updatedAt,
            audit
        );
        if (normalizedStatus === "AVAILABLE") {
            this.eventEngine.scheduleProcessing(feederId);
        }
        return persisted;
    }

    setDeviceStatus(deviceId, barnId, status, context) {
        const normalizedStatus = String(status || "").trim().toUpperCase();
        if (!DEVICE_STATUSES.includes(normalizedStatus)) {
            throw new ApplicationError("Device status is not supported.", {
                code: "DEVICE_STATUS_NOT_SUPPORTED",
                statusCode: 400
            });
        }
        const before = this.requireDevice(deviceId, barnId);
        const reason = requireReason(context.reason);
        const updatedAt = this.clock().toISOString();
        const action = normalizedStatus === "MAINTENANCE"
            ? "DEVICE_PLACED_IN_MAINTENANCE"
            : normalizedStatus === "PAUSED"
                ? "DEVICE_PAUSED"
                : "DEVICE_RESUMED";
        const after = {
            ...before,
            operationalStatus: normalizedStatus,
            operationalReason: reason,
            operationalUpdatedAt: updatedAt
        };
        const audit = this.auditService.create({
            ...this.auditContext(context),
            barnId,
            deviceId,
            action,
            targetType: "DEVICE",
            targetId: deviceId,
            reason,
            result: "SUCCEEDED",
            beforeSummary: before,
            afterSummary: after
        });
        const persisted = this.store.updateDeviceStatus(
            deviceId,
            barnId,
            normalizedStatus,
            reason,
            updatedAt,
            audit
        );
        if (normalizedStatus === "AVAILABLE") {
            void this.deviceCommandWorker.processReadyCommands();
        }
        return persisted;
    }

    recordWelfareNote({ barnId, feederId = null, note }, context) {
        if (!this.store.getBarn(barnId)) {
            throw new ApplicationError("Barn was not found.", {
                code: "BARN_NOT_FOUND",
                statusCode: 404
            });
        }
        if (feederId) {
            this.requireFeeder(feederId, barnId);
        }
        const normalizedNote = typeof note === "string" ? note.trim() : "";
        if (!normalizedNote) {
            throw new ApplicationError("Welfare note is required.", {
                code: "WELFARE_NOTE_REQUIRED",
                statusCode: 400
            });
        }
        const welfareNote = {
            welfareNoteId: `welfare_note_${this.idGenerator()}`,
            administratorId: context.identity.administratorId,
            barnId,
            feederId,
            note: normalizedNote.slice(0, 2000),
            createdAt: this.clock().toISOString()
        };
        const audit = this.auditService.create({
            ...this.auditContext(context),
            barnId,
            feederId,
            action: "WELFARE_NOTE_RECORDED",
            targetType: "WELFARE_NOTE",
            targetId: welfareNote.welfareNoteId,
            reason: context.reason || "WELFARE_OBSERVATION",
            result: "SUCCEEDED",
            afterSummary: { ...welfareNote, note: "[RECORDED]" }
        });
        return this.store.createWelfareNote(welfareNote, audit);
    }

    requestUncertainOutcomeReview(commandId, context) {
        const command = this.requireCommand(commandId, context.barnId);
        if (command.status !== "OUTCOME_UNKNOWN") {
            throw new ApplicationError(
                "Review can only be requested for an unknown command outcome.",
                {
                    code: "COMMAND_OUTCOME_NOT_UNKNOWN",
                    statusCode: 409
                }
            );
        }
        return this.auditService.record({
            ...this.auditContext(context),
            barnId: command.barnId,
            feederId: command.feederId,
            deviceId: command.deviceId,
            action: "UNCERTAIN_OUTCOME_REVIEW_REQUESTED",
            targetType: "DEVICE_COMMAND",
            targetId: commandId,
            reason: requireReason(context.reason),
            result: "SUCCEEDED",
            beforeSummary: { commandId, status: command.status },
            afterSummary: { reviewRequested: true }
        });
    }

    requestCommandRetry(commandId, context) {
        const command = this.requireCommand(commandId, context.barnId);
        const acknowledgements = this.deviceCommandStore
            .getAcknowledgementsForCommand(commandId);
        const unsafeAcknowledgement = acknowledgements.some(item => (
            ["STARTED", "SUCCEEDED"].includes(item.result)
        ));
        if (
            command.status !== "FAILED"
            || command.attemptCount >= command.maximumAttempts
            || unsafeAcknowledgement
        ) {
            throw new ApplicationError(
                "The durable retry policy does not permit this command to be retried.",
                {
                    code: "DEVICE_COMMAND_RETRY_NOT_PERMITTED",
                    statusCode: 409,
                    details: { commandId, status: command.status }
                }
            );
        }

        const reason = requireReason(context.reason);
        const timestamp = this.clock().toISOString();
        const audit = this.auditService.create({
            ...this.auditContext(context),
            barnId: command.barnId,
            feederId: command.feederId,
            deviceId: command.deviceId,
            action: "DEVICE_COMMAND_RETRY_REQUESTED",
            targetType: "DEVICE_COMMAND",
            targetId: commandId,
            reason,
            result: "SUCCEEDED",
            beforeSummary: {
                commandId,
                status: command.status,
                attemptCount: command.attemptCount
            },
            afterSummary: { status: "RETRY_SCHEDULED" }
        });
        const retried = this.store.eventStore.transaction(() => {
            const result = this.deviceCommandStore.applyTransition(
                commandId,
                "RETRY_SCHEDULED",
                {
                    timestamp,
                    nextAttemptAt: timestamp,
                    details: { requestedByAdministrator: true, reason }
                }
            );
            this.store.insertAuditRecord(audit);
            return result;
        });
        void this.deviceCommandWorker.processCommand(commandId);
        return retried;
    }

    acknowledgeHardwareAlert(alertId, context) {
        const reason = requireReason(context.reason);
        return this.auditService.record({
            ...this.auditContext(context),
            barnId: context.barnId,
            deviceId: context.deviceId || null,
            action: context.emergencyRelated
                ? "EMERGENCY_RELATED_ACKNOWLEDGED"
                : "HARDWARE_ALERT_ACKNOWLEDGED",
            targetType: "HARDWARE_ALERT",
            targetId: alertId,
            reason,
            result: "SUCCEEDED",
            metadata: { emergencyRelated: context.emergencyRelated === true }
        });
    }

    requireFeeder(feederId, barnId) {
        const feeder = this.store.getFeederForBarn(feederId, barnId);
        if (!feeder) {
            throw new ApplicationError("Feeder was not found in this Barn.", {
                code: "FEEDER_NOT_FOUND",
                statusCode: 404
            });
        }
        return feeder;
    }

    requireDevice(deviceId, barnId) {
        const device = this.store.getDeviceForBarn(deviceId, barnId);
        if (!device) {
            throw new ApplicationError("Device was not found in this Barn.", {
                code: "DEVICE_NOT_FOUND",
                statusCode: 404
            });
        }
        return device;
    }

    requireCommand(commandId, barnId) {
        const command = this.deviceCommandStore.getCommand(commandId);
        if (!command || command.barnId !== barnId) {
            throw new ApplicationError("Device command was not found in this Barn.", {
                code: "DEVICE_COMMAND_NOT_FOUND",
                statusCode: 404
            });
        }
        return command;
    }

    auditContext(context) {
        return {
            administratorId: context.identity.administratorId,
            effectiveRole: context.authorization.effectiveRole,
            requestId: context.requestId,
            authenticationStrength: context.identity.authenticationStrength
        };
    }
}
