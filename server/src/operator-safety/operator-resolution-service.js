import { createOperatorResolutionCase } from "../domain/operator-safety.js";
import { ApplicationError } from "../errors/application-error.js";

const DUAL_APPROVAL_RESOLUTIONS = Object.freeze([
    "CONFIRMED_DISPENSED",
    "CONFIRMED_NOT_DISPENSED",
    "CANCELLED_FOR_WELFARE"
]);

function requireReason(value) {
    const reason = typeof value === "string" ? value.trim() : "";
    if (!reason) {
        throw new ApplicationError("A reason is required for this resolution.", {
            code: "RESOLUTION_REASON_REQUIRED",
            statusCode: 400
        });
    }
    return reason.slice(0, 1000);
}

export class OperatorResolutionService {
    constructor({
        store,
        auditService,
        criticalAuthenticationService,
        approvalService,
        welfareValidationService,
        deviceCommandStore,
        deviceCommandService,
        eventEngine,
        clock = () => new Date(),
        idGenerator
    }) {
        this.store = store;
        this.auditService = auditService;
        this.criticalAuthenticationService = criticalAuthenticationService;
        this.approvalService = approvalService;
        this.welfareValidationService = welfareValidationService;
        this.deviceCommandStore = deviceCommandStore;
        this.deviceCommandService = deviceCommandService;
        this.eventEngine = eventEngine;
        this.clock = clock;
        this.idGenerator = idGenerator;

        approvalService.registerExecutor(
            "RESOLVE_OUTCOME_UNKNOWN",
            (request, context) => this.executeResolution(request, context)
        );
        approvalService.registerExecutor(
            "CREATE_REPLACEMENT_COMMAND",
            (request, context) => this.executeReplacement(request, context)
        );
    }

    handleOutcomeUnknown(command, {
        reason = "DEVICE_COMMAND_OUTCOME_UNKNOWN",
        context = null
    } = {}) {
        if (command.commandType !== "DISPENSE_FEED") {
            return null;
        }
        const existing = this.store.getResolutionCaseByCommand(command.commandId);
        if (existing) {
            if (existing.status === "OPEN") {
                this.blockFeeder(existing);
            }
            return existing;
        }
        const quantity = Number(command.commandPayload?.quantity || 1);
        const resolutionCase = createOperatorResolutionCase({
            eventId: command.eventId,
            commandId: command.commandId,
            barnId: command.barnId,
            feederId: command.feederId,
            deviceId: command.deviceId,
            reason,
            createdBy: context?.identity?.administratorId || null,
            welfareImpact: {
                quantity,
                unit: command.commandPayload?.unit || "FEED_PORTION",
                countsAsDispensed: true
            }
        }, this.options());
        const persisted = this.store.createResolutionCase(resolutionCase);
        this.store.appendWelfareEntry({
            eventId: command.eventId,
            commandId: command.commandId,
            resolutionCaseId: persisted.resolutionCaseId,
            feederId: command.feederId,
            entryType: "UNCERTAIN_DISPENSE_COUNTED",
            quantity,
            unit: persisted.welfareImpact.unit,
            countsAsDispensed: true,
            recordedAt: persisted.createdAt,
            details: { reason }
        });
        this.blockFeeder(persisted);
        this.audit(context, {
            action: "OUTCOME_UNKNOWN_RESOLUTION_CASE_CREATED",
            targetType: "OPERATOR_RESOLUTION_CASE",
            targetId: persisted.resolutionCaseId,
            barnId: persisted.barnId,
            feederId: persisted.feederId,
            deviceId: persisted.deviceId,
            reason,
            result: "SUCCEEDED",
            afterSummary: this.safeCase(persisted)
        });
        this.eventEngine.emitEngineUpdate(
            "FEEDER_BLOCKED_OUTCOME_UNKNOWN",
            persisted.feederId
        );
        return persisted;
    }

    reconcileOnStartup() {
        return this.store.getUnknownDispenseCommands().map(command => (
            this.handleOutcomeUnknown(command, {
                reason: "OUTCOME_UNKNOWN_RESTORED_AFTER_RESTART"
            })
        ));
    }

