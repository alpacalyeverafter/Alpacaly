import express from "express";
import cors from "cors";

import { loadConfig } from "./config/index.js";
import { EventEngine } from "./event-engine/event-engine.js";
import { createLogger } from "./logging/logger.js";
import { createErrorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { requestLogger } from "./middleware/request-logger.js";
import { createEventEngineRouter } from "./routes/event-engine.js";
import { createFeedRequestsRouter } from "./routes/feed-requests.js";
import { createHealthRouter } from "./routes/health.js";

export function createApp(options = {}) {
    const config = options.config || loadConfig();
    const logger = options.logger || createLogger(config);
    const eventEngine = options.eventEngine || new EventEngine({ config, logger });
    const app = express();

    app.disable("x-powered-by");
    app.locals.config = config;
    app.locals.logger = logger;
    app.locals.eventEngine = eventEngine;

    app.use(cors({
        origin: config.corsOrigin,
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["content-type", "x-request-id"],
        exposedHeaders: ["x-request-id"]
    }));
    app.use(requestLogger(logger));
    app.use(express.json({ limit: config.requestBodyLimit }));

    app.use("/health", createHealthRouter({ config }));
    app.use("/api/feed-requests", createFeedRequestsRouter({ eventEngine }));
    app.use("/api/event-engine", createEventEngineRouter({ eventEngine, config }));

    app.use(notFoundHandler);
    app.use(createErrorHandler(logger));

    return app;
}
