import {
    ADMINISTRATOR_STATUSES,
    createAdministrator,
    createBarnScope,
    createRoleAssignment
} from "../domain/administrator-security.js";
import { ApplicationError } from "../errors/application-error.js";

function requireReason(value) {
    const reason = typeof value === "string" ? value.trim() : "";
    if (!reason) {
        throw new ApplicationError("A reason is required for this action.", {
            code: "ADMINISTRATOR_ACTION_REASON_REQUIRED",
            statusCode: 400
        });
    }
    return reason.slice(0, 1000);
}

export class AdministratorService {
    constructor({ store, auditService, clock = () => new Date(), idGenerator }) {
        this.store = store;
        this.auditService = auditService;
        this.clock = clock;
        this.idGenerator = idGenerator;
    }

    createAdministrator(input, context) {
        const administrator = createAdministrator({
            externalIdentityId: input?.externalIdentityId,
            displayName: input?.displayName,
            email: input?.email,
            status: "ACTIVE"
        }, this.options());
        if (this.store.getAdministratorByExternalIdentity(
            administrator.externalIdentityId
        )) {
            throw new ApplicationError("External identity is already registered.", {
                code: "EXTERNAL_IDENTITY_ALREADY_REGISTERED",
                statusCode: 409
            });
        }
        const audit = this.auditService.create({
            ...this.auditContext(context),
            action: "ADMINISTRATOR_CREATED",
            targetType: "ADMINISTRATOR",
            targetId: administrator.administratorId,
            reason: context.reason,
            result: "SUCCEEDED",
            afterSummary: this.safeAdministrator(administrator)
        });
        return this.store.createAdministrator(administrator, audit);
    }

    setStatus(administratorId, status, context) {
        const normalizedStatus = String(status || "").trim().toUpperCase();
        if (!ADMINISTRATOR_STATUSES.includes(normalizedStatus)) {
            throw new ApplicationError("Administrator status is not supported.", {
                code: "ADMINISTRATOR_STATUS_NOT_SUPPORTED",
                statusCode: 400
            });
        }
        const before = this.requireAdministrator(administratorId);
        if (before.status === "REVOKED" && normalizedStatus !== "REVOKED") {
            throw new ApplicationError("A revoked Administrator cannot be reactivated.", {
                code: "ADMINISTRATOR_REVOCATION_FINAL",
                statusCode: 409
            });
        }
        if (before.administratorId === context.identity.administratorId
            && normalizedStatus !== "ACTIVE") {
            throw new ApplicationError(
                "An Administrator cannot suspend or revoke their current identity.",
                {
                    code: "ADMINISTRATOR_SELF_DISABLE_FORBIDDEN",
                    statusCode: 409
                }
            );
        }
        const reason = requireReason(context.reason);
        const updatedAt = this.clock().toISOString();
        const after = { ...before, status: normalizedStatus, updatedAt };
        const action = normalizedStatus === "SUSPENDED"
            ? "ADMINISTRATOR_SUSPENDED"
            : normalizedStatus === "REVOKED"
                ? "ADMINISTRATOR_REVOKED"
                : "ADMINISTRATOR_ACTIVATED";
        const audit = this.auditService.create({
            ...this.auditContext(context),
            action,
            targetType: "ADMINISTRATOR",
            targetId: administratorId,
            reason,
            result: "SUCCEEDED",
            beforeSummary: this.safeAdministrator(before),
            afterSummary: this.safeAdministrator(after)
        });
        const persisted = this.store.updateAdministratorStatus(
            administratorId,
            normalizedStatus,
            updatedAt,
            audit
        );
        if (!persisted && before.status === normalizedStatus) {
            return before;
        }
        return persisted;
    }

    assignRole(administratorId, input, context) {
        this.requireAdministrator(administratorId);
        const assignment = createRoleAssignment({
            administratorId,
            role: input?.role,
            platformWide: input?.platformWide === true
        }, this.options());
        const audit = this.auditService.create({
            ...this.auditContext(context),
            action: "ROLE_ASSIGNED",
            targetType: "ROLE_ASSIGNMENT",
            targetId: assignment.roleAssignmentId,
            reason: context.reason,
            result: "SUCCEEDED",
            afterSummary: assignment
        });
        return this.store.assignRole(assignment, audit);
    }

