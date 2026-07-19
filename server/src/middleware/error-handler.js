import { ApplicationError } from "../errors/application-error.js";

export function notFoundHandler(req, _res, next) {
    next(new ApplicationError(`Route not found: ${req.method} ${req.originalUrl}`, {
        code: "ROUTE_NOT_FOUND",
        statusCode: 404
    }));
}

export function createErrorHandler(logger) {
    return function errorHandler(error, req, res, _next) {
        let resolvedError = error;

        if (error?.type === "entity.parse.failed") {
            resolvedError = new ApplicationError("The request body contains invalid JSON.", {
                code: "INVALID_JSON",
                statusCode: 400
            });
        } else if (error?.type === "entity.too.large") {
            resolvedError = new ApplicationError("The request body is too large.", {
                code: "REQUEST_BODY_TOO_LARGE",
                statusCode: 413
            });
        }

        const isOperational = resolvedError instanceof ApplicationError;
        const statusCode = isOperational ? resolvedError.statusCode : 500;
        const code = isOperational ? resolvedError.code : "INTERNAL_SERVER_ERROR";
        const message = isOperational ? resolvedError.message : "An unexpected error occurred.";

        const logContext = {
            event: "request_failed",
            requestId: req.requestId,
            method: req.method,
            path: req.originalUrl,
            statusCode,
            errorCode: code
        };

        if (statusCode >= 500) {
            logger.error({ ...logContext, err: resolvedError }, "Request failed");
        } else {
            logger.warn(logContext, "Request rejected");
        }

        const response = {
            error: {
                code,
                message,
                requestId: req.requestId
            }
        };

        if (isOperational && resolvedError.details) {
            response.error.details = resolvedError.details;
        }

        res.status(statusCode).json(response);
    };
}
