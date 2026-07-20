export class ApplicationError extends Error {
    constructor(message, { code = "APPLICATION_ERROR", statusCode = 500, details = null } = {}) {
        super(message);
        this.name = "ApplicationError";
        this.code = code;
        this.statusCode = statusCode;
        this.details = details;
        this.isOperational = true;
    }
}
