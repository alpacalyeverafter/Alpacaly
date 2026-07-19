import { ApplicationError } from "../errors/application-error.js";
import { AuthProvider } from "./auth-provider.js";

function readDevelopmentCredential(request) {
    const authorization = request.get("authorization");
    if (typeof authorization !== "string") {
        return null;
    }
    const match = /^Development\s+([^\s]+)$/i.exec(authorization.trim());
    return match ? match[1] : null;
}

export class DevelopmentAuthProvider extends AuthProvider {
    constructor({ config, identities, clock = () => new Date() }) {
        super();
        if (config.nodeEnv === "production") {
            throw new Error("Development authentication cannot run in production.");
        }
        if (!config.enableDevelopmentAuthentication) {
            throw new Error("Development authentication is not enabled.");
        }
        this.identities = new Map(identities.map(identity => [
            identity.credential,
            Object.freeze({ ...identity })
        ]));
        this.clock = clock;
    }

    async authenticate(request) {
        const credential = readDevelopmentCredential(request);
        const identity = credential ? this.identities.get(credential) : null;
        if (!identity) {
            throw new ApplicationError(
                "A valid administrator identity is required.",
                {
                    code: "ADMINISTRATOR_AUTHENTICATION_REQUIRED",
                    statusCode: 401
                }
            );
        }

        const authenticatedAt = this.clock().toISOString();
        return Object.freeze({
            externalIdentityId: identity.externalIdentityId,
            authenticatedAt,
            authenticationStrength: "DEVELOPMENT",
            sessionId: `development-session:${identity.externalIdentityId}`
        });
    }
}