    requestResolution(resolutionCaseId, input, context) {
        this.criticalAuthenticationService.assert(context?.identity);
        const resolutionCase = this.requireOpenCase(resolutionCaseId);
        const resolution = String(input?.resolution || "").trim().toUpperCase();
        if (![...DUAL_APPROVAL_RESOLUTIONS, "MANUAL_REVIEW_REQUIRED"].includes(
            resolution
        )) {
            throw new ApplicationError("Resolution type is not supported.", {
                code: "OPERATOR_RESOLUTION_NOT_SUPPORTED",
                statusCode: 400
            });
        }
        const reason = requireReason(input?.reason || context?.reason);
        const notes = typeof input?.supportingNotes === "string"
            ? input.supportingNotes.trim().slice(0, 4000) || null
            : null;
        if (resolution === "MANUAL_REVIEW_REQUIRED") {
            const updated = this.store.attachResolutionApproval(
                resolutionCaseId,
                resolution,
                notes,
                null,
                null
            );
            this.blockFeeder(updated);
            this.audit(context, {
                action: "MANUAL_REVIEW_REQUIRED_RECORDED",
                targetType: "OPERATOR_RESOLUTION_CASE",
                targetId: resolutionCaseId,
                barnId: updated.barnId,
                feederId: updated.feederId,
                deviceId: updated.deviceId,
                reason,
                result: "SUCCEEDED"
            });
            return { resolutionCase: updated, approvalRequest: null };
        }

        const approvalRequest = this.approvalService.createRequest({
            actionType: "RESOLVE_OUTCOME_UNKNOWN",
            targetType: "OPERATOR_RESOLUTION_CASE",
            targetId: resolutionCaseId,
            barnId: resolutionCase.barnId,
            feederId: resolutionCase.feederId,
            reason,
            requiredAuthorities: ["WELFARE", "HARDWARE"],
            actionPayload: { resolutionCaseId, resolution }
        }, context);
        const updated = this.store.attachResolutionApproval(
            resolutionCaseId,
            resolution,
            notes,
            approvalRequest.expiresAt,
            approvalRequest.approvalRequestId
        );
        return { resolutionCase: updated, approvalRequest };
    }

    requestReplacement(resolutionCaseId, input, context) {
        this.criticalAuthenticationService.assert(context?.identity);
        const resolutionCase = this.requireCase(resolutionCaseId);
        if (
            resolutionCase.status !== "RESOLVED"
            || resolutionCase.finalResolution !== "CONFIRMED_NOT_DISPENSED"
        ) {
            throw new ApplicationError(
                "A replacement is allowed only after confirming no feed was dispensed.",
                {
                    code: "REPLACEMENT_COMMAND_NOT_ELIGIBLE",
                    statusCode: 409
                }
            );
        }
        if (resolutionCase.replacementCommandId) {
            throw new ApplicationError("A replacement command already exists.", {
                code: "REPLACEMENT_COMMAND_ALREADY_EXISTS",
                statusCode: 409
            });
        }
        return this.approvalService.createRequest({
            actionType: "CREATE_REPLACEMENT_COMMAND",
            targetType: "OPERATOR_RESOLUTION_CASE",
            targetId: resolutionCaseId,
            barnId: resolutionCase.barnId,
            feederId: resolutionCase.feederId,
            reason: input?.reason || context?.reason,
            requiredAuthorities: ["WELFARE", "HARDWARE"],
            actionPayload: { resolutionCaseId }
        }, context);
    }

