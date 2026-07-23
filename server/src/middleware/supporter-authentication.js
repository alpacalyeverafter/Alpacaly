import { ApplicationError } from "../errors/application-error.js";

export function attachSupporterIdentity(authenticationService) {
    return async function attach(req, _res, next) {
        try {
            req.supporterIdentity = await authenticationService.authenticate(req);
            next();
        } catch (error) {
            req.supporterIdentity = null;
            req.supporterAuthenticationError = error;
            next();
        }
    };
}

export function requireSupporter(req, _res, next) {
    if (!req.supporterIdentity) {
        next(req.supporterAuthenticationError || new ApplicationError(
            "Supporter authentication is required.", {
            code: "SUPPORTER_AUTHENTICATION_REQUIRED",
            statusCode: 401
        }));
        return;
    }
    next();
}

export function verifySupporterCsrf(authenticationService) {
    return function verify(req, _res, next) {
        try {
            authenticationService.verifyCsrf(
                req.supporterIdentity,
                req.get("x-alpacaly-csrf")
            );
            next();
        } catch (error) {
            next(error);
        }
    };
}
