import { ApplicationError } from "../errors/application-error.js";

function requireReason(value) {
    const reason = typeof value === "string" ? value.trim() : "";
    if (!reason) {
        throw new ApplicationError("A reason is required.", {
            code: "CONTROLLER_ACTION_REASON_REQUIRED",
            statusCode: 400
        });
    }
    return reason.slice(0, 1000);
}

export class DeviceControllerService {
    constructor({
        store,
        transport,
        config,
        clock = () => new Date(),
        recoverySafetyService = null
    }) {
        this.store = store;
        this.transport = transport;
        this.config = config;
        this.clock = clock;
        this.recoverySafetyService = recoverySafetyService;
        this.auditService = null;
        this.approvalService = null;
        this.worker = null;
    }

    setAdministratorSecurityServices(services) {
        this.auditService = services.auditService;
    }

    setApprovalService(approvalService) {
        this.approvalService = approvalService;
        approvalService.registerExecutor(
            "ENABLE_PRODUCTION_CONTROLLER",
            (request, context) => this.executeApprovedEnable(request, context)
        );
        approvalService.registerExecutor(
            "REASSIGN_PRODUCTION_CONTROLLER",
            (request, context) => this.executeApprovedReassignment(request, context)
        );
    }

    setWorker(worker) {
        this.worker = worker;
    }

    list({ barnId = null } = {}) {
        return this.store.getControllers({ barnId });
    }

    get(controllerId) {
        const controller = this.store.getController(controllerId);
        if (!controller) {
            throw new ApplicationError("Simulated controller was not found.", {
                code: "SIMULATED_CONTROLLER_NOT_FOUND",
                statusCode: 404
            });
        }
        return controller;
    }

    getRecentExecutions(controllerId, limit) {
        this.get(controllerId);
        return this.store.getRecentExecutions(controllerId, limit);
    }

    setEnabled(controllerId, enabled, context) {
        if (enabled) {
            this.recoverySafetyService?.assertOperationAllowed("CONTROLLER_ENABLEMENT");
        }
        const before = this.get(controllerId);
        const reason = requireReason(context?.reason);
        if (enabled && !before.enabled && this.config.nodeEnv === "production") {
            if (!this.approvalService) {
                throw new Error("Controller approval service is not configured.");
            }
            return this.approvalService.createRequest({
                actionType: "ENABLE_PRODUCTION_CONTROLLER",
                targetType: "DEVICE_CONTROLLER",
                targetId: controllerId,
                barnId: before.barnId,
                reason,
                requiredAuthorities: ["HARDWARE", "PLATFORM_ADMIN"],
                actionPayload: { controllerId }
            }, context);
        }
        let after = this.store.setEnabled(
            controllerId,
            Boolean(enabled),
            this.clock().toISOString()
        );
        if (after.enabled && after.connectionState === "ONLINE") {
            after = this.store.heartbeat(
                controllerId,
                this.clock().toISOString()
            );
        }
        this.audit(context, {
            action: after.enabled
                ? "SIMULATED_CONTROLLER_ENABLED"
                : "SIMULATED_CONTROLLER_DISABLED",
            targetType: "SIMULATED_CONTROLLER",
            targetId: controllerId,
            barnId: after.barnId,
            reason,
            result: "SUCCEEDED",
            beforeSummary: this.safeSummary(before),
            afterSummary: this.safeSummary(after)
        });
        if (after.enabled) {
            void this.worker?.processReadyCommands();
        }
        void this.transport.publishAssignments?.(controllerId);
        return after;
    }