    executeResolution(request, context) {
        const currentCase = this.requireCase(request.actionPayload.resolutionCaseId);
        if (
            currentCase.status === "RESOLVED"
            && currentCase.approvalRequestId === request.approvalRequestId
            && currentCase.finalResolution === request.actionPayload.resolution
        ) {
            return currentCase;
        }
        const resolutionCase = this.requireOpenCase(
            request.actionPayload.resolutionCaseId,
            request.approvalRequestId
        );
        const resolution = request.actionPayload.resolution;
        if (resolutionCase.approvalRequestId !== request.approvalRequestId) {
            throw new ApplicationError("Resolution approval does not match the case.", {
                code: "RESOLUTION_APPROVAL_MISMATCH",
                statusCode: 409
            });
        }
        const timestamp = this.clock().toISOString();
        const command = this.deviceCommandStore.getCommand(resolutionCase.commandId);

        if (resolution === "CONFIRMED_DISPENSED") {
            if (command.status !== "OUTCOME_UNKNOWN") {
                throw new ApplicationError("Original command is no longer uncertain.", {
                    code: "COMMAND_NOT_OUTCOME_UNKNOWN",
                    statusCode: 409
                });
            }
            this.deviceCommandStore.transitionCommand(command.commandId, "ACKNOWLEDGED", {
                timestamp,
                details: {
                    operatorResolution: resolution,
                    approvalRequestId: request.approvalRequestId
                }
            });
            this.eventEngine.recordHardwareAcknowledgement(
                command.eventId,
                "DISPENSING",
                {
                    status: "OPERATOR_CONFIRMED",
                    details: {
                        commandId: command.commandId,
                        resolutionCaseId: resolutionCase.resolutionCaseId,
                        approvalRequestId: request.approvalRequestId
                    }
                }
            );
        } else if (resolution === "CONFIRMED_NOT_DISPENSED") {
            this.store.appendWelfareEntry({
                eventId: command.eventId,
                commandId: command.commandId,
                resolutionCaseId: resolutionCase.resolutionCaseId,
                feederId: command.feederId,
                entryType: "CONFIRMED_NOT_DISPENSED",
                quantity: resolutionCase.welfareImpact.quantity,
                unit: resolutionCase.welfareImpact.unit,
                countsAsDispensed: false,
                recordedAt: timestamp,
                details: { approvalRequestId: request.approvalRequestId }
            });
        } else if (resolution === "CANCELLED_FOR_WELFARE") {
            this.eventEngine.cancelForWelfare(command.eventId, {
                resolutionCaseId: resolutionCase.resolutionCaseId,
                approvalRequestId: request.approvalRequestId,
                reason: request.reason
            });
        } else {
            throw new ApplicationError("Resolution type cannot be executed.", {
                code: "OPERATOR_RESOLUTION_NOT_EXECUTABLE",
                statusCode: 409
            });
        }

        const resolved = this.store.resolveCase(
            resolutionCase.resolutionCaseId,
            resolution,
            timestamp
        );
        this.recalculateFeederSafety(resolved.feederId);
        this.audit(context, {
            action: "OUTCOME_UNKNOWN_RESOLVED",
            targetType: "OPERATOR_RESOLUTION_CASE",
            targetId: resolved.resolutionCaseId,
            barnId: resolved.barnId,
            feederId: resolved.feederId,
            deviceId: resolved.deviceId,
            reason: request.reason,
            approvalId: request.approvalRequestId,
            result: "SUCCEEDED",
            beforeSummary: this.safeCase(resolutionCase),
            afterSummary: this.safeCase(resolved)
        });
        this.eventEngine.scheduleProcessing(resolved.feederId);
        return resolved;
    }

    executeReplacement(request, context) {
        const resolutionCase = this.requireCase(
            request.actionPayload.resolutionCaseId
        );
        if (resolutionCase.replacementCommandId) {
            const existing = this.deviceCommandStore.getCommand(
                resolutionCase.replacementCommandId
            );
            if (existing?.resolutionCaseId === resolutionCase.resolutionCaseId) {
                return existing;
            }
        }
        if (
            resolutionCase.status !== "RESOLVED"
            || resolutionCase.finalResolution !== "CONFIRMED_NOT_DISPENSED"
            || resolutionCase.replacementCommandId
        ) {
            throw new ApplicationError("Resolution Case is not replacement eligible.", {
                code: "REPLACEMENT_COMMAND_NOT_ELIGIBLE",
                statusCode: 409
            });
        }
        const welfareCheck = this.welfareValidationService.validateReplacement(
            resolutionCase
        );
        const original = this.deviceCommandStore.getCommand(resolutionCase.commandId);
        const replacement = this.deviceCommandService.createReplacementCommand({
            originalCommand: original,
            resolutionCase,
            approvalRequestId: request.approvalRequestId,
            welfareCheck
        });
        const updated = this.store.setReplacementCommand(
            resolutionCase.resolutionCaseId,
            replacement.commandId
        );
        this.recalculateFeederSafety(updated.feederId);
        this.audit(context, {
            action: "REPLACEMENT_DEVICE_COMMAND_CREATED",
            targetType: "DEVICE_COMMAND",
            targetId: replacement.commandId,
            barnId: replacement.barnId,
            feederId: replacement.feederId,
            deviceId: replacement.deviceId,
            reason: request.reason,
            approvalId: request.approvalRequestId,
            result: "SUCCEEDED",
            metadata: {
                resolutionCaseId: resolutionCase.resolutionCaseId,
                replacementOfCommandId: original.commandId,
                welfareCheck
            }
        });
        this.eventEngine.scheduleProcessing(updated.feederId);
        return replacement;
    }

