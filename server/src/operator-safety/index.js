import { ApprovalService } from "./approval-service.js";
import { CriticalAuthenticationService } from "./critical-authentication-service.js";
import { EmergencyStopService } from "./emergency-stop-service.js";
import { OperatorResolutionService } from "./operator-resolution-service.js";
import { SqliteOperatorSafetyStore } from "./sqlite-operator-safety-store.js";
import { WelfareValidationService } from "./welfare-validation-service.js";

export function createOperatorSafetyServices({
    eventEngine,
    deviceCommandServices,
    administratorSecurityServices,
    config,
    clock = eventEngine.clock,
    idGenerator
}) {
    const options = {
        clock,
        ...(idGenerator ? { idGenerator } : {})
    };
    const store = new SqliteOperatorSafetyStore({
        eventStore: eventEngine.eventStore,
        ...(idGenerator ? { idGenerator } : {})
    });
    const criticalAuthenticationService = new CriticalAuthenticationService({
        config
    });
    const approvalService = new ApprovalService({
        store,
        administratorStore: administratorSecurityServices.store,
        auditService: administratorSecurityServices.auditService,
        criticalAuthenticationService,
        approvalLifetimeMs: config.criticalApprovalLifetimeMs,
        ...options
    });
    const welfareValidationService = new WelfareValidationService({
        store,
        eventEngine,
        config,
        clock
    });
    const operatorResolutionService = new OperatorResolutionService({
        store,
        auditService: administratorSecurityServices.auditService,
        criticalAuthenticationService,
        approvalService,
        welfareValidationService,
        deviceCommandStore: deviceCommandServices.deviceCommandStore,
        deviceCommandService: deviceCommandServices.deviceCommandService,
        eventEngine,
        ...options
    });
    const emergencyStopService = new EmergencyStopService({
        store,
        administratorStore: administratorSecurityServices.store,
        auditService: administratorSecurityServices.auditService,
        criticalAuthenticationService,
        approvalService,
        deviceCommandStore: deviceCommandServices.deviceCommandStore,
        eventEngine,
        ...options
    });

    emergencyStopService.setOutcomeUnknownHandler((command, context) => (
        operatorResolutionService.handleOutcomeUnknown(command, context)
    ));
    deviceCommandServices.deviceCommandService.setOutcomeUnknownHandler(command => (
        operatorResolutionService.handleOutcomeUnknown(command)
    ));
    deviceCommandServices.deviceCommandService.setSafetyService(emergencyStopService);
    deviceCommandServices.worker.setSafetyService(emergencyStopService);
    eventEngine.setSafetyService(emergencyStopService);

    operatorResolutionService.reconcileOnStartup();
    emergencyStopService.reconcileOnStartup();
    approvalService.expireRequests();

    return {
        store,
        criticalAuthenticationService,
        approvalService,
        welfareValidationService,
        operatorResolutionService,
        emergencyStopService
    };
}