    executeApprovedEnable(request, context) {
        this.recoverySafetyService?.assertOperationAllowed("CONTROLLER_ENABLEMENT");
        const controllerId = request.actionPayload.controllerId;
        const before = this.get(controllerId);
        if (before.enabled) {
            return before;
        }
        const after = this.store.setEnabled(
            controllerId,
            true,
            this.clock().toISOString()
        );
        this.audit(context, {
            action: "PRODUCTION_CONTROLLER_ENABLED",
            targetType: "DEVICE_CONTROLLER",
            targetId: controllerId,
            barnId: after.barnId,
            reason: request.reason,
            approvalId: request.approvalRequestId,
            result: "SUCCEEDED",
            beforeSummary: this.safeSummary(before),
            afterSummary: this.safeSummary(after)
        });
        void this.transport.publishAssignments?.(controllerId);
        void this.worker?.processReadyCommands();
        return after;
    }

    reassignFeeder(controllerId, feederId, context) {
        const controller = this.get(controllerId);
        const reason = requireReason(context?.reason);
        if (this.config.nodeEnv === "production") {
            if (!this.approvalService) {
                throw new Error("Controller approval service is not configured.");
            }
            return this.approvalService.createRequest({
                actionType: "REASSIGN_PRODUCTION_CONTROLLER",
                targetType: "FEEDER_CONTROLLER_ASSIGNMENT",
                targetId: feederId,
                barnId: controller.barnId,
                feederId,
                reason,
                requiredAuthorities: ["HARDWARE", "PLATFORM_ADMIN"],
                actionPayload: { controllerId, feederId }
            }, context);
        }
        const assignment = this.store.reassignFeeder(feederId, controllerId, {
            timestamp: this.clock().toISOString(),
            reason
        });
        this.audit(context, {
            action: "SIMULATED_CONTROLLER_REASSIGNED",
            targetType: "FEEDER_CONTROLLER_ASSIGNMENT",
            targetId: feederId,
            barnId: controller.barnId,
            feederId,
            reason,
            result: "SUCCEEDED",
            afterSummary: assignment
        });
        void this.transport.publishAssignments?.(controllerId);
        return assignment;
    }

    executeApprovedReassignment(request, context) {
        const { controllerId, feederId } = request.actionPayload;
        const previous = this.store.getAssignmentForFeeder(feederId);
        const assignment = this.store.reassignFeeder(feederId, controllerId, {
            timestamp: this.clock().toISOString(),
            reason: request.reason,
            approvalRequestId: request.approvalRequestId
        });
        this.audit(context, {
            action: "PRODUCTION_CONTROLLER_REASSIGNED",
            targetType: "FEEDER_CONTROLLER_ASSIGNMENT",
            targetId: feederId,
            barnId: assignment.barnId,
            feederId,
            reason: request.reason,
            approvalId: request.approvalRequestId,
            result: "SUCCEEDED",
            beforeSummary: previous,
            afterSummary: assignment
        });
        void this.transport.publishAssignments?.(previous?.controllerId);
        void this.transport.publishAssignments?.(controllerId);
        return assignment;
    }

    getTransportStatus() {
        return this.transport.getConnectionStatus();
    }

    getProtocolVisibility(controllerId, limit = 100) {
        const controller = this.get(controllerId);
        return {
            transport: this.getTransportStatus(),
            controller: this.safeSummary(controller),
            recentProtocolEvents: this.store.getProtocolEvents({
                controllerId,
                limit
            })
        };
    }

    getEdgeVisibility(controllerId, limit = 50) {
        this.get(controllerId);
        return this.store.getEdgeStatus(controllerId, limit);
    }

    setConnectionState(controllerId, state, context) {
        this.assertDevelopmentConfigurationAllowed();
        const before = this.get(controllerId);
        const reason = requireReason(context?.reason);
        const after = this.transport.setConnectionState
            ? this.transport.setConnectionState(controllerId, state)
            : this.store.setConnectionState(
                controllerId,
                state,
                this.clock().toISOString()
            );
        this.audit(context, {
            action: "SIMULATED_CONTROLLER_CONNECTION_CONFIGURED",
            targetType: "SIMULATED_CONTROLLER",
            targetId: controllerId,
            barnId: after.barnId,
            reason,
            result: "SUCCEEDED",
            beforeSummary: this.safeSummary(before),
            afterSummary: this.safeSummary(after)
        });
        if (after.connectionState === "ONLINE") {
            void this.worker?.processReadyCommands();
        }
        return after;
    }

