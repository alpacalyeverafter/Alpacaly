import {
    createAdministrator,
    createBarnScope,
    createRoleAssignment
} from "../domain/administrator-security.js";
import { DevelopmentAuthProvider } from "../authentication/development-auth-provider.js";
import { AuthenticationService } from "../authentication/authentication-service.js";
import { UnconfiguredAuthProvider } from "../authentication/unconfigured-auth-provider.js";
import { AuthorizationService } from "../authorization/authorization-service.js";
import { AdministratorService } from "./administrator-service.js";
import { DEVELOPMENT_IDENTITIES } from "./development-identities.js";
import { OperatorAuditService } from "./operator-audit-service.js";
import { ResourceOperationsService } from "./resource-operations-service.js";
import { SqliteAdministratorSecurityStore } from "./sqlite-administrator-security-store.js";

function seedDevelopmentIdentities(store, identities, options) {
    identities.forEach(identity => {
        const administrator = createAdministrator(identity, options);
        const assignment = createRoleAssignment({
            roleAssignmentId: `role_assignment_${identity.credential}`,
            administratorId: administrator.administratorId,
            role: identity.role,
            platformWide: identity.platformWide,
            assignedAt: identity.createdAt
        }, options);
        const scope = identity.barnId ? createBarnScope({
            barnScopeId: `barn_scope_${identity.credential}`,
            roleAssignmentId: assignment.roleAssignmentId,
            administratorId: administrator.administratorId,
            barnId: identity.barnId,
            assignedAt: identity.createdAt
        }, options) : null;
        store.seedDevelopmentIdentity(administrator, assignment, scope);
    });
}

export function createAdministratorSecurityServices({
    eventEngine,
    deviceCommandServices,
    config,
    clock = eventEngine.clock,
    idGenerator,
    authProvider = null,
    developmentIdentities = DEVELOPMENT_IDENTITIES
}) {
    const store = new SqliteAdministratorSecurityStore({
        eventStore: eventEngine.eventStore
    });
    const options = {
        clock,
        ...(idGenerator ? { idGenerator } : {})
    };

    let provider = authProvider;
    if (
        !provider
        && config.nodeEnv !== "production"
        && config.enableDevelopmentAuthentication
    ) {
        seedDevelopmentIdentities(store, developmentIdentities, options);
        provider = new DevelopmentAuthProvider({
            config,
            identities: developmentIdentities,
            clock
        });
    }
    provider ||= new UnconfiguredAuthProvider();

    const auditService = new OperatorAuditService({ store, ...options });
    const authenticationService = new AuthenticationService({
        provider,
        administratorStore: store,
        auditService,
        clock
    });
    const authorizationService = new AuthorizationService();
    const administratorService = new AdministratorService({
        store,
        auditService,
        ...options
    });
    const resourceOperationsService = new ResourceOperationsService({
        store,
        auditService,
        eventEngine,
        deviceCommandStore: deviceCommandServices.deviceCommandStore,
        deviceCommandWorker: deviceCommandServices.worker,
        recoverySafetyService: eventEngine.recoverySafetyService,
        ...options
    });

    return {
        store,
        provider,
        auditService,
        authenticationService,
        authorizationService,
        administratorService,
        resourceOperationsService
    };
}
