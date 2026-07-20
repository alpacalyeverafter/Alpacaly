import { createEmergencyStop } from "../domain/operator-safety.js";
import { ApplicationError } from "../errors/application-error.js";

const SAFE_TO_CANCEL = Object.freeze([
    "PENDING", "READY", "RETRY_SCHEDULED"
]);
const UNCERTAIN_WHEN_STOPPED = Object.freeze(["SENT", "TIMED_OUT"]);

function requireReason(value) {
    const reason = typeof value === "string" ? value.trim() : "";
    if (!reason) {
        throw new ApplicationError("A reason is required for an emergency stop.", {
            code: "EMERGENCY_STOP_REASON_REQUIRED",
            statusCode: 400
        });
    }
    return reason.slice(0, 1000);
}

export class EmergencyStopService {
    constructor({
        store,
        administratorStore,
        auditService,
        criticalAuthenticationService,
        approvalService,
        deviceCommandStore,
        eventEngine,
        clock = () => new Date(),
        idGenerator
    }) {
        this.store = store;
        this.administratorStore = administratorStore;
        this.auditService = auditService;
        this.criticalAuthenticationService = criticalAuthenticationService;
        this.approvalService = approvalService;
        this.deviceCommandStore = deviceCommandStore;
        this.eventEngine = eventEngine;
        this.clock = clock;
        this.idGenerator = idGenerator;
        this.outcomeUnknownHandler = null;

        approvalService.registerExecutor(
            "CLEAR_EMERGENCY_STOP",
            (request, context) => this.executeClear(request, context)
        );
    }

    setOutcomeUnknownHandler(handler) {
        this.outcomeUnknownHandler = handler;
    }

    activate(input, context) {
        const reason = requireReason(input?.reason || context?.reason);
        try {
            this.criticalAuthenticationService.assert(context?.identity);
            const effectiveRole = context?.authorization?.effectiveRole;
            if (![
                "WELFARE_OPERATOR", "HARDWARE_OPERATOR", "ADMINISTRATOR"
            ].includes(effectiveRole)) {
                throw new ApplicationError(
                    "Administrator role cannot activate an emergency stop.",
                    {
                        code: "EMERGENCY_STOP_AUTHORITY_DENIED",
                        statusCode: 403
                    }
                );
            }
            if (
                String(input?.level || "").trim().toUpperCase() === "PLATFORM"
                && (
                    effectiveRole !== "ADMINISTRATOR"
                    || !context.identity.assignments?.some(assignment => (
                        assignment.role === "ADMINISTRATOR"
                        && assignment.platformWide === true
                    ))
                )
            ) {
                throw new ApplicationError(
                    "A platform Administrator is required for a platform stop.",
                    {
                        code: "PLATFORM_EMERGENCY_STOP_AUTHORITY_DENIED",
                        statusCode: 403
                    }
                );
            }
            this.validateScope(input);
            const stop = createEmergencyStop({
                level: input.level,
                barnId: input.barnId,
                feederId: input.feederId,
                activatedBy: context.identity.administratorId,
                activatedRole: context.authorization.effectiveRole,
                reason,
                requestId: context.requestId
            }, this.options());
            const active = this.store.getEmergencyStops({ status: "ACTIVE" })
                .find(candidate => (
                    candidate.level === stop.level
                    && candidate.barnId === stop.barnId
                    && candidate.feederId === stop.feederId
                ));
            if (active) {
                throw new ApplicationError(
                    "An emergency stop is already active for this scope.",
                    {
                        code: "EMERGENCY_STOP_ALREADY_ACTIVE",
                        statusCode: 409,
                        details: { emergencyStopId: active.emergencyStopId }
                    }
                );
            }
            const persisted = this.store.createEmergencyStop(stop);
            this.applyEmergencyEffects(persisted, context);
            this.audit(context, {
                action: "EMERGENCY_STOP_ACTIVATED",
                targetType: "EMERGENCY_STOP",
                targetId: persisted.emergencyStopId,
                barnId: persisted.barnId,
                feederId: persisted.feederId,
                reason,
                result: "SUCCEEDED",
                afterSummary: this.safeStop(persisted)
            });
            this.eventEngine.emitEngineUpdate("EMERGENCY_STOP_ACTIVATED");
            return persisted;
        } catch (error) {
            this.audit(context, {
                action: "EMERGENCY_STOP_ACTIVATION_REJECTED",
                targetType: "EMERGENCY_STOP",
                barnId: input?.barnId || null,
                feederId: input?.feederId || null,
                reason: error.code || String(error.message || error),
                result: "REJECTED"
            });
            throw error;
        }
    }