    configureBehaviour(controllerId, behaviour, context) {
        this.assertDevelopmentConfigurationAllowed();
        const before = this.get(controllerId);
        const reason = requireReason(context?.reason);
        let after;
        try {
            after = this.store.setBehaviour(
                controllerId,
                behaviour,
                this.clock().toISOString()
            );
        } catch (error) {
            throw new ApplicationError(error.message, {
                code: "SIMULATION_BEHAVIOUR_INVALID",
                statusCode: 400
            });
        }
        this.audit(context, {
            action: "SIMULATED_CONTROLLER_BEHAVIOUR_CONFIGURED",
            targetType: "SIMULATED_CONTROLLER",
            targetId: controllerId,
            barnId: after.barnId,
            reason,
            result: "SUCCEEDED",
            beforeSummary: this.safeSummary(before),
            afterSummary: this.safeSummary(after)
        });
        return after;
    }

    restart(controllerId, context) {
        this.assertDevelopmentConfigurationAllowed();
        const controller = this.get(controllerId);
        const reason = requireReason(context?.reason);
        const restart = this.transport.restartController?.(controllerId);
        restart?.uncertainCommandIds?.forEach(commandId => {
            void this.worker?.processCommand(commandId, { forceReconcile: true });
        });
        const after = this.get(controllerId);
        this.audit(context, {
            action: "SIMULATED_CONTROLLER_RESTARTED",
            targetType: "SIMULATED_CONTROLLER",
            targetId: controllerId,
            barnId: controller.barnId,
            reason,
            result: "SUCCEEDED",
            beforeSummary: this.safeSummary(controller),
            afterSummary: this.safeSummary(after)
        });
        return after;
    }

    assertDevelopmentConfigurationAllowed() {
        if (!this.config.enableSimulatedControllerConfiguration) {
            throw new ApplicationError(
                "Simulated controller configuration is disabled.",
                {
                    code: "SIMULATED_CONTROLLER_CONFIGURATION_DISABLED",
                    statusCode: 403
                }
            );
        }
    }

    audit(context, input) {
        if (!this.auditService) {
            throw new Error("Controller audit service is not configured.");
        }
        return this.auditService.record({
            administratorId: context?.identity?.administratorId || null,
            effectiveRole: context?.authorization?.effectiveRole || null,
            requestId: context?.requestId || null,
            authenticationStrength:
                context?.identity?.authenticationStrength || null,
            ...input
        });
    }

    safeSummary(controller) {
        return {
            controllerId: controller.controllerId,
            barnId: controller.barnId,
            enabled: controller.enabled,
            connectionState: controller.connectionState,
            status: controller.status,
            softwareVersion: controller.softwareVersion,
            protocolVersion: controller.protocolVersion,
            lastSeenAt: controller.lastSeenAt,
            controllerBootId: controller.controllerBootId,
            bootCounter: controller.bootCounter,
            lastHeartbeatReceivedAt: controller.lastHeartbeatReceivedAt,
            statusExpiresAt: controller.statusExpiresAt,
            revokedAt: controller.revokedAt,
            assignments: controller.assignments.map(assignment => ({
                barnId: assignment.barnId,
                feederId: assignment.feederId,
                assignmentGeneration: assignment.assignmentGeneration,
                authorityLeaseExpiresAt: assignment.authorityLeaseExpiresAt,
                authorityLeaseValid: Number.isFinite(
                    Date.parse(assignment.authorityLeaseExpiresAt)
                ) && Date.parse(assignment.authorityLeaseExpiresAt)
                    > this.clock().getTime()
            })),
            simulationBehaviour: controller.simulationBehaviour
        };
    }
}
