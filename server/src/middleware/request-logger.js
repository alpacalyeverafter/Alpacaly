import { randomUUID } from "node:crypto";

function readRequestId(headerValue) {
    if (typeof headerValue !== "string") {
        return randomUUID();
    }

    const candidate = headerValue.trim();
    return candidate && candidate.length <= 128 ? candidate : randomUUID();
}

export function requestLogger(logger) {
    return function logRequest(req, res, next) {
        const startedAt = process.hrtime.bigint();
        req.requestId = readRequestId(req.get("x-request-id"));
        res.set("x-request-id", req.requestId);

        res.on("finish", () => {
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
            logger.info({
                event: "http_request_completed",
                requestId: req.requestId,
                method: req.method,
                path: req.originalUrl,
                statusCode: res.statusCode,
                durationMs: Number(durationMs.toFixed(3))
            }, "HTTP request completed");
        });

        next();
    };
}
