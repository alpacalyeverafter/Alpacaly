import pino from "pino";

export function createLogger(config) {
    return pino({
        level: config.logLevel,
        base: {
            service: config.serviceName,
            environment: config.nodeEnv
        },
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: {
            level(label) {
                return { level: label };
            }
        }
    });
}
