import { ApplicationError } from "../errors/application-error.js";

export class AuthenticationService {
    constructor({ provider, administratorStore, auditService, clock = () => new Date() }) {
        this.provider = provider;
        this.administratorStore = administratorStore;
        this.auditService = auditService;
        this.clock = clock;
    }

    async authenticate(request) {
        let providerIdentity;
        try {
            providerIdentity = await this.provider.authenticate(request);
        } catch (error) {
            this.auditService.record({
                action: "LOGIN_REJECTED",
                targetType: "ADMINISTRATOR_SESSION",
                requestId: request.requestId,
                result: "REJECTED",
                reason: error.code || "AUTHENTICATION_FAILED",
                metadata: { path: request.originalUrl, method: request.method }
            });
            throw error;
        }

        const administrator = this.administratorStore
            .getAdministratorByExternalIdentity(providerIdentity.externalIdentityId);
        if (!administrator) {
            this.auditService.record({
                action: "LOGIN_REJECTED",
                targetType: "ADMINISTRATOR_SESSION",
                requestId: request.requestId,
                authenticationStrength: providerIdentity.authenticationStrength,
                result: "REJECTED",
                reason: "IDENTITY_NOT_MAPPED",
                metadata: { path: request.originalUrl, method: request.method }
            });
            throw new ApplicationError("Administrator identity is not registered.", {
                code: "ADMINISTRATOR_IDENTITY_NOT_REGISTERED",
                statusCode: 403
            });
        }
        if (administrator.status !== "ACTIVE") {
            this.auditService.record({
                administratorId: administrator.administratorId,
                action: "LOGIN_REJECTED",
                targetType: "ADMINISTRATOR",
                targetId: administrator.administratorId,
                requestId: request.requestId,
                authenticationStrength: providerIdentity.authenticationStrength,
                result: "REJECTED",
                reason: `ADMINISTRATOR_${administrator.status}`,
                metadata: { path: request.originalUrl, method: request.method }
            });
            throw new ApplicationError("Administrator access is not active.", {
                code: `ADMINISTRATOR_${administrator.status}`,
                statusCode: 403
            });
        }

        const assignments = this.administratorStore.getIdentityAssignments(
            administrator.administratorId
        );
        const roles = [...new Set(assignments.map(assignment => assignment.role))];
        const barnScopes = assignments.flatMap(assignment => (
            assignment.barnIds.map(barnId => ({
                roleAssignmentId: assignment.roleAssignmentId,
                role: assignment.role,
                barnId
            }))
        ));
        const trustedIdentity = Object.freeze({
            administratorId: administrator.administratorId,
            externalIdentityId: administrator.externalIdentityId,
            displayName: administrator.displayName,
            email: administrator.email,
            status: administrator.status,
            roles: Object.freeze(roles),
            assignments: Object.freeze(assignments.map(assignment => Object.freeze({
                ...assignment,
                barnIds: Object.freeze([...assignment.barnIds])
            }))),
            barnScopes: Object.freeze(barnScopes.map(scope => Object.freeze(scope))),
            authenticationTime: providerIdentity.authenticatedAt,
            authenticationStrength: providerIdentity.authenticationStrength,
            sessionId: providerIdentity.sessionId
        });
        const auditRecord = this.auditService.create({
            administratorId: administrator.administratorId,
            action: "LOGIN_ACCEPTED",
            targetType: "ADMINISTRATOR_SESSION",
            targetId: administrator.administratorId,
            requestId: request.requestId,
            authenticationStrength: providerIdentity.authenticationStrength,
            timestamp: providerIdentity.authenticatedAt,
            result: "SUCCEEDED",
            metadata: { path: request.originalUrl, method: request.method }
        });
        const recorded = this.administratorStore.recordAuthentication(
            administrator.administratorId,
            providerIdentity.authenticatedAt,
            auditRecord
        );
        if (!recorded) {
            throw new ApplicationError("Administrator access is no longer active.", {
                code: "ADMINISTRATOR_NOT_ACTIVE",
                statusCode: 403
            });
        }
        return trustedIdentity;
    }
}
