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
    deviceCommandServices
}) {
    const router = Router();
    const services = administratorSecurityServices;
    const store = services.store;
    const operations = services.resourceOperationsService;

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

    return router;
}
