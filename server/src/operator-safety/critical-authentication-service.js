import { ApplicationError } from "../errors/application-error.js";

const PRODUCTION_STRENGTHS = Object.freeze(["MFA", "PHISHING_RESISTANT"]);

export class CriticalAuthenticationService {
    constructor({ config }) {
        this.config = config;
    }

    assert(identity) {
        if (!identity || identity.status !== "ACTIVE") {
            throw new ApplicationError(
                "An active authenticated administrator is required.",
                {
                    code: "CRITICAL_AUTHENTICATION_REQUIRED",
                    statusCode: 401
                }
            );
        }

        if (this.config.nodeEnv !== "production") {
            return identity;
        }
        if (this.config.enableDevelopmentAuthentication) {
            throw new ApplicationError(
                "Development authentication cannot authorize production safety actions.",
                {
                    code: "DEVELOPMENT_AUTHENTICATION_FORBIDDEN",
                    statusCode: 403
                }
            );
        }
        if (!this.config.managedIdentityProviderConfigured) {
            throw new ApplicationError(
                "A managed identity provider is required for critical safety actions.",
                {
                    code: "MANAGED_IDENTITY_PROVIDER_REQUIRED",
                    statusCode: 503
                }
            );
        }
        if (!PRODUCTION_STRENGTHS.includes(identity.authenticationStrength)) {
            throw new ApplicationError(
                "Stronger authentication is required for this safety action.",
                {
                    code: "CRITICAL_AUTHENTICATION_STRENGTH_INSUFFICIENT",
                    statusCode: 403
                }
            );
        }
        return identity;
    }
}
