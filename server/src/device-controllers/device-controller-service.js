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
    constructor({ store, transport, config, clock = () => new Date() }) {
        this.store = store;
        this.transport = transport;
        this.config = config;
        this.clock = clock;
        this.auditService = null;
        this.worker = null;
    }

    setAdministratorSecurityServices(services) {
        this.auditService = services.auditService;
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
        const before = this.get(controllerId);
        const reason = requireReason(context?.reason);
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
        return after;
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
            assignments: controller.assignments.map(assignment => ({
                barnId: assignment.barnId,
                feederId: assignment.feederId
            })),
            simulationBehaviour: controller.simulationBehaviour
        };
    }
}
