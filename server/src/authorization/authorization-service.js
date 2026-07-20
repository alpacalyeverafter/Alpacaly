import { ApplicationError } from "../errors/application-error.js";
import { PLATFORM_ONLY_PERMISSIONS, ROLE_PERMISSIONS } from "./permissions.js";

export class AuthorizationService {
    authorize(identity, permission, { barnId = null, platformWide = false } = {}) {
        if (!identity || identity.status !== "ACTIVE") {
            throw new ApplicationError("An active administrator identity is required.", {
                code: "ADMINISTRATOR_AUTHENTICATION_REQUIRED",
                statusCode: 401
            });
        }

        const requiresPlatform = platformWide
            || PLATFORM_ONLY_PERMISSIONS.includes(permission);
        const assignment = identity.assignments.find(candidate => {
            if (!ROLE_PERMISSIONS[candidate.role]?.includes(permission)) {
                return false;
            }
            if (requiresPlatform) {
                return candidate.platformWide === true;
            }
            if (candidate.platformWide) {
                return true;
            }
            return typeof barnId === "string" && candidate.barnIds.includes(barnId);
        });

        if (!assignment) {
            throw new ApplicationError("Administrator permission was denied.", {
                code: "ADMINISTRATOR_PERMISSION_DENIED",
                statusCode: 403,
                details: { permission }
            });
        }

        return Object.freeze({
            permission,
            effectiveRole: assignment.role,
            roleAssignmentId: assignment.roleAssignmentId,
            barnId,
            platformWide: assignment.platformWide
        });
    }
}
