import { Router } from "express";

import { PERMISSIONS } from "../authorization/permissions.js";
import { ApplicationError } from "../errors/application-error.js";
import { authorizeAdministrator } from "../middleware/administrator-security.js";

function actionContext(req) {
    return {
        identity: req.administratorIdentity,
        authorization: req.administratorAuthorization,
        requestId: req.requestId,
        reason: req.body?.reason
    };
}

function barnContext(req) {
    return {
        barnId: req.params.barnId,
        targetType: "BARN",
        targetId: req.params.barnId
    };
}

function feederContext(req) {
    return {
        barnId: req.params.barnId,
        feederId: req.params.feederId,
        targetType: "FEEDER",
        targetId: req.params.feederId
    };
}

function deviceContext(req) {
    return {
        barnId: req.params.barnId,
        deviceId: req.params.deviceId,
        targetType: "DEVICE",
        targetId: req.params.deviceId
    };
}

function controllerContext(store) {
    return req => {
        const controller = store.getController(req.params.controllerId);
        return {
            barnId: controller?.barnId || req.query.barnId || null,
            targetType: "SIMULATED_CONTROLLER",
            targetId: req.params.controllerId || null
        };
    };
}

function authorize(services, permission, resolveContext = barnContext, options = {}) {
    return authorizeAdministrator({
        authorizationService: services.authorizationService,
        auditService: services.auditService,
        permission,
        resolveContext,
        ...options
    });
}

function requireBarn(store, barnId) {
    const barn = store.getBarn(barnId);
    if (!barn) {
        throw new ApplicationError("Barn was not found.", {
            code: "BARN_NOT_FOUND",
            statusCode: 404
        });
    }
    return barn;
}

function requireFeeder(store, feederId, barnId) {
    const feeder = store.getFeederForBarn(feederId, barnId);
    if (!feeder) {
        throw new ApplicationError("Feeder was not found in this Barn.", {
            code: "FEEDER_NOT_FOUND",
            statusCode: 404
        });
    }
    return feeder;
}

function requireDevice(store, deviceId, barnId) {
    const device = store.getDeviceForBarn(deviceId, barnId);
    if (!device) {
        throw new ApplicationError("Device was not found in this Barn.", {
            code: "DEVICE_NOT_FOUND",
            statusCode: 404
        });
    }
    return device;
}