    requestClear(emergencyStopId, input, context) {
        const stop = this.requireActiveStop(emergencyStopId);
        const requiredAuthorities = stop.level === "PLATFORM"
            ? ["PLATFORM_ADMIN", "PLATFORM_ADMIN"]
            : ["WELFARE", "HARDWARE"];
        return this.approvalService.createRequest({
            actionType: "CLEAR_EMERGENCY_STOP",
            targetType: "EMERGENCY_STOP",
            targetId: emergencyStopId,
            barnId: stop.barnId,
            feederId: stop.feederId,
            reason: input?.reason || context?.reason,
            requiredAuthorities,
            actionPayload: { emergencyStopId }
        }, context);
    }

    executeClear(request, context) {
        const current = this.store.getEmergencyStop(
            request.actionPayload.emergencyStopId
        );
        if (
            current?.status === "CLEARED"
            && current.clearanceApprovalRequestId === request.approvalRequestId
        ) {
            return current;
        }
        const stop = this.requireActiveStop(request.actionPayload.emergencyStopId);
        const clearedAt = this.clock().toISOString();
        const cleared = this.store.clearEmergencyStop(
            stop.emergencyStopId,
            request.approvalRequestId,
            clearedAt
        );
        if (!cleared) {
            throw new ApplicationError("Emergency stop is no longer active.", {
                code: "EMERGENCY_STOP_NOT_ACTIVE",
                statusCode: 409
            });
        }
        this.recalculateAffectedFeederSafety(cleared);
        this.audit(context, {
            action: "EMERGENCY_STOP_CLEARED",
            targetType: "EMERGENCY_STOP",
            targetId: cleared.emergencyStopId,
            barnId: cleared.barnId,
            feederId: cleared.feederId,
            reason: request.reason,
            approvalId: request.approvalRequestId,
            result: "SUCCEEDED",
            beforeSummary: this.safeStop(stop),
            afterSummary: this.safeStop(cleared)
        });
        this.eventEngine.scheduleProcessing();
        this.eventEngine.emitEngineUpdate("EMERGENCY_STOP_CLEARED");
        return cleared;
    }

    isFeederBlocked(feederId, barnId = null) {
        const feeder = this.store.getFeederSafety(feederId);
        if (!feeder || (barnId && feeder.barnId !== barnId)) {
            return true;
        }
        return this.store.getEffectiveStops(feeder.barnId, feeder.feederId).length > 0
            || [
                "OFFLINE", "DEGRADED", "PAUSED", "MAINTENANCE",
                "EMERGENCY_STOPPED", "BLOCKED_OUTCOME_UNKNOWN", "UNKNOWN"
            ].includes(feeder.safetyStatus);
    }

    canProcessFeeder(feederId) {
        const feeder = this.store.getFeederSafety(feederId);
        return Boolean(feeder)
            && feeder.operationalStatus === "AVAILABLE"
            && !this.isFeederBlocked(feederId, feeder.barnId);
    }

    assertCommandMayProgress(command) {
        if (this.isFeederBlocked(command.feederId, command.barnId)) {
            throw new ApplicationError(
                "The feeder is blocked by an active safety condition.",
                {
                    code: "FEEDER_SAFETY_BLOCKED",
                    statusCode: 409,
                    details: { feederId: command.feederId }
                }
            );
        }
        return true;
    }

    getSafeAvailability(feederId) {
        const feeder = this.store.getFeederSafety(feederId);
        const available = Boolean(feeder)
            && feeder.operationalStatus === "AVAILABLE"
            && !this.isFeederBlocked(feederId, feeder?.barnId);
        return {
            available,
            status: available ? "AVAILABLE" : "TEMPORARILY_UNAVAILABLE",
            message: available
                ? "Feeding is available."
                : "Feeding is temporarily unavailable. Please try again later."
        };
    }

    getActiveStops(filter = {}) {
        return this.store.getEmergencyStops({ ...filter, status: "ACTIVE" });
    }

    reconcileOnStartup() {
        const activeStops = this.getActiveStops();
        activeStops.forEach(stop => {
            this.applyEmergencyEffects(stop, null, { startup: true });
            this.auditService.record({
                action: "EMERGENCY_STOP_RESTORED_ON_RESTART",
                targetType: "EMERGENCY_STOP",
                targetId: stop.emergencyStopId,
                barnId: stop.barnId,
                feederId: stop.feederId,
                reason: "SERVER_RESTART_WHILE_STOP_ACTIVE",
                result: "SUCCEEDED",
                afterSummary: this.safeStop(stop)
            });
        });
        return activeStops;
    }

