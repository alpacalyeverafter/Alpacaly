import { createApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { createLogger } from "./logging/logger.js";

const config = loadConfig();
const logger = createLogger(config);
const app = createApp({ config, logger });

const server = app.listen(config.port, () => {
    logger.info({
        event: "server_started",
        port: config.port,
        nodeVersion: process.version
    }, "Alpacaly server started");
});

let shutdownStarted = false;
function shutdown(signal) {
    if (shutdownStarted) {
        return;
    }

    shutdownStarted = true;
    logger.info({ event: "server_shutdown_started", signal }, "Server shutdown started");

    server.close(error => {
        if (error) {
            logger.error({ event: "server_shutdown_failed", err: error }, "Server shutdown failed");
            process.exitCode = 1;
        } else {
            logger.info({ event: "server_stopped" }, "Alpacaly server stopped");
        }
    });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
