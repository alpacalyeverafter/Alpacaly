import { createApp } from "./app.js";
import { loadConfig } from "./config/index.js";
import { createLogger } from "./logging/logger.js";

const config = loadConfig();
const logger = createLogger(config);
const app = createApp({ config, logger });

const sandboxDemoHost = process.env.SANDBOX_DEMO_BIND_HOST || undefined;
const server = app.listen(config.port, sandboxDemoHost, () => {
    logger.info({
        event: "server_started",
        port: config.port,
        ...(sandboxDemoHost ? { host: sandboxDemoHost } : {}),
        nodeVersion: process.version
    }, "Alpacaly server started");
});

let shutdownStarted = false;
async function shutdown(signal) {
    if (shutdownStarted) {
        return;
    }

    shutdownStarted = true;
    logger.info({ event: "server_shutdown_started", signal }, "Server shutdown started");

    const serverClosed = new Promise(resolve => {
        server.close(error => resolve(error));
    });

    try {
        app.locals.contributionLedgerServices.outboxWorker.stop();
        app.locals.feedCreditServices.service.stop();
        await app.locals.deviceCommandServices.worker.stop();
        await app.locals.eventEngine.shutdown();
    } catch (error) {
        logger.error({
            event: "event_store_shutdown_failed",
            err: error
        }, "Event Store shutdown failed");
        process.exitCode = 1;
    }

    server.closeAllConnections();
    const error = await serverClosed;
    if (error) {
        logger.error({ event: "server_shutdown_failed", err: error }, "Server shutdown failed");
        process.exitCode = 1;
    } else {
        logger.info({ event: "server_stopped" }, "Alpacaly server stopped");
    }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