    applyEmergencyEffects(stop, context, { startup = false } = {}) {
        this.affectedFeeders(stop).forEach(feeder => {
            this.store.setFeederSafety(
                feeder.feederId,
                feeder.barnId,
                "EMERGENCY_STOPPED",
                `Emergency stop ${stop.emergencyStopId}`,
                this.clock().toISOString()
            );
        });
        this.store.getCommandsForStop(stop).forEach(command => {
            if (SAFE_TO_CANCEL.includes(command.status)) {
                const cancelled = this.deviceCommandStore.transitionCommand(
                    command.commandId,
                    "CANCELLED",
                    {
                        timestamp: this.clock().toISOString(),
                        lastError: "Cancelled by emergency stop before delivery",
                        details: {
                            emergencyStopId: stop.emergencyStopId,
                            provenNotStarted: true,
                            startup
                        }
                    }
                );
                this.audit(context, {
                    action: "DEVICE_COMMAND_CANCELLED_BY_EMERGENCY_STOP",
                    targetType: "DEVICE_COMMAND",
                    targetId: cancelled.commandId,
                    barnId: cancelled.barnId,
                    feederId: cancelled.feederId,
                    deviceId: cancelled.deviceId,
                    reason: stop.reason,
                    result: "SUCCEEDED",
                    metadata: { emergencyStopId: stop.emergencyStopId }
                });
            } else if (UNCERTAIN_WHEN_STOPPED.includes(command.status)) {
                const uncertain = this.deviceCommandStore.transitionCommand(
                    command.commandId,
                    "OUTCOME_UNKNOWN",
                    {
                        timestamp: this.clock().toISOString(),
                        lastError: "Emergency stop occurred after delivery began",
                        details: {
                            emergencyStopId: stop.emergencyStopId,
                            deliveryOutcome: "UNKNOWN",
                            startup
                        }
                    }
                );
                this.outcomeUnknownHandler?.(uncertain, {
                    reason: "EMERGENCY_STOP_AFTER_DELIVERY",
                    context
                });
                this.audit(context, {
                    action: "DEVICE_COMMAND_OUTCOME_UNKNOWN_BY_EMERGENCY_STOP",
                    targetType: "DEVICE_COMMAND",
                    targetId: uncertain.commandId,
                    barnId: uncertain.barnId,
                    feederId: uncertain.feederId,
                    deviceId: uncertain.deviceId,
                    reason: stop.reason,
                    result: "SUCCEEDED",
                    metadata: { emergencyStopId: stop.emergencyStopId }
                });
            }
        });
    }

    recalculateAffectedFeederSafety(stop) {
        this.affectedFeeders(stop).forEach(feeder => {
            const remainingStop = this.store.getEffectiveStops(
                feeder.barnId,
                feeder.feederId
            ).length > 0;
            const unresolved = this.store.getResolutionCases({
                status: "OPEN",
                feederId: feeder.feederId
            }).length > 0;
            const status = remainingStop
                ? "EMERGENCY_STOPPED"
                : unresolved ? "BLOCKED_OUTCOME_UNKNOWN" : "ONLINE";
            this.store.setFeederSafety(
                feeder.feederId,
                feeder.barnId,
                status,
                remainingStop
                    ? "Another emergency stop remains active"
                    : unresolved
                        ? "An uncertain dispense outcome requires operator resolution"
                        : null,
                this.clock().toISOString()
            );
        });
    }

    affectedFeeders(stop) {
        return this.store.getFeederSafetyStates().filter(feeder => (
            stop.level === "PLATFORM"
            || (stop.level === "BARN" && feeder.barnId === stop.barnId)
            || (stop.level === "FEEDER" && feeder.feederId === stop.feederId)
        ));
    }

    validateScope(input) {
        const level = String(input?.level || "").trim().toUpperCase();
        if (level === "PLATFORM") {
            return;
        }
        const barn = this.administratorStore.getBarn(input?.barnId);
        if (!barn) {
            throw new ApplicationError("Barn was not found.", {
                code: "BARN_NOT_FOUND",
                statusCode: 404
            });
        }
        if (level === "FEEDER" && !this.administratorStore.getFeederForBarn(
            input?.feederId,
            input?.barnId
        )) {
            throw new ApplicationError("Feeder was not found in this Barn.", {
                code: "FEEDER_NOT_FOUND",
                statusCode: 404
            });
        }
    }

    requireActiveStop(emergencyStopId) {
        const stop = this.store.getEmergencyStop(emergencyStopId);
        if (!stop) {
            throw new ApplicationError("Emergency stop was not found.", {
                code: "EMERGENCY_STOP_NOT_FOUND",
                statusCode: 404
            });
        }
        if (stop.status !== "ACTIVE") {
            throw new ApplicationError("Emergency stop is not active.", {
                code: "EMERGENCY_STOP_NOT_ACTIVE",
                statusCode: 409
            });
        }
        return stop;
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

    safeStop(stop) {
        return {
            emergencyStopId: stop.emergencyStopId,
            level: stop.level,
            barnId: stop.barnId,
            feederId: stop.feederId,
            status: stop.status,
            activatedAt: stop.activatedAt,
            clearedAt: stop.clearedAt
        };
    }

    options() {
        return {
            clock: this.clock,
            ...(this.idGenerator ? { idGenerator: this.idGenerator } : {})
        };
    }
}
