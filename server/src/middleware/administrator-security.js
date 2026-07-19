export function authenticateAdministrator(authenticationService) {
    return async function authenticate(req, _res, next) {
        try {
            req.administratorIdentity = await authenticationService.authenticate(req);
            next();
        } catch (error) {
            next(error);
        }
    };
}

export function authorizeAdministrator({
    authorizationService,
    auditService,
    permission,
    resolveContext = () => ({}),
    platformWide = false
}) {
    return function authorize(req, _res, next) {
        let context = {};
        try {
            context = resolveContext(req) || {};
            req.administratorAuthorization = authorizationService.authorize(
                req.administratorIdentity,
                permission,
                { ...context, platformWide }
            );
            next();
        } catch (error) {
            auditService.record({
                administratorId: req.administratorIdentity?.administratorId || null,
                barnId: context.barnId || null,
                feederId: context.feederId || null,
                deviceId: context.deviceId || null,
                action: "UNAUTHORIZED_ACTION_REJECTED",
                targetType: context.targetType || "ADMINISTRATOR_API",
                targetId: context.targetId || null,
                reason: error.code || "AUTHORIZATION_FAILED",
                requestId: req.requestId,
                authenticationStrength:
                    req.administratorIdentity?.authenticationStrength || null,
                result: "REJECTED",
                metadata: {
                    permission,
                    method: req.method,
                    path: req.originalUrl
                }
            });
            next(error);
        }
    };
}
