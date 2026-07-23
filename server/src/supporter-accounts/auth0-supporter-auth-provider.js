import { createHash } from "node:crypto";

import { auth } from "express-openid-connect";

import { ApplicationError } from "../errors/application-error.js";
import { SupporterAuthProvider } from "./supporter-auth-provider.js";

function timestampFromSeconds(value, fallback = new Date()) {
    const seconds = Number(value);
    return Number.isFinite(seconds)
        ? new Date(seconds * 1000).toISOString()
        : fallback.toISOString();
}

function fallbackSessionId(user, idToken) {
    return `auth0-session:${createHash("sha256")
        .update(typeof idToken === "string" && idToken
            ? idToken
            : `${user.sub}:${user.iat || user.auth_time || "unknown"}`)
        .digest("hex")}`;
}

export class Auth0SupporterAuthProvider extends SupporterAuthProvider {
    constructor({ config }) {
        super();
        this.providerName = "auth0";
        this.publicReturnUrl = config.supporterPublicReturnUrl;
        this.authMiddleware = auth({
            authRequired: false,
            auth0Logout: true,
            idpLogout: true,
            errorOnRequiredAuth: true,
            issuerBaseURL: config.auth0IssuerBaseUrl,
            baseURL: config.supporterAuthBaseUrl,
            clientID: config.auth0ClientId,
            clientSecret: config.auth0ClientSecret || undefined,
            secret: config.auth0SessionSecret,
            routes: {
                login: false,
                logout: false,
                callback: "/api/supporter-accounts/callback",
                postLogoutRedirect: config.supporterPublicReturnUrl
            },
            session: {
                name: "alpacaly_supporter_session",
                rolling: true,
                rollingDuration: config.supporterSessionRollingSeconds,
                absoluteDuration: config.supporterSessionAbsoluteSeconds,
                cookie: {
                    httpOnly: true,
                    sameSite: "Lax",
                    secure: new URL(config.supporterAuthBaseUrl).protocol === "https:"
                }
            },
            identityClaimFilter: [
                "aud", "iss", "exp", "nbf", "nonce", "azp",
                "s_hash", "at_hash", "c_hash"
            ]
        });
    }

    middleware() {
        return this.authMiddleware;
    }

    async getIdentity(request) {
        if (!request.oidc?.isAuthenticated?.()) {
            return null;
        }
        const user = request.oidc.user || {};
        if (typeof user.sub !== "string" || !user.sub.trim()) {
            throw new ApplicationError("The managed identity is incomplete.", {
                code: "SUPPORTER_IDENTITY_INVALID",
                statusCode: 401
            });
        }
        const now = new Date();
        return Object.freeze({
            providerName: this.providerName,
            externalIdentityId: user.sub,
            email: typeof user.email === "string" ? user.email : null,
            emailVerified: user.email_verified === true,
            displayName: typeof user.name === "string" ? user.name : null,
            authenticatedAt: timestampFromSeconds(user.auth_time, now),
            issuedAt: timestampFromSeconds(user.iat, now),
            sessionId: typeof user.sid === "string" && user.sid
                ? `auth0-session:${user.sid}`
                : fallbackSessionId(user, request.oidc.idToken),
            authenticationStrength: "MANAGED_OIDC"
        });
    }

    async login(_request, response) {
        await response.oidc.login({ returnTo: this.publicReturnUrl });
    }

    async logout(_request, response) {
        await response.oidc.logout({ returnTo: this.publicReturnUrl });
    }
}