    getCases(filter = {}) {
        return this.store.getResolutionCases(filter);
    }

    getCase(resolutionCaseId) {
        return this.requireCase(resolutionCaseId);
    }

    getCountedWelfareQuantity(feederId) {
        const entries = this.store.getWelfareEntries(feederId);
        const correctedCases = new Set(entries
            .filter(entry => entry.entryType === "CONFIRMED_NOT_DISPENSED")
            .map(entry => entry.resolutionCaseId));
        return entries
            .filter(entry => (
                entry.countsAsDispensed
                && !correctedCases.has(entry.resolutionCaseId)
            ))
            .reduce((sum, entry) => sum + Number(entry.quantity), 0);
    }

    recalculateFeederSafety(feederId) {
        const feeder = this.store.getFeederSafety(feederId);
        if (!feeder) {
            return null;
        }
        const hasStop = this.store.getEffectiveStops(
            feeder.barnId,
            feeder.feederId
        ).length > 0;
        const hasOpenCase = this.store.getResolutionCases({
            status: "OPEN",
            feederId
        }).length > 0;
        return this.store.setFeederSafety(
            feederId,
            feeder.barnId,
            hasStop ? "EMERGENCY_STOPPED"
                : hasOpenCase ? "BLOCKED_OUTCOME_UNKNOWN" : "ONLINE",
            hasStop ? "Emergency stop remains active"
                : hasOpenCase ? "Uncertain dispense outcome requires resolution" : null,
            this.clock().toISOString()
        );
    }

    blockFeeder(resolutionCase) {
        return this.store.setFeederSafety(
            resolutionCase.feederId,
            resolutionCase.barnId,
            "BLOCKED_OUTCOME_UNKNOWN",
            `Uncertain outcome case ${resolutionCase.resolutionCaseId}`,
            this.clock().toISOString()
        );
    }

    requireCase(resolutionCaseId) {
        const resolutionCase = this.store.getResolutionCase(resolutionCaseId);
        if (!resolutionCase) {
            throw new ApplicationError("Operator Resolution Case was not found.", {
                code: "OPERATOR_RESOLUTION_CASE_NOT_FOUND",
                statusCode: 404
            });
        }
        return resolutionCase;
    }

    requireOpenCase(resolutionCaseId, expectedApprovalRequestId = null) {
        const resolutionCase = this.requireCase(resolutionCaseId);
        if (resolutionCase.status !== "OPEN") {
            throw new ApplicationError("Operator Resolution Case is already closed.", {
                code: "OPERATOR_RESOLUTION_CASE_CLOSED",
                statusCode: 409
            });
        }
        if (
            resolutionCase.approvalRequestId
            && resolutionCase.approvalRequestId !== expectedApprovalRequestId
        ) {
            const approval = this.approvalService.getRequest(
                resolutionCase.approvalRequestId
            );
            if (["PENDING", "PARTIALLY_APPROVED", "APPROVED"].includes(
                approval.status
            )) {
                throw new ApplicationError(
                    "A resolution approval request is already pending.",
                    {
                        code: "RESOLUTION_APPROVAL_ALREADY_PENDING",
                        statusCode: 409
                    }
                );
            }
        }
        return resolutionCase;
    }

    audit(context, input) {
        return this.auditService.record({
            administratorId: context?.identity?.administratorId || null,
            effectiveRole: context?.authorization?.effectiveRole || null,
            requestId: context?.requestId || null,
            authenticationStrength:
                context?.identity?.authenticationStrength || null,
            ...input
        });
    }

    safeCase(resolutionCase) {
        return {
            resolutionCaseId: resolutionCase.resolutionCaseId,
            eventId: resolutionCase.eventId,
            commandId: resolutionCase.commandId,
            barnId: resolutionCase.barnId,
            feederId: resolutionCase.feederId,
            status: resolutionCase.status,
            finalResolution: resolutionCase.finalResolution,
            replacementCommandId: resolutionCase.replacementCommandId,
            welfareImpact: resolutionCase.welfareImpact
        };
    }

    options() {
        return {
            clock: this.clock,
            ...(this.idGenerator ? { idGenerator: this.idGenerator } : {})
        };
    }
}