    removeRole(administratorId, roleAssignmentId, context) {
        const assignment = this.store.getRoleAssignment(roleAssignmentId);
        if (!assignment || assignment.administratorId !== administratorId) {
            throw new ApplicationError("Role assignment was not found.", {
                code: "ROLE_ASSIGNMENT_NOT_FOUND",
                statusCode: 404
            });
        }
        const reason = requireReason(context.reason);
        const revokedAt = this.clock().toISOString();
        const audit = this.auditService.create({
            ...this.auditContext(context),
            action: "ROLE_REMOVED",
            targetType: "ROLE_ASSIGNMENT",
            targetId: roleAssignmentId,
            reason,
            result: "SUCCEEDED",
            beforeSummary: assignment,
            afterSummary: { ...assignment, revokedAt }
        });
        return this.store.revokeRole(roleAssignmentId, revokedAt, audit);
    }

    assignBarnScope(administratorId, roleAssignmentId, barnId, context) {
        const assignment = this.store.getRoleAssignment(roleAssignmentId);
        if (
            !assignment
            || assignment.administratorId !== administratorId
            || assignment.revokedAt
        ) {
            throw new ApplicationError("Active role assignment was not found.", {
                code: "ROLE_ASSIGNMENT_NOT_FOUND",
                statusCode: 404
            });
        }
        if (assignment.platformWide) {
            throw new ApplicationError(
                "Platform-wide assignments do not accept Barn scopes.",
                {
                    code: "PLATFORM_ASSIGNMENT_SCOPE_FORBIDDEN",
                    statusCode: 409
                }
            );
        }
        if (!this.store.getBarn(barnId)) {
            throw new ApplicationError("Barn was not found.", {
                code: "BARN_NOT_FOUND",
                statusCode: 404
            });
        }
        const scope = createBarnScope({
            roleAssignmentId,
            administratorId,
            barnId
        }, this.options());
        const audit = this.auditService.create({
            ...this.auditContext(context),
            barnId,
            action: "BARN_SCOPE_ASSIGNED",
            targetType: "BARN_SCOPE",
            targetId: scope.barnScopeId,
            reason: context.reason,
            result: "SUCCEEDED",
            afterSummary: scope
        });
        return this.store.assignBarnScope(scope, audit);
    }

    removeBarnScope(administratorId, barnScopeId, context) {
        const scope = this.store.getBarnScope(barnScopeId);
        if (!scope || scope.administratorId !== administratorId) {
            throw new ApplicationError("Barn scope was not found.", {
                code: "BARN_SCOPE_NOT_FOUND",
                statusCode: 404
            });
        }
        const reason = requireReason(context.reason);
        const revokedAt = this.clock().toISOString();
        const audit = this.auditService.create({
            ...this.auditContext(context),
            barnId: scope.barnId,
            action: "BARN_SCOPE_REMOVED",
            targetType: "BARN_SCOPE",
            targetId: barnScopeId,
            reason,
            result: "SUCCEEDED",
            beforeSummary: scope,
            afterSummary: { ...scope, revokedAt }
        });
        return this.store.revokeBarnScope(barnScopeId, revokedAt, audit);
    }

    getAdministratorDetails(administratorId) {
        const administrator = this.requireAdministrator(administratorId);
        return {
            administrator,
            roleAssignments: this.store.getRoleAssignments(administratorId),
            barnScopes: this.store.getBarnScopes(administratorId)
        };
    }

    requireAdministrator(administratorId) {
        const administrator = this.store.getAdministrator(administratorId);
        if (!administrator) {
            throw new ApplicationError("Administrator was not found.", {
                code: "ADMINISTRATOR_NOT_FOUND",
                statusCode: 404
            });
        }
        return administrator;
    }

    safeAdministrator(administrator) {
        return {
            administratorId: administrator.administratorId,
            externalIdentityId: administrator.externalIdentityId,
            displayName: administrator.displayName,
            email: administrator.email,
            status: administrator.status,
            createdAt: administrator.createdAt,
            updatedAt: administrator.updatedAt,
            lastAuthenticatedAt: administrator.lastAuthenticatedAt
        };
    }

    auditContext(context) {
        return {
            administratorId: context.identity.administratorId,
            effectiveRole: context.authorization.effectiveRole,
            requestId: context.requestId,
            authenticationStrength: context.identity.authenticationStrength
        };
    }

    options() {
        return {
            clock: this.clock,
            ...(this.idGenerator ? { idGenerator: this.idGenerator } : {})
        };
    }
}