export function createAdministratorRouter({
    eventEngine,
    config,
    administratorSecurityServices,
    deviceCommandServices,
    contributionLedgerServices,
    operatorSafetyServices
}) {
    const router = Router();
    const services = administratorSecurityServices;
    const store = services.store;
    const operations = services.resourceOperationsService;
    const safety = operatorSafetyServices;
    const controllers = deviceCommandServices.controllerService;
    const controllerStore = deviceCommandServices.controllerStore;

    router.get(
        "/diagnostics/persistence",
        authorize(
            services,
            PERMISSIONS.MANAGE_SECURITY_CONFIGURATION,
            () => ({ targetType: "PERSISTENCE_DIAGNOSTICS" }),
            { platformWide: true }
        ),
        (req, res) => {
            const persistence = eventEngine.eventStore.getPersistenceDiagnostics();
            const outboxBacklog = eventEngine.eventStore.database.prepare(`
                SELECT status, COUNT(*) AS count
                FROM Outbox GROUP BY status ORDER BY status
            `).all();
            const commandBacklog = eventEngine.eventStore.database.prepare(`
                SELECT status, COUNT(*) AS count
                FROM DeviceCommands GROUP BY status ORDER BY status
            `).all();
            res.status(200).json({
                persistence,
                coordination: {
                    feedIntents: contributionLedgerServices.claimStore.getDiagnostics(),
                    deviceCommands: deviceCommandServices.claimStore.getDiagnostics()
                },
                backlog: {
                    feedIntents: Object.fromEntries(outboxBacklog.map(
                        row => [row.status, Number(row.count)]
                    )),
                    deviceCommands: Object.fromEntries(commandBacklog.map(
                        row => [row.status, Number(row.count)]
                    ))
                },
                requestId: req.requestId
            });
        }
    );

    router.get("/session", (req, res) => {
        const identity = req.administratorIdentity;
        res.status(200).json({
            administrator: {
                administratorId: identity.administratorId,
                displayName: identity.displayName,
                email: identity.email,
                roles: identity.roles,
                barnScopes: identity.barnScopes,
                authenticationTime: identity.authenticationTime,
                authenticationStrength: identity.authenticationStrength
            },
            requestId: req.requestId
        });
    });

    router.get(
        "/barns/:barnId/status",
        authorize(services, PERMISSIONS.VIEW_BARN_STATUS),
        (req, res, next) => {
            try {
                const barn = requireBarn(store, req.params.barnId);
                const resources = eventEngine.eventStore.getResources();
                const feeders = resources.feeders
                    .filter(item => item.barnId === barn.barnId)
                    .map(item => store.getFeeder(item.feederId));
                const devices = resources.devices
                    .filter(item => item.barnId === barn.barnId)
                    .map(item => store.getDevice(item.deviceId));
                res.status(200).json({
                    barn,
                    feeders,
                    devices,
                    queues: eventEngine.getAllQueueStatistics()
                        .filter(item => item.barnId === barn.barnId),
                    requestId: req.requestId
                });
            } catch (error) {
                next(error);
            }
        }
    );

    router.get(
        "/barns/:barnId/queues",
        authorize(services, PERMISSIONS.VIEW_QUEUES),
        (req, res, next) => {
            try {
                requireBarn(store, req.params.barnId);
                const feeders = eventEngine.eventStore.getResources().feeders
                    .filter(item => item.barnId === req.params.barnId);
                const queues = feeders.map(feeder => ({
                    feeder: store.getFeeder(feeder.feederId),
                    queueStatistics: eventEngine.getQueueStatistics(feeder.feederId),
                    feedRequests: eventEngine.getQueueSummary(feeder.feederId),
                    archivedFeedRequests: eventEngine.getArchivedSummary(feeder.feederId)
                }));
                res.status(200).json({ queues, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.get(
        "/barns/:barnId/feeders/:feederId/feed-requests",
        authorize(services, PERMISSIONS.VIEW_QUEUES, feederContext),
        (req, res, next) => {
            try {
                const feeder = requireFeeder(
                    store,
                    req.params.feederId,
                    req.params.barnId
                );
                res.status(200).json({
                    feeder,
                    feedRequests: eventEngine.getQueueSummary(feeder.feederId),
                    archivedFeedRequests: eventEngine.getArchivedSummary(feeder.feederId),
                    queueStatistics: eventEngine.getQueueStatistics(feeder.feederId),
                    requestId: req.requestId
                });
            } catch (error) {
                next(error);
            }
        }
    );

    router.get(
        "/barns/:barnId/audit-records",
        authorize(services, PERMISSIONS.VIEW_AUDIT_HISTORY),
        (req, res, next) => {
            try {
                requireBarn(store, req.params.barnId);
                res.status(200).json({
                    auditRecords: store.getAuditRecords({
                        barnId: req.params.barnId,
                        limit: req.query.limit
                    }),
                    requestId: req.requestId
                });
            } catch (error) {
                next(error);
            }
        }
    );

    router.get(
        "/barns/:barnId/welfare-notes",
        authorize(services, PERMISSIONS.VIEW_AUDIT_HISTORY),
        (req, res, next) => {
            try {
                requireBarn(store, req.params.barnId);
                const feederId = req.query.feederId || null;
                if (feederId) {
                    requireFeeder(store, feederId, req.params.barnId);
                }
                res.status(200).json({
                    welfareNotes: store.getWelfareNotes(
                        req.params.barnId,
                        feederId
                    ),
                    requestId: req.requestId
                });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/barns/:barnId/welfare-notes",
        authorize(services, PERMISSIONS.RECORD_WELFARE_NOTE),
        (req, res, next) => {
            try {
                const note = operations.recordWelfareNote({
                    barnId: req.params.barnId,
                    feederId: req.body?.feederId || null,
                    note: req.body?.note
                }, actionContext(req));
                res.status(201).json({ welfareNote: note, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/barns/:barnId/feeders/:feederId/pause",
        authorize(services, PERMISSIONS.PAUSE_FEEDING, feederContext),
        (req, res, next) => {
            try {
                const feeder = operations.setFeederStatus(
                    req.params.feederId,
                    req.params.barnId,
                    "PAUSED",
                    actionContext(req)
                );
                res.status(200).json({ feeder, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/barns/:barnId/feeders/:feederId/resume",
        authorize(services, PERMISSIONS.PAUSE_FEEDING, feederContext),
        (req, res, next) => {
            try {
                const feeder = operations.setFeederStatus(
                    req.params.feederId,
                    req.params.barnId,
                    "AVAILABLE",
                    actionContext(req)
                );
                res.status(200).json({ feeder, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/barns/:barnId/feeders/:feederId/unavailable",
        authorize(services, PERMISSIONS.SET_WELFARE_UNAVAILABLE, feederContext),
        (req, res, next) => {
            try {
                const feeder = operations.setFeederStatus(
                    req.params.feederId,
                    req.params.barnId,
                    "WELFARE_UNAVAILABLE",
                    actionContext(req)
                );
                res.status(200).json({ feeder, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/barns/:barnId/feeders/:feederId/maintenance",
        authorize(services, PERMISSIONS.SET_MAINTENANCE, feederContext),
        (req, res, next) => {
            try {
                const feeder = operations.setFeederStatus(
                    req.params.feederId,
                    req.params.barnId,
                    "MAINTENANCE",
                    actionContext(req)
                );
                res.status(200).json({ feeder, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/barns/:barnId/feeders/:feederId/maintenance/clear",
        authorize(services, PERMISSIONS.SET_MAINTENANCE, feederContext),
        (req, res, next) => {
            try {
                const feeder = operations.setFeederStatus(
                    req.params.feederId,
                    req.params.barnId,
                    "AVAILABLE",
                    actionContext(req)
                );
                res.status(200).json({ feeder, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.get(
        "/barns/:barnId/device-commands",
        authorize(services, PERMISSIONS.VIEW_COMMAND_HISTORY),
        (req, res, next) => {
            try {
                requireBarn(store, req.params.barnId);
                const commands = deviceCommandServices.deviceCommandStore
                    .getAllCommands()
                    .filter(command => command.barnId === req.params.barnId)
                    .map(command => ({
                        ...command,
                        acknowledgements: deviceCommandServices.deviceCommandStore
                            .getAcknowledgementsForCommand(command.commandId),
                        history: deviceCommandServices.deviceCommandStore
                            .getHistory(command.commandId)
                    }));
                res.status(200).json({ commands, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/barns/:barnId/devices/:deviceId/status",
        authorize(services, PERMISSIONS.SET_MAINTENANCE, deviceContext),
        (req, res, next) => {
            try {
                const device = operations.setDeviceStatus(
                    req.params.deviceId,
                    req.params.barnId,
                    req.body?.status,
                    actionContext(req)
                );
                res.status(200).json({ device, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/barns/:barnId/devices/:deviceId/pause",
        authorize(services, PERMISSIONS.PAUSE_DEVICE, deviceContext),
        (req, res, next) => {
            try {
                const device = operations.setDeviceStatus(
                    req.params.deviceId,
                    req.params.barnId,
                    "PAUSED",
                    actionContext(req)
                );
                res.status(200).json({ device, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/barns/:barnId/devices/:deviceId/resume",
        authorize(services, PERMISSIONS.PAUSE_DEVICE, deviceContext),
        (req, res, next) => {
            try {
                const before = requireDevice(
                    store,
                    req.params.deviceId,
                    req.params.barnId
                );
                if (before.operationalStatus === "MAINTENANCE") {
                    throw new ApplicationError(
                        "Use the maintenance control to clear Device maintenance.",
                        {
                            code: "DEVICE_MAINTENANCE_CLEAR_REQUIRED",
                            statusCode: 409
                        }
                    );
                }
                const device = operations.setDeviceStatus(
                    req.params.deviceId,
                    req.params.barnId,
                    "AVAILABLE",
                    actionContext(req)
                );
                res.status(200).json({ device, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/barns/:barnId/device-commands/:commandId/retry",
        authorize(services, PERMISSIONS.REQUEST_COMMAND_RETRY, req => ({
            barnId: req.params.barnId,
            targetType: "DEVICE_COMMAND",
            targetId: req.params.commandId
        })),
        (req, res, next) => {
            try {
                const command = operations.requestCommandRetry(
                    req.params.commandId,
                    { ...actionContext(req), barnId: req.params.barnId }
                );
                res.status(202).json({ command, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/barns/:barnId/device-commands/:commandId/review-requests",
        authorize(services, PERMISSIONS.REQUEST_UNCERTAIN_OUTCOME_REVIEW, req => ({
            barnId: req.params.barnId,
            targetType: "DEVICE_COMMAND",
            targetId: req.params.commandId
        })),
        (req, res, next) => {
            try {
                const auditRecord = operations.requestUncertainOutcomeReview(
                    req.params.commandId,
                    { ...actionContext(req), barnId: req.params.barnId }
                );
                res.status(202).json({ auditRecord, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/barns/:barnId/hardware-alerts/:alertId/acknowledgements",
        authorize(services, PERMISSIONS.ACKNOWLEDGE_HARDWARE_ALERT),
        (req, res, next) => {
            try {
                if (req.body?.deviceId) {
                    requireDevice(store, req.body.deviceId, req.params.barnId);
                }
                const auditRecord = operations.acknowledgeHardwareAlert(
                    req.params.alertId,
                    {
                        ...actionContext(req),
                        barnId: req.params.barnId,
                        deviceId: req.body?.deviceId || null,
                        emergencyRelated: req.body?.emergencyRelated === true
                    }
                );
                res.status(201).json({ auditRecord, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.get(
        "/administrators",
        authorize(
            services,
            PERMISSIONS.MANAGE_ADMINISTRATORS,
            () => ({ targetType: "ADMINISTRATOR_DIRECTORY" }),
            { platformWide: true }
        ),
        (req, res) => {
            res.status(200).json({
                administrators: store.getAdministrators().map(administrator => (
                    services.administratorService.getAdministratorDetails(
                        administrator.administratorId
                    )
                )),
                requestId: req.requestId
            });
        }
    );

    router.post(
        "/administrators",
        authorize(
            services,
            PERMISSIONS.MANAGE_ADMINISTRATORS,
            () => ({ targetType: "ADMINISTRATOR" }),
            { platformWide: true }
        ),
        (req, res, next) => {
            try {
                const administrator = services.administratorService.createAdministrator(
                    req.body,
                    actionContext(req)
                );
                res.status(201).json({ administrator, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/administrators/:administratorId/status",
        authorize(
            services,
            PERMISSIONS.MANAGE_ADMINISTRATORS,
            req => ({ targetType: "ADMINISTRATOR", targetId: req.params.administratorId }),
            { platformWide: true }
        ),
        (req, res, next) => {
            try {
                const administrator = services.administratorService.setStatus(
                    req.params.administratorId,
                    req.body?.status,
                    actionContext(req)
                );
                res.status(200).json({ administrator, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/administrators/:administratorId/role-assignments",
        authorize(
            services,
            PERMISSIONS.MANAGE_ROLE_ASSIGNMENTS,
            req => ({ targetType: "ADMINISTRATOR", targetId: req.params.administratorId }),
            { platformWide: true }
        ),
        (req, res, next) => {
            try {
                const roleAssignment = services.administratorService.assignRole(
                    req.params.administratorId,
                    req.body,
                    actionContext(req)
                );
                res.status(201).json({ roleAssignment, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.delete(
        "/administrators/:administratorId/role-assignments/:roleAssignmentId",
        authorize(
            services,
            PERMISSIONS.MANAGE_ROLE_ASSIGNMENTS,
            req => ({ targetType: "ROLE_ASSIGNMENT", targetId: req.params.roleAssignmentId }),
            { platformWide: true }
        ),
        (req, res, next) => {
            try {
                const roleAssignment = services.administratorService.removeRole(
                    req.params.administratorId,
                    req.params.roleAssignmentId,
                    actionContext(req)
                );
                res.status(200).json({ roleAssignment, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/administrators/:administratorId/role-assignments/:roleAssignmentId/barn-scopes",
        authorize(
            services,
            PERMISSIONS.MANAGE_BARN_SCOPES,
            req => ({ targetType: "ROLE_ASSIGNMENT", targetId: req.params.roleAssignmentId }),
            { platformWide: true }
        ),
        (req, res, next) => {
            try {
                const barnScope = services.administratorService.assignBarnScope(
                    req.params.administratorId,
                    req.params.roleAssignmentId,
                    req.body?.barnId,
                    actionContext(req)
                );
                res.status(201).json({ barnScope, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.delete(
        "/administrators/:administratorId/barn-scopes/:barnScopeId",
        authorize(
            services,
            PERMISSIONS.MANAGE_BARN_SCOPES,
            req => ({ targetType: "BARN_SCOPE", targetId: req.params.barnScopeId }),
            { platformWide: true }
        ),
        (req, res, next) => {
            try {
                const barnScope = services.administratorService.removeBarnScope(
                    req.params.administratorId,
                    req.params.barnScopeId,
                    actionContext(req)
                );
                res.status(200).json({ barnScope, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.get(
        "/audit-records",
        authorize(
            services,
            PERMISSIONS.VIEW_AUDIT_HISTORY,
            () => ({ targetType: "OPERATOR_AUDIT" }),
            { platformWide: true }
        ),
        (req, res) => {
            res.status(200).json({
                auditRecords: store.getAuditRecords({ limit: req.query.limit }),
                requestId: req.requestId
            });
        }
    );

    router.get(
        "/security/configuration",
        authorize(
            services,
            PERMISSIONS.MANAGE_SECURITY_CONFIGURATION,
            () => ({ targetType: "SECURITY_CONFIGURATION" }),
            { platformWide: true }
        ),
        (req, res) => {
            res.status(200).json({
                security: {
                    authenticationProvider: config.enableDevelopmentAuthentication
                        ? "DEVELOPMENT"
                        : "UNCONFIGURED",
                    developmentAuthenticationEnabled:
                        config.enableDevelopmentAuthentication === true,
                    passwordsStored: false,
                    managedIdentityProviderConnected: false
                },
                requestId: req.requestId
            });
        }
    );

    router.get(
        "/device-transport",
        authorize(services, PERMISSIONS.VIEW_DEVICE_CONTROLLERS, req => ({
            barnId: req.query.barnId || null,
            targetType: "DEVICE_TRANSPORT"
        })),
        (req, res) => {
            res.status(200).json({
                transport: controllers.getTransportStatus(),
                requestId: req.requestId
            });
        }
    );

    router.get(
        "/device-controllers",
        authorize(services, PERMISSIONS.VIEW_DEVICE_CONTROLLERS, req => ({
            barnId: req.query.barnId || null,
            targetType: "SIMULATED_CONTROLLER"
        })),
        (req, res) => {
            res.status(200).json({
                controllers: controllers.list({
                    barnId: req.query.barnId || null
                }),
                requestId: req.requestId
            });
        }
    );

    router.get(
        "/device-controllers/:controllerId",
        authorize(
            services,
            PERMISSIONS.VIEW_DEVICE_CONTROLLERS,
            controllerContext(controllerStore)
        ),
        (req, res, next) => {
            try {
                res.status(200).json({
                    controller: controllers.get(req.params.controllerId),
                    requestId: req.requestId
                });
            } catch (error) {
                next(error);
            }
        }
    );

    router.get(
        "/device-controllers/:controllerId/protocol",
        authorize(
            services,
            PERMISSIONS.VIEW_DEVICE_CONTROLLERS,
            controllerContext(controllerStore)
        ),
        (req, res, next) => {
            try {
                res.status(200).json({
                    protocol: controllers.getProtocolVisibility(
                        req.params.controllerId,
                        req.query.limit
                    ),
                    requestId: req.requestId
                });
            } catch (error) {
                next(error);
            }
        }
    );

    router.get(
        "/device-controllers/:controllerId/executions",
        authorize(
            services,
            PERMISSIONS.VIEW_COMMAND_HISTORY,
            controllerContext(controllerStore)
        ),
        (req, res, next) => {
            try {
                res.status(200).json({
                    executions: controllers.getRecentExecutions(
                        req.params.controllerId,
                        req.query.limit
                    ),
                    requestId: req.requestId
                });
            } catch (error) {
                next(error);
            }
        }
    );

    router.get(
        [
            "/device-controllers/:controllerId/edge",
            "/device-controllers/:controllerId/edge-status"
        ],
        authorize(
            services,
            PERMISSIONS.VIEW_DEVICE_CONTROLLERS,
            controllerContext(controllerStore)
        ),
        (req, res, next) => {
            try {
                res.status(200).json({
                    edge: controllers.getEdgeVisibility(
                        req.params.controllerId,
                        req.query.limit
                    ),
                    requestId: req.requestId
                });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/device-controllers/:controllerId/status",
        authorize(
            services,
            PERMISSIONS.MANAGE_SIMULATED_CONTROLLERS,
            controllerContext(controllerStore)
        ),
        (req, res, next) => {
            try {
                const controller = controllers.setEnabled(
                    req.params.controllerId,
                    req.body?.enabled === true,
                    actionContext(req)
                );
                if (controller?.approvalRequestId) {
                    res.status(202).json({
                        approvalRequest: controller,
                        requestId: req.requestId
                    });
                } else {
                    res.status(200).json({ controller, requestId: req.requestId });
                }
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/device-controllers/:controllerId/assignments/:feederId",
        authorize(
            services,
            PERMISSIONS.MANAGE_SIMULATED_CONTROLLERS,
            controllerContext(controllerStore)
        ),
        (req, res, next) => {
            try {
                const result = controllers.reassignFeeder(
                    req.params.controllerId,
                    req.params.feederId,
                    actionContext(req)
                );
                if (result?.approvalRequestId) {
                    res.status(202).json({
                        approvalRequest: result,
                        requestId: req.requestId
                    });
                } else {
                    res.status(200).json({
                        assignment: result,
                        requestId: req.requestId
                    });
                }
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/device-controllers/:controllerId/connection",
        authorize(
            services,
            PERMISSIONS.MANAGE_SIMULATED_CONTROLLERS,
            controllerContext(controllerStore)
        ),
        (req, res, next) => {
            try {
                const controller = controllers.setConnectionState(
                    req.params.controllerId,
                    req.body?.connectionState,
                    actionContext(req)
                );
                res.status(200).json({ controller, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        [
            "/device-controllers/:controllerId/simulation-behaviour",
            "/device-controllers/:controllerId/simulation-behavior"
        ],
        authorize(
            services,
            PERMISSIONS.MANAGE_SIMULATED_CONTROLLERS,
            controllerContext(controllerStore)
        ),
        (req, res, next) => {
            try {
                const controller = controllers.configureBehaviour(
                    req.params.controllerId,
                    req.body?.behaviour || req.body,
                    actionContext(req)
                );
                res.status(200).json({ controller, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/device-controllers/:controllerId/restart",
        authorize(
            services,
            PERMISSIONS.MANAGE_SIMULATED_CONTROLLERS,
            controllerContext(controllerStore)
        ),
        (req, res, next) => {
            try {
                const controller = controllers.restart(
                    req.params.controllerId,
                    actionContext(req)
                );
                res.status(200).json({ controller, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.get(
        "/safety/emergency-stops",
        authorize(services, PERMISSIONS.VIEW_BARN_STATUS, req => ({
            barnId: req.query.barnId || null,
            targetType: "EMERGENCY_STOP"
        })),
        (req, res) => {
            res.status(200).json({
                emergencyStops: safety.emergencyStopService.getActiveStops({
                    barnId: req.query.barnId || null,
                    feederId: req.query.feederId || null
                }),
                requestId: req.requestId
            });
        }
    );

    router.post(
        "/safety/emergency-stops",
        authorize(services, PERMISSIONS.ACTIVATE_EMERGENCY_STOP, req => ({
            barnId: req.body?.barnId || null,
            feederId: req.body?.feederId || null,
            targetType: "EMERGENCY_STOP"
        }), {
            rejectionAction: "EMERGENCY_STOP_ACTIVATION_REJECTED"
        }),
        (req, res, next) => {
            try {
                const emergencyStop = safety.emergencyStopService.activate(
                    req.body,
                    actionContext(req)
                );
                res.status(201).json({ emergencyStop, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/safety/emergency-stops/:emergencyStopId/clearance-requests",
        authorize(services, PERMISSIONS.REQUEST_EMERGENCY_STOP_CLEAR, req => {
            const stop = safety.store.getEmergencyStop(req.params.emergencyStopId);
            return {
                barnId: stop?.barnId || null,
                feederId: stop?.feederId || null,
                targetType: "EMERGENCY_STOP",
                targetId: req.params.emergencyStopId
            };
        }),
        (req, res, next) => {
            try {
                const approvalRequest = safety.emergencyStopService.requestClear(
                    req.params.emergencyStopId,
                    req.body,
                    actionContext(req)
                );
                res.status(202).json({ approvalRequest, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.get(
        "/safety/approval-requests",
        authorize(services, PERMISSIONS.VIEW_AUDIT_HISTORY, req => ({
            barnId: req.query.barnId || null,
            targetType: "APPROVAL_REQUEST"
        })),
        (req, res) => {
            res.status(200).json({
                approvalRequests: safety.approvalService.getRequests({
                    status: req.query.status || null,
                    barnId: req.query.barnId || null
                }),
                requestId: req.requestId
            });
        }
    );

    router.get(
        "/safety/approval-requests/:approvalRequestId",
        authorize(services, PERMISSIONS.VIEW_AUDIT_HISTORY, req => {
            const approval = safety.store.getApprovalRequest(
                req.params.approvalRequestId
            );
            return {
                barnId: approval?.barnId || null,
                feederId: approval?.feederId || null,
                targetType: "APPROVAL_REQUEST",
                targetId: req.params.approvalRequestId
            };
        }),
        (req, res, next) => {
            try {
                res.status(200).json({
                    approvalRequest: safety.approvalService.getRequest(
                        req.params.approvalRequestId
                    ),
                    requestId: req.requestId
                });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/safety/approval-requests/:approvalRequestId/decisions",
        authorize(services, PERMISSIONS.APPROVE_CRITICAL_ACTION, req => {
            const approval = safety.store.getApprovalRequest(
                req.params.approvalRequestId
            );
            return {
                barnId: approval?.barnId || null,
                feederId: approval?.feederId || null,
                targetType: "APPROVAL_REQUEST",
                targetId: req.params.approvalRequestId
            };
        }),
        (req, res, next) => {
            try {
                const approvalRequest = safety.approvalService.decide(
                    req.params.approvalRequestId,
                    req.body,
                    actionContext(req)
                );
                res.status(200).json({ approvalRequest, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.get(
        "/safety/resolution-cases",
        authorize(services, PERMISSIONS.VIEW_COMMAND_HISTORY, req => ({
            barnId: req.query.barnId || null,
            feederId: req.query.feederId || null,
            targetType: "OPERATOR_RESOLUTION_CASE"
        })),
        (req, res) => {
            res.status(200).json({
                resolutionCases: safety.operatorResolutionService.getCases({
                    status: req.query.status || null,
                    barnId: req.query.barnId || null,
                    feederId: req.query.feederId || null
                }),
                requestId: req.requestId
            });
        }
    );

    router.post(
        "/safety/resolution-cases/:resolutionCaseId/resolution-requests",
        authorize(services, PERMISSIONS.RESOLVE_UNCERTAIN_OUTCOME, req => {
            const resolutionCase = safety.store.getResolutionCase(
                req.params.resolutionCaseId
            );
            return {
                barnId: resolutionCase?.barnId || null,
                feederId: resolutionCase?.feederId || null,
                targetType: "OPERATOR_RESOLUTION_CASE",
                targetId: req.params.resolutionCaseId
            };
        }),
        (req, res, next) => {
            try {
                const result = safety.operatorResolutionService.requestResolution(
                    req.params.resolutionCaseId,
                    req.body,
                    actionContext(req)
                );
                res.status(202).json({ ...result, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.post(
        "/safety/resolution-cases/:resolutionCaseId/replacement-requests",
        authorize(services, PERMISSIONS.REQUEST_REPLACEMENT_COMMAND, req => {
            const resolutionCase = safety.store.getResolutionCase(
                req.params.resolutionCaseId
            );
            return {
                barnId: resolutionCase?.barnId || null,
                feederId: resolutionCase?.feederId || null,
                targetType: "OPERATOR_RESOLUTION_CASE",
                targetId: req.params.resolutionCaseId
            };
        }),
        (req, res, next) => {
            try {
                const approvalRequest = safety.operatorResolutionService
                    .requestReplacement(
                        req.params.resolutionCaseId,
                        req.body,
                        actionContext(req)
                    );
                res.status(202).json({ approvalRequest, requestId: req.requestId });
            } catch (error) {
                next(error);
            }
        }
    );

    router.get(
        "/safety/audit-records",
        authorize(services, PERMISSIONS.VIEW_AUDIT_HISTORY, req => ({
            barnId: req.query.barnId || null,
            targetType: "OPERATOR_SAFETY_AUDIT"
        })),
        (req, res) => {
            const safetyAction = /EMERGENCY|APPROVAL|OUTCOME_UNKNOWN|REPLACEMENT|WELFARE_CANCEL/i;
            const auditRecords = store.getAuditRecords({
                barnId: req.query.barnId || null,
                limit: req.query.limit || 500
            }).filter(record => safetyAction.test(record.action));
            res.status(200).json({ auditRecords, requestId: req.requestId });
        }
    );

    return router;
}
