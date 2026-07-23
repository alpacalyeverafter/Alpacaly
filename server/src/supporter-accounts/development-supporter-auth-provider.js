import { ApplicationError } from "../errors/application-error.js";
import { SupporterAuthProvider } from "./supporter-auth-provider.js";

const DEFAULT_IDENTITIES = Object.freeze([
    Object.freeze({
        credential: "local-supporter",
        externalIdentityId: "development|local-supporter",
        email: "supporter@example.test",
        emailVerified: true,
        displayName: "Local Supporter"
    }),
    Object.freeze({
        credential: "unverified-supporter",
        externalIdentityId: "development|unverified-supporter",
        email: "unverified@example.test",
        emailVerified: false,
        displayName: "Unverified Supporter"
    }),
    Object.freeze({
        credential: "local-supporter-two",
        externalIdentityId: "development|local-supporter-two",
        email: "second-supporter@example.test",
        emailVerified: true,
        displayName: "Second Local Supporter"
    })
]);

export class DevelopmentSupporterAuthProvider extends SupporterAuthProvider {
    constructor({ config, clock = () => new Date(), identities = DEFAULT_IDENTITIES }) {
        super();
        if (config.nodeEnv === "production") {
            throw new Error("Development supporter authentication cannot run in production.");
        }
        if (!config.enableDevelopmentSupporterAuthentication) {
            throw new Error("Development supporter authentication is not enabled.");
        }
        this.providerName = "development";
        this.clock = clock;
        this.publicReturnUrl = config.supporterPublicReturnUrl;
        this.identities = new Map(identities.map(identity => [
            identity.credential,
            Object.freeze({ ...identity })
        ]));
    }

    async getIdentity(request) {
        const credential = String(request.get("x-development-supporter") || "").trim();
        if (!credential) {
            return null;
        }
        const identity = this.identities.get(credential);
        if (!identity) {
            throw new ApplicationError("Supporter authentication is required.", {
                code: "SUPPORTER_AUTHENTICATION_REQUIRED",
                statusCode: 401
            });
        }
        const authenticatedAt = this.clock().toISOString();
        return Object.freeze({
            providerName: this.providerName,
            externalIdentityId: identity.externalIdentityId,
            email: identity.email,
            emailVerified: identity.emailVerified,
            displayName: identity.displayName,
            authenticatedAt,
            issuedAt: authenticatedAt,
            sessionId: `development-session:${credential}`,
            authenticationStrength: "DEVELOPMENT"
        });
    }

    async login() {
        throw new ApplicationError(
            "Use the configured development supporter identity header.",
            { code: "DEVELOPMENT_SUPPORTER_LOGIN_REQUIRED", statusCode: 401 }
        );
    }

    async logout(_request, response) {
        response.redirect(303, this.publicReturnUrl);
    }
}
